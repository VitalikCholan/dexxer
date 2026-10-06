// services/relayer/src/auth.ts
//
// Relayer API sessions via Sign-In With Solana (spec §2.7, risk #27 partial).
//
// POST /auth/challenge hands out a single-use nonce; the app signs a SIWS
// message carrying it (the same wallet prompt as Connect); POST /auth/siws
// verifies it and issues a random bearer token. `requireSession` gates the
// relayer's write endpoints (`/sponsor`, `/nonce`) on that token.
//
// What this does NOT do: stop Sybil drain of the sponsor budget. SIWS proves
// control of a key and fresh keys are free — closing #27 fully needs a
// scarce per-person resource (invite code, Seeker Genesis Token, IP limit).
//
// Privacy: the session opens only this relayer's own API. It is not an
// owner TEE token (the SIWS message is bound to the app's identity domain,
// a different format from the TEE auth challenge) and is never forwarded.
// Only sha256(token) is stored; tokens are never logged.
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { parseSignInMessage } from "@solana/wallet-standard-util";
import type { DbPool } from "./db.js";
import { NOT_ON_BETA_LIST } from "./betaAccess.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const ISSUED_AT_SKEW_MS = 5 * 60 * 1000;
/** Guard on the one unauthenticated DB write: past this many live challenges, /auth/challenge answers 503. */
export const MAX_OPEN_CHALLENGES = 10_000;
export const DEFAULT_SESSION_TTL_HOURS = 168;
export const SIWS_STATEMENT = "Sign in to the Dexxer relayer";

export interface AuthStore {
  createChallenge(nonce: string, expiresAt: number): Promise<void>;
  countOpenChallenges(now: number): Promise<number>;
  /** Atomically marks `nonce` used iff it exists, is unused and unexpired at `now`. */
  consumeChallenge(nonce: string, now: number): Promise<boolean>;
  createSession(tokenHash: string, owner: string, expiresAt: number): Promise<void>;
  getSession(tokenHash: string, now: number): Promise<{ owner: string; expiresAt: number } | null>;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type SiwsCheck = { ok: true; owner: PublicKey; nonce: string } | { ok: false; status: 400 | 401; error: string };

function reject(status: 400 | 401, error: string): SiwsCheck {
  return { ok: false, status, error };
}

/** Everything about a SIWS sign-in except the nonce's single-use check, which needs the store (see authRouter). */
export function verifySiws(
  input: { address: string; signedMessage: Uint8Array; signature: Uint8Array },
  domain: string,
  now: number,
): SiwsCheck {
  const fields = parseSignInMessage(input.signedMessage);
  if (!fields) return reject(400, "signedMessage is not a Sign-In With Solana message");
  if (fields.domain !== domain) return reject(401, `domain mismatch: message is for ${fields.domain}, expected ${domain}`);
  let uriHost: string;
  try {
    uriHost = new URL(fields.uri ?? "").host;
  } catch {
    return reject(401, "uri is missing or not a URL");
  }
  if (uriHost !== domain) return reject(401, `uri host mismatch: ${uriHost}, expected ${domain}`);
  if (fields.address !== input.address) return reject(401, "address mismatch between the message and body.address");
  let owner: PublicKey;
  try {
    owner = new PublicKey(input.address);
  } catch {
    return reject(400, "address is not a base58 public key");
  }
  if (!fields.nonce) return reject(401, "nonce missing from the message");
  const issuedAt = Date.parse(fields.issuedAt ?? "");
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > ISSUED_AT_SKEW_MS) {
    return reject(401, "issuedAt is missing or more than 5 min from server time");
  }
  if (fields.expirationTime !== undefined) {
    const exp = Date.parse(fields.expirationTime);
    if (!Number.isFinite(exp) || exp <= now) return reject(401, "message expired");
  }
  if (fields.notBefore !== undefined) {
    const nb = Date.parse(fields.notBefore);
    if (!Number.isFinite(nb) || nb > now) return reject(401, "message not yet valid (notBefore)");
  }
  if (input.signature.length !== 64) return reject(401, `signature must be 64 bytes, got ${input.signature.length}`);
  if (!nacl.sign.detached.verify(input.signedMessage, input.signature, owner.toBytes())) return reject(401, "invalid signature");
  return { ok: true, owner, nonce: fields.nonce };
}

export interface AuthDeps {
  store: AuthStore;
  /** `SIWS_DOMAIN` — the app's MWA identity domain. */
  domain: string;
  sessionTtlMs: number;
  now?: () => number;
  /** `BETA_ALLOWLIST` (betaAccess.ts): when set, only these wallets get a session (403 otherwise). */
  allowlist?: Set<string> | null;
}

export function authRouter(deps: AuthDeps): Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;

  router.post("/auth/challenge", async (_req, res) => {
    const t = now();
    if ((await deps.store.countOpenChallenges(t)) >= MAX_OPEN_CHALLENGES) {
      res.status(503).json({ error: "too many open sign-in challenges, retry shortly" });
      return;
    }
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = t + CHALLENGE_TTL_MS;
    await deps.store.createChallenge(nonce, expiresAt);
    res.json({
      nonce,
      issuedAt: new Date(t).toISOString(),
      expirationTime: new Date(expiresAt).toISOString(),
      domain: deps.domain,
      uri: `https://${deps.domain}`,
      statement: SIWS_STATEMENT,
      version: "1",
    });
  });

  router.post("/auth/siws", express.json({ limit: "8kb" }), async (req, res) => {
    const body = req.body as { address?: unknown; signedMessage?: unknown; signature?: unknown } | undefined;
    if (!body || typeof body.address !== "string" || typeof body.signedMessage !== "string" || typeof body.signature !== "string") {
      res.status(400).json({ error: "body.address, body.signedMessage and body.signature (base64) are required" });
      return;
    }
    const t = now();
    const check = verifySiws(
      { address: body.address, signedMessage: Buffer.from(body.signedMessage, "base64"), signature: Buffer.from(body.signature, "base64") },
      deps.domain,
      t,
    );
    if (!check.ok) {
      console.log(`auth: sign-in rejected for ${body.address}: ${check.error}`);
      res.status(check.status).json({ error: check.error });
      return;
    }
    // Closed beta: checked after the signature, so the answer says nothing
    // about a wallet whose key the caller does not hold.
    if (deps.allowlist && !deps.allowlist.has(check.owner.toBase58())) {
      console.log(`auth: sign-in refused for ${body.address}: not on the beta allowlist`);
      res.status(403).json({ error: NOT_ON_BETA_LIST });
      return;
    }
    // Only after the signature checks out — garbage must not be able to burn someone else's nonce.
    if (!(await deps.store.consumeChallenge(check.nonce, t))) {
      console.log(`auth: sign-in rejected for ${body.address}: unknown, used or expired nonce`);
      res.status(401).json({ error: "unknown, already used or expired nonce — request a new challenge" });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const owner = check.owner.toBase58();
    const expiresAt = t + deps.sessionTtlMs;
    await deps.store.createSession(hashToken(token), owner, expiresAt);
    console.log(`auth: session issued for ${owner}`);
    res.json({ token, owner, expiresAt });
  });

  return router;
}

/** Gates a route on a live relayer session; sets `res.locals.sessionOwner` (PublicKey). */
export function requireSession(store: AuthStore, now: () => number = Date.now) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get("authorization") ?? "");
    const session = m ? await store.getSession(hashToken(m[1]), now()) : null;
    if (!session) {
      res.status(401).json({ error: "relayer session required: missing, invalid or expired token — sign in again" });
      return;
    }
    res.locals.sessionOwner = new PublicKey(session.owner);
    next();
  };
}

export function pgAuthStore(pool: DbPool): AuthStore {
  return {
    async createChallenge(nonce, expiresAt) {
      await pool.query("DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 hour'");
      await pool.query("INSERT INTO auth_challenges (nonce, expires_at) VALUES ($1, to_timestamp($2::double precision / 1000))", [nonce, expiresAt]);
    },
    async countOpenChallenges(now) {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM auth_challenges WHERE used_at IS NULL AND expires_at > to_timestamp($1::double precision / 1000)",
        [now],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async consumeChallenge(nonce, now) {
      const { rows } = await pool.query(
        "UPDATE auth_challenges SET used_at = to_timestamp($2::double precision / 1000) WHERE nonce = $1 AND used_at IS NULL AND expires_at > to_timestamp($2::double precision / 1000) RETURNING nonce",
        [nonce, now],
      );
      return rows.length > 0;
    },
    async createSession(tokenHash, owner, expiresAt) {
      await pool.query("DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 hour'");
      await pool.query("INSERT INTO auth_sessions (token_hash, owner, expires_at) VALUES ($1, $2, to_timestamp($3::double precision / 1000))", [
        tokenHash,
        owner,
        expiresAt,
      ]);
    },
    async getSession(tokenHash, now) {
      const { rows } = await pool.query<{ owner: string; expires_ms: string }>(
        "SELECT owner, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms FROM auth_sessions WHERE token_hash = $1 AND expires_at > to_timestamp($2::double precision / 1000)",
        [tokenHash, now],
      );
      return rows[0] ? { owner: rows[0].owner, expiresAt: Number(rows[0].expires_ms) } : null;
    },
  };
}
