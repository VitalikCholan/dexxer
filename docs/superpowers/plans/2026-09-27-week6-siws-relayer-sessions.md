# SIWS-сесії relayer-а (#27, частково) — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/sponsor` і `/nonce` relayer-а приймають запити лише з SIWS-сесією власника; app отримує сесію тим самим промптом Connect.

**Architecture:** relayer видає одноразовий nonce (`POST /auth/challenge`), перевіряє підписане SIWS-повідомлення (`POST /auth/siws`) і видає випадковий токен сесії (у Postgres — лише `sha256`). Middleware `requireSession` стоїть перед `/sponsor` (власник сесії == підписант tx) і `/nonce` (власник — із сесії). App підписує SIWS з nonce relayer-а на Connect і дотягує сесію `ensureRelayerSession` на початку онбордингу/депозиту.

**Tech Stack:** Express 5, `pg`, `tweetnacl`, `@solana/wallet-standard-util` 1.1.4, `node:test` (relayer); Expo/RN, `expo-secure-store`, MWA через `@wallet-ui/react-native-web3js` (app).

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.7

## Global Constraints

- Програму `dexxer_core` (`programs/`) не чіпати.
- `SIWS_DOMAIN` обов'язковий; без нього `/auth`, `/sponsor`, `/nonce` не монтуються (fail-closed).
- nonce: 16 випадкових байт hex, TTL 5 хв; `issuedAt` ±5 хв; сесія — 32 випадкові байти, TTL `AUTH_SESSION_TTL_HOURS` (default 168); у БД лише `sha256(token)`.
- `MAX_OPEN_CHALLENGES = 10_000` → 503.
- Гасіння nonce — лише після валідного підпису.
- `chainId` не перевіряється.
- Токени ніколи не логуються; логуються причина відмови й pubkey власника.
- `@solana/wallet-standard-util` 1.1.4 — явна залежність і relayer-а, і app.
- App: `domain`/`uri` у SIWS — `IDENTITY_DOMAIN`/`IDENTITY_URI`; сесія забезпечується **до першого промпту** флоу; на 401 — стерти токен, без авто-промпту.
- Коміти: Stop-хук `.claude/hooks/auto-commit.sh` комітить усе наприкінці кожного ходу — окремих `git commit` не робимо.
- Docs українською, код/коментарі англійською.

## Review Focus

1. Кошелек повертає `signature` як `message ‖ signature` (128+ байт) у `signIn` → app нормалізує `pickSignature` до 64 байт до обміну (Task 3, `auth-provider.tsx`).
2. Гаманець ігнорує переданий `nonce` у `signIn` → обмін падає 401, Connect не валиться, сесію потім дотягує `ensureRelayerSession` (Task 3, catch навколо `exchangeSiws`).
3. Два паралельні `/auth/siws` з тим самим nonce → рівно один 200 (атомарний `UPDATE … RETURNING`; тест replay у Task 1).
4. `Authorization` з довільним сміттям/регістром (`bearer x`, порожній) → 401, не 500 (Task 1, тести `requireSession`).
5. Старий клієнт без токена на `/nonce` → 401 і **жодного** `reserve`/`send` (Task 2, тест).

---

### Task 1: relayer — SIWS-перевірка, `AuthStore`, `/auth/*`, `requireSession`

**Files:**
- Create: `services/relayer/src/auth.ts`
- Create: `services/relayer/migrations/006_auth.sql`
- Create: `services/relayer/test/memAuthStore.ts` (спільний in-memory `AuthStore` для тестів; не `*.test.ts`, тож сам не запускається)
- Create: `services/relayer/test/auth.test.ts`
- Modify: `services/relayer/package.json` (+ `@solana/wallet-standard-util`)

**Interfaces:**
- Produces: `AuthStore`, `pgAuthStore(pool)`, `hashToken(token): string`, `verifySiws(input, domain, now): SiwsCheck`, `authRouter({ store, domain, sessionTtlMs, now? }): Router`, `requireSession(store, now?)` (ставить `res.locals.sessionOwner: PublicKey`), константи `CHALLENGE_TTL_MS`, `ISSUED_AT_SKEW_MS`, `MAX_OPEN_CHALLENGES`, `DEFAULT_SESSION_TTL_HOURS`, `SIWS_STATEMENT`; тест-хелпер `memAuthStore()`.

- [ ] **Step 1: залежність**

```bash
cd services/relayer && npm install @solana/wallet-standard-util@1.1.4
```

- [ ] **Step 2: міграція `006_auth.sql`**

```sql
-- services/relayer/migrations/006_auth.sql
--
-- Week 6 (spec §2.7, risk #27 partial): SIWS sign-in challenges and relayer
-- API sessions. `auth_challenges.nonce` is single-use (`used_at`); sessions
-- store only sha256(token), never the token itself. Expired rows are
-- garbage-collected inline by `pgAuthStore` (no background job).
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_challenges_expires_idx ON auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  owner text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);
```

- [ ] **Step 3: `test/memAuthStore.ts`**

```ts
// services/relayer/test/memAuthStore.ts
//
// In-memory `AuthStore` shared by auth/sponsor/nonce tests. JS's
// single-threaded event loop makes the synchronous check-and-set in
// `consumeChallenge` as atomic as pgAuthStore's `UPDATE … RETURNING`.
import { hashToken, type AuthStore } from "../src/auth.js";

export interface MemAuthStore extends AuthStore {
  challenges: Map<string, { expiresAt: number; used: boolean }>;
  sessions: Map<string, { owner: string; expiresAt: number }>;
  /** Test shortcut: mint a live session for `owner` without the SIWS round-trip. */
  sessionFor(owner: string, ttlMs?: number): string;
}

export function memAuthStore(): MemAuthStore {
  const challenges = new Map<string, { expiresAt: number; used: boolean }>();
  const sessions = new Map<string, { owner: string; expiresAt: number }>();
  const tokens = new Map<string, string>();
  return {
    challenges,
    sessions,
    async createChallenge(nonce, expiresAt) {
      challenges.set(nonce, { expiresAt, used: false });
    },
    async countOpenChallenges(now) {
      let n = 0;
      for (const c of challenges.values()) if (!c.used && c.expiresAt > now) n++;
      return n;
    },
    async consumeChallenge(nonce, now) {
      const c = challenges.get(nonce);
      if (!c || c.used || c.expiresAt <= now) return false;
      c.used = true;
      return true;
    },
    async createSession(tokenHash, owner, expiresAt) {
      sessions.set(tokenHash, { owner, expiresAt });
    },
    async getSession(tokenHash, now) {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > now ? s : null;
    },
    sessionFor(owner, ttlMs = 60 * 60 * 1000) {
      const existing = tokens.get(owner);
      if (existing) return existing;
      const token = `test-${owner}`;
      sessions.set(hashToken(token), { owner, expiresAt: Date.now() + ttlMs });
      tokens.set(owner, token);
      return token;
    },
  };
}
```

- [ ] **Step 4: падаючі тести `test/auth.test.ts`**

```ts
// services/relayer/test/auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createSignInMessage } from "@solana/wallet-standard-util";
import {
  CHALLENGE_TTL_MS,
  MAX_OPEN_CHALLENGES,
  SIWS_STATEMENT,
  authRouter,
  hashToken,
  requireSession,
  verifySiws,
  type AuthStore,
} from "../src/auth.js";
import { memAuthStore } from "./memAuthStore.js";

const DOMAIN = "relayer.example.test";
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const TTL_MS = 168 * 60 * 60 * 1000;

interface SiwsFields {
  domain?: string;
  address?: string;
  uri?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
}

function siwsMessage(kp: Keypair, f: SiwsFields = {}): Uint8Array {
  return createSignInMessage({
    domain: f.domain ?? DOMAIN,
    address: f.address ?? kp.publicKey.toBase58(),
    statement: SIWS_STATEMENT,
    uri: f.uri ?? `https://${DOMAIN}`,
    version: "1",
    nonce: f.nonce ?? "0123456789abcdef0123456789abcdef",
    issuedAt: f.issuedAt ?? new Date(NOW).toISOString(),
    ...(f.expirationTime ? { expirationTime: f.expirationTime } : {}),
    ...(f.notBefore ? { notBefore: f.notBefore } : {}),
  });
}

function signed(kp: Keypair, f: SiwsFields = {}, signer: Keypair = kp) {
  const signedMessage = siwsMessage(kp, f);
  return { address: kp.publicKey.toBase58(), signedMessage, signature: nacl.sign.detached(signedMessage, signer.secretKey) };
}

function asBody(s: { address: string; signedMessage: Uint8Array; signature: Uint8Array }) {
  return {
    address: s.address,
    signedMessage: Buffer.from(s.signedMessage).toString("base64"),
    signature: Buffer.from(s.signature).toString("base64"),
  };
}

// --- verifySiws (pure) ---

test("verifySiws: accepts a well-formed message signed by its address", () => {
  const kp = Keypair.generate();
  const r = verifySiws(signed(kp), DOMAIN, NOW);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.owner.equals(kp.publicKey));
    assert.equal(r.nonce, "0123456789abcdef0123456789abcdef");
  }
});

test("verifySiws: 400 when the bytes are not a SIWS message", () => {
  const kp = Keypair.generate();
  const msg = new TextEncoder().encode("hello");
  const r = verifySiws({ address: kp.publicKey.toBase58(), signedMessage: msg, signature: nacl.sign.detached(msg, kp.secretKey) }, DOMAIN, NOW);
  assert.deepEqual(r.ok ? null : [r.status, /Sign-In With Solana/.test(r.error)], [400, true]);
});

const REJECTIONS: [string, (kp: Keypair) => { address: string; signedMessage: Uint8Array; signature: Uint8Array }, RegExp][] = [
  ["another domain", (kp) => signed(kp, { domain: "evil.example" }), /domain/],
  ["a uri on another host", (kp) => signed(kp, { uri: "https://evil.example" }), /uri/],
  ["a message for a different address than body.address", (kp) => ({ ...signed(kp), address: Keypair.generate().publicKey.toBase58() }), /address/],
  ["issuedAt 6 minutes old", (kp) => signed(kp, { issuedAt: new Date(NOW - 6 * 60 * 1000).toISOString() }), /issuedAt/],
  ["an expirationTime in the past", (kp) => signed(kp, { expirationTime: new Date(NOW - 1000).toISOString() }), /expired/],
  ["a notBefore in the future", (kp) => signed(kp, { notBefore: new Date(NOW + 60_000).toISOString() }), /not yet valid/],
  ["a signature by another key", (kp) => signed(kp, {}, Keypair.generate()), /invalid signature/],
  [
    "a 128-byte message‖signature blob",
    (kp) => {
      const s = signed(kp);
      return { ...s, signature: Buffer.concat([Buffer.from(s.signedMessage.slice(0, 64)), Buffer.from(s.signature)]) };
    },
    /64 bytes/,
  ],
];
for (const [label, make, re] of REJECTIONS) {
  test(`verifySiws: 401 on ${label}`, () => {
    const r = verifySiws(make(Keypair.generate()), DOMAIN, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.match(r.error, re);
    }
  });
}

test("verifySiws: 401 when the message carries no nonce", () => {
  const kp = Keypair.generate();
  const msg = createSignInMessage({ domain: DOMAIN, address: kp.publicKey.toBase58(), uri: `https://${DOMAIN}`, version: "1", issuedAt: new Date(NOW).toISOString() });
  const r = verifySiws({ address: kp.publicKey.toBase58(), signedMessage: msg, signature: nacl.sign.detached(msg, kp.secretKey) }, DOMAIN, NOW);
  assert.equal(r.ok ? 0 : r.status, 401);
});

// --- router ---

async function withAuthServer(store: AuthStore, now: () => number, fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(authRouter({ store, domain: DOMAIN, sessionTtlMs: TTL_MS, now }));
  app.get("/whoami", requireSession(store, now), (_req, res) => {
    res.json({ owner: res.locals.sessionOwner.toBase58() });
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function challenge(url: string) {
  const res = await fetch(`${url}/auth/challenge`, { method: "POST" });
  assert.equal(res.status, 200);
  return (await res.json()) as { nonce: string; issuedAt: string; expirationTime: string; domain: string; uri: string; statement: string; version: string };
}

function postSiws(url: string, body: unknown) {
  return fetch(`${url}/auth/siws`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("POST /auth/challenge → /auth/siws issues a session; only sha256(token) is stored", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const c = await challenge(url);
    assert.match(c.nonce, /^[0-9a-f]{32}$/);
    assert.equal(c.domain, DOMAIN);
    assert.equal(c.uri, `https://${DOMAIN}`);
    assert.equal(Date.parse(c.expirationTime) - Date.parse(c.issuedAt), CHALLENGE_TTL_MS);
    const res = await postSiws(url, asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt, expirationTime: c.expirationTime })));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; owner: string; expiresAt: number };
    assert.equal(body.owner, kp.publicKey.toBase58());
    assert.equal(body.expiresAt, NOW + TTL_MS);
    assert.ok(store.sessions.has(hashToken(body.token)));
    assert.ok(![...store.sessions.keys()].includes(body.token));
    const who = await fetch(`${url}/whoami`, { headers: { authorization: `Bearer ${body.token}` } });
    assert.deepEqual(await who.json(), { owner: kp.publicKey.toBase58() });
  });
});

test("POST /auth/siws: replaying the same signed message is rejected (single-use nonce)", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const c = await challenge(url);
    const body = asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt }));
    const [a, b] = await Promise.all([postSiws(url, body), postSiws(url, body)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 401]);
  });
});

test("POST /auth/siws: a bad signature does not burn the nonce", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const c = await challenge(url);
    const bad = await postSiws(url, asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt }, Keypair.generate())));
    assert.equal(bad.status, 401);
    const good = await postSiws(url, asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt })));
    assert.equal(good.status, 200);
  });
});

test("POST /auth/siws: 401 on a nonce the relayer never issued, and on an expired challenge", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const unknown = await postSiws(url, asBody(signed(kp, { nonce: "ffffffffffffffffffffffffffffffff" })));
    assert.equal(unknown.status, 401);
    assert.match(((await unknown.json()) as { error: string }).error, /nonce/);
    await store.createChallenge("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", NOW - 1);
    const expired = await postSiws(url, asBody(signed(kp, { nonce: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })));
    assert.equal(expired.status, 401);
  });
});

test("POST /auth/siws: 400 when body fields are missing", async () => {
  await withAuthServer(memAuthStore(), () => NOW, async (url) => {
    const res = await postSiws(url, { address: "x" });
    assert.equal(res.status, 400);
  });
});

test("POST /auth/challenge: 503 once MAX_OPEN_CHALLENGES are outstanding", async () => {
  const store = memAuthStore();
  store.countOpenChallenges = async () => MAX_OPEN_CHALLENGES;
  await withAuthServer(store, () => NOW, async (url) => {
    const res = await fetch(`${url}/auth/challenge`, { method: "POST" });
    assert.equal(res.status, 503);
    assert.equal(store.challenges.size, 0);
  });
});

test("requireSession: 401 on no header, a malformed header, an unknown token and an expired session", async () => {
  const store = memAuthStore();
  const owner = Keypair.generate().publicKey.toBase58();
  await store.createSession(hashToken("expired-token"), owner, NOW - 1);
  await withAuthServer(store, () => NOW, async (url) => {
    for (const authorization of [undefined, "bearer abc", "Bearer ", "Basic abc", "Bearer unknown-token", "Bearer expired-token"]) {
      const res = await fetch(`${url}/whoami`, { headers: authorization ? { authorization } : {} });
      assert.equal(res.status, 401, `authorization=${authorization}`);
    }
  });
});
```

- [ ] **Step 5: переконатися, що тести падають**

Run: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../app/src/idl node --import tsx --test test/auth.test.ts`
Expected: FAIL — `Cannot find module '../src/auth.js'`.

- [ ] **Step 6: реалізація `src/auth.ts`**

```ts
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
```

- [ ] **Step 7: тести проходять + typecheck**

Run: `cd services/relayer && npx tsc --noEmit && DEXXER_IDL_DIR=$PWD/../../app/src/idl node --import tsx --test test/auth.test.ts`
Expected: tsc без помилок; усі тести `auth.test.ts` PASS.

### Task 2: relayer — гейт `/sponsor` і `/nonce`, монтування в `index.ts`

**Files:**
- Modify: `services/relayer/src/sponsor.ts` (`SponsorDeps.authStore`, `sponsorRouter`)
- Modify: `services/relayer/src/nonce.ts` (`NonceRouterDeps.authStore`, `nonceRouter`)
- Modify: `services/relayer/src/index.ts` (env, монтування, fail-closed)
- Test: `services/relayer/test/sponsor.test.ts`, `services/relayer/test/nonce.test.ts`

**Interfaces:**
- Consumes: `AuthStore`, `requireSession`, `pgAuthStore`, `authRouter`, `DEFAULT_SESSION_TTL_HOURS` (Task 1); `memAuthStore().sessionFor(owner)` (Task 1).
- Produces: `SponsorDeps.authStore: AuthStore` (обов'язковий), `NonceRouterDeps.authStore: AuthStore` (обов'язковий); env `SIWS_DOMAIN`, `AUTH_SESSION_TTL_HOURS`.

- [ ] **Step 1: падаючі тести — `sponsor.test.ts`**

Імпорти: `import { memAuthStore } from "./memAuthStore.js";`. Модульний `const AUTH = memAuthStore();`. `withServer` передає `authStore: AUTH` у `sponsorRouter`. `send` сам підставляє сесію власника tx:

```ts
function ownerOf(tx: Transaction): PublicKey | null {
  return tx.signatures.find((s) => !tx.feePayer || !s.publicKey.equals(tx.feePayer))?.publicKey ?? null;
}

async function send(url: string, tx: Transaction, token: string | null = null): Promise<Response> {
  const owner = ownerOf(tx);
  const bearer = token ?? (owner ? AUTH.sessionFor(owner.toBase58()) : AUTH.sessionFor(Keypair.generate().publicKey.toBase58()));
  return fetch(`${url}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
  });
}
```

Тест «400 on missing body» — додати `authorization: \`Bearer ${AUTH.sessionFor(Keypair.generate().publicKey.toBase58())}\`` у заголовки. Нові тести в кінці файлу:

```ts
test("POST /sponsor: 401 without a relayer session — no slot is reserved", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  let reserved = 0;
  const store = fakeStore({
    reserve: async (o, ts) => {
      reserved++;
      return { owner: o, ts, window: 0, slot: 0 };
    },
  });
  await withServer(feePayer, store, async (url) => {
    const tx = await buildInitUserTx(owner, feePayer.publicKey);
    const res = await fetch(`${url}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
    });
    assert.equal(res.status, 401);
    assert.equal(reserved, 0);
  });
});

test("POST /sponsor: 403 when the session belongs to someone other than the tx signer — no slot is reserved", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  let reserved = 0;
  const store = fakeStore({
    reserve: async (o, ts) => {
      reserved++;
      return { owner: o, ts, window: 0, slot: 0 };
    },
  });
  await withServer(feePayer, store, async (url) => {
    const tx = await buildInitUserTx(owner, feePayer.publicKey);
    const res = await send(url, tx, AUTH.sessionFor(Keypair.generate().publicKey.toBase58()));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /session owner/);
    assert.equal(reserved, 0);
  });
});
```

- [ ] **Step 2: падаючі тести — `nonce.test.ts`**

Імпорт `memAuthStore`; модульний `const AUTH = memAuthStore();`; кожен `nonceRouter({ … })` отримує `authStore: AUTH`; хелпер:

```ts
function postNonce(url: string, owner: PublicKey | null, body: unknown): Promise<Response> {
  return fetch(`${url}/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(owner ? { authorization: `Bearer ${AUTH.sessionFor(owner.toBase58())}` } : {}) },
    body: JSON.stringify(body),
  });
}
```

Наявні `fetch(\`${url}/nonce\`, …)` замінити на `postNonce(url, owner.publicKey, { owner: … })`; у тесті «400 on a bad owner» — `postNonce(url, owner.publicKey, { owner: "nope" })` (сесія є, `body.owner` невалідний → 400). Нові тести:

```ts
test("POST /nonce: 401 without a relayer session — nothing reserved, nothing sent", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const conn = fakeConn(new Set(), owner.publicKey);
  const store = fakeStore();
  await withServer(nonceRouter({ conn, feePayer, store, dailyBudgetLamports: 500_000_000, authStore: AUTH }), async (url) => {
    const res = await postNonce(url, null, { owner: owner.publicKey.toBase58() });
    assert.equal(res.status, 401);
    assert.equal(store.reserved, 0);
    assert.equal(conn.sent.length, 0);
  });
});

test("POST /nonce: owner comes from the session; a different body.owner is 403", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const conn = fakeConn(new Set(), owner.publicKey);
  const store = fakeStore();
  await withServer(nonceRouter({ conn, feePayer, store, dailyBudgetLamports: 500_000_000, authStore: AUTH }), async (url) => {
    const foreign = await postNonce(url, owner.publicKey, { owner: Keypair.generate().publicKey.toBase58() });
    assert.equal(foreign.status, 403);
    assert.equal(conn.sent.length, 0);
    const implicit = await postNonce(url, owner.publicKey, {});
    assert.equal(implicit.status, 200);
    const b = (await implicit.json()) as { owner: string; created: boolean };
    assert.equal(b.owner, owner.publicKey.toBase58());
    assert.equal(b.created, true);
  });
});
```

- [ ] **Step 3: переконатися, що падають**

Run: `cd services/relayer && npx tsc --noEmit`
Expected: FAIL — `authStore` не існує в `SponsorDeps`/`NonceRouterDeps`.

- [ ] **Step 4: `sponsor.ts`**

```ts
import { requireSession, type AuthStore } from "./auth.js";
```

У `SponsorDeps`:

```ts
  /** Relayer session store (auth.ts) — `/sponsor` answers 401 without a live session and 403 when its owner is not the tx signer. */
  authStore: AuthStore;
```

У `sponsorRouter` — маршрут і перевірка власника одразу після `checkWhitelist`:

```ts
  router.post("/sponsor", requireSession(deps.authStore, now), express.json(), async (req, res) => {
```

```ts
    const sessionOwner = res.locals.sessionOwner as PublicKey;
    if (!check.owner.equals(sessionOwner)) {
      res.status(403).json({ error: `session owner ${sessionOwner.toBase58()} does not match the transaction's signer ${check.owner.toBase58()}` });
      return;
    }
```

Шапку файлу доповнити абзацом: «Week 6 (spec §2.7): gated on a relayer SIWS session (`auth.ts`) — no session → 401 before any parsing or slot reservation; the session owner must be the tx's owner signer (403 otherwise).»

- [ ] **Step 5: `nonce.ts`**

```ts
import { requireSession, type AuthStore } from "./auth.js";
```

У `NonceRouterDeps`: `authStore: AuthStore;` (з doc-коментарем «owner comes from the relayer session (spec §2.7)»). Початок хендлера замінити:

```ts
  router.post("/nonce", requireSession(deps.authStore, now), express.json({ limit: "4kb" }), async (req, res) => {
    const owner = res.locals.sessionOwner as PublicKey;
    const rawOwner = (req.body as { owner?: unknown } | undefined)?.owner;
    if (rawOwner !== undefined) {
      let bodyOwner: PublicKey;
      try {
        bodyOwner = new PublicKey(String(rawOwner));
      } catch {
        res.status(400).json({ error: "body.owner must be a base58 public key" });
        return;
      }
      if (!bodyOwner.equals(owner)) {
        res.status(403).json({ error: "body.owner does not match the relayer session owner" });
        return;
      }
    }
```

Шапку файлу: «Week 6 (spec §2.7): the owner is the relayer SIWS session's owner — `body.owner` is optional and must match it; an unauthenticated POST no longer spends SOL.»

- [ ] **Step 6: `index.ts`**

Імпорти:

```ts
import { DEFAULT_SESSION_TTL_HOURS, authRouter, pgAuthStore } from "./auth.js";
```

Після `sponsorMaxCuPriceMicroLamports`:

```ts
// Week 6 (spec §2.7): SIWS sessions gate /sponsor and /nonce. SIWS_DOMAIN is
// the app's MWA identity domain (IDENTITY_DOMAIN — today the relayer's own
// host); without it the gate cannot verify anything, so the write endpoints
// stay unmounted (fail-closed) rather than silently open.
const siwsDomain = process.env.SIWS_DOMAIN?.trim() || null;
const authSessionTtlHours = Number(process.env.AUTH_SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
const authSessionTtlMs = (Number.isFinite(authSessionTtlHours) && authSessionTtlHours > 0 ? authSessionTtlHours : DEFAULT_SESSION_TTL_HOURS) * 60 * 60 * 1000;
```

Блок sponsor: нова гілка між «no DATABASE_URL» і робочою:

```ts
} else if (cfg.sponsorEnabled && pool && !siwsDomain) {
  console.error("sponsor: SPONSOR_ENABLED=true but SIWS_DOMAIN is not set — /auth, /sponsor and /nonce NOT mounted (fail-closed, spec §2.7)");
} else if (cfg.sponsorEnabled && pool && siwsDomain) {
  const store = pgSponsorStore(pool);
  const authStore = pgAuthStore(pool);
  app.use(authRouter({ store: authStore, domain: siwsDomain, sessionTtlMs: authSessionTtlMs }));
```

і `authStore` у `sponsorRouter({ … })` та `nonceRouter({ … })`; у лог `sponsor: /sponsor enabled (…)` додати `, SIWS domain ${siwsDomain}, session TTL ${authSessionTtlMs / 3_600_000} h`.

- [ ] **Step 7: усі тести relayer-а + typecheck**

Run: `cd services/relayer && npx tsc --noEmit && DEXXER_IDL_DIR=$PWD/../../app/src/idl npm test`
Expected: tsc чисто; усі тести PASS (auth + sponsor + nonce + решта). Якщо `sponsor.test.ts` не вантажиться через `import { BN } from "@coral-xyz/anchor"` на локальному Node — прогнати на Node з `.nvmrc` (як CI) і зафіксувати результат.

### Task 3: app — `relayerAuth.ts`, Bearer у клієнтах, Connect, точки входу

**Files:**
- Create: `app/src/lib/relayerAuth.ts`
- Modify: `app/package.json` (+ `@solana/wallet-standard-util` 1.1.4)
- Modify: `app/src/lib/sponsor.ts` (`sponsorTx(tx, owner)`)
- Modify: `app/src/lib/nonce.ts` (`fetchNonces` з Bearer)
- Modify: `app/components/auth/auth-provider.tsx` (челендж → `signIn` → `exchangeSiws`)
- Modify: `app/src/features/onboard/batchOnboarding.ts` (`Mwa.ensureRelayerSession`, виклик на початку `runBatchedOnboarding`, `sponsorTx(…, owner)`)
- Modify: `app/src/features/onboard/useOnboarding.ts`, `app/src/features/account/AccountScreen.tsx`, `app/src/features/account/accountTx.ts`

**Interfaces:**
- Consumes: `POST /auth/challenge`, `POST /auth/siws`, 401 від `/sponsor`/`/nonce` (Tasks 1–2).
- Produces: `fetchChallenge()`, `siwsPayload(challenge)`, `exchangeSiws(owner, signedMessage, signature)`, `ensureRelayerSession(owner, signMessage)`, `useRelayerSession()`, `relayerAuthHeaders(owner)`, `clearRelayerToken(owner)`; `Mwa.ensureRelayerSession: (owner: PublicKey) => Promise<void>`.

- [ ] **Step 1: залежність**

```bash
cd app && npm install @solana/wallet-standard-util@1.1.4
```

- [ ] **Step 2: `app/src/lib/relayerAuth.ts`**

```ts
// app/src/lib/relayerAuth.ts
//
// Relayer API session (spec §2.7): the relayer's write endpoints (`/sponsor`,
// `/nonce`) need a Bearer token it issues for a Sign-In With Solana message
// carrying its own single-use nonce. Connect (`auth-provider.tsx`) gets one
// for free from the SIWS prompt it already shows; flows that talk to the
// relayer call `ensureRelayerSession` BEFORE their first wallet prompt —
// `signOwnerL1` silently falls back to a live blockhash when `/nonce` fails,
// which on Phantom means "confirm timeout" (Alpenglow), so a late 401 must
// never be what discovers a missing session.
//
// The token opens only the relayer's API — it is not a TEE token and never
// leaves this app except in that header. Stored per owner in SecureStore.
import { PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import { createSignInMessage } from '@solana/wallet-standard-util'
import { useCallback } from 'react'
import { IDENTITY_DOMAIN, IDENTITY_URI, RELAYER_URL } from './solana'
import { useMwaSigning } from './mwaAuth'
import { pickSignature } from '../spikes/mwa'

/** Renew this long before the relayer's `expiresAt`, so a flow never starts on a token about to lapse. */
const REFRESH_SKEW_MS = 5 * 60 * 1000

export interface SiwsChallenge {
  nonce: string
  issuedAt: string
  expirationTime: string
  domain: string
  uri: string
  statement: string
  version: string
}

interface StoredSession {
  token: string
  expiresAt: number
}

export class RelayerAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RelayerAuthError'
  }
}

function storageKey(owner: PublicKey): string {
  return `dexxer.relayer.${owner.toBase58()}`
}

async function getRelayerToken(owner: PublicKey): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(storageKey(owner))
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as StoredSession
    return s.expiresAt - REFRESH_SKEW_MS > Date.now() ? s.token : null
  } catch {
    return null
  }
}

export async function clearRelayerToken(owner: PublicKey): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(owner))
}

/** `Authorization` header for the relayer's write endpoints — empty when there is no live session (the relayer then answers 401). */
export async function relayerAuthHeaders(owner: PublicKey): Promise<Record<string, string>> {
  const token = await getRelayerToken(owner)
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${RELAYER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new RelayerAuthError(`could not reach relayer: ${e instanceof Error ? e.message : String(e)}`, 0)
  }
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new RelayerAuthError(payload.error ?? `${path} returned ${res.status}`, res.status)
  return payload
}

export async function fetchChallenge(): Promise<SiwsChallenge> {
  return postJson<SiwsChallenge>('/auth/challenge', {})
}

/**
 * The SIWS fields to sign: `domain`/`uri` are the app's own MWA identity
 * (what the wallet checks the request against); nonce/timestamps/statement
 * come from the relayer's challenge.
 */
export function siwsPayload(challenge: SiwsChallenge) {
  if (__DEV__ && challenge.domain !== IDENTITY_DOMAIN) {
    console.warn(`[dexxer] relayer SIWS_DOMAIN ${challenge.domain} ≠ app IDENTITY_DOMAIN ${IDENTITY_DOMAIN} — the relayer will reject this sign-in`)
  }
  return {
    domain: IDENTITY_DOMAIN,
    uri: IDENTITY_URI,
    statement: challenge.statement,
    version: challenge.version,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expirationTime: challenge.expirationTime,
  }
}

/** Trades a signed SIWS message for a relayer session and stores it. `signature` must be the bare 64-byte ed25519 signature. */
export async function exchangeSiws(owner: PublicKey, signedMessage: Uint8Array, signature: Uint8Array): Promise<void> {
  const out = await postJson<{ token: string; expiresAt: number }>('/auth/siws', {
    address: owner.toBase58(),
    signedMessage: Buffer.from(signedMessage).toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
  })
  const stored: StoredSession = { token: out.token, expiresAt: out.expiresAt }
  await SecureStore.setItemAsync(storageKey(owner), JSON.stringify(stored))
}

/** No-op with a live token; otherwise one `signMessage` prompt over a relayer-nonced SIWS message. */
export async function ensureRelayerSession(owner: PublicKey, signMessage: (message: Uint8Array) => Promise<Uint8Array>): Promise<void> {
  if (await getRelayerToken(owner)) return
  const challenge = await fetchChallenge()
  const message = createSignInMessage({ ...siwsPayload(challenge), address: owner.toBase58() })
  await exchangeSiws(owner, message, await signMessage(message))
}

/** Hook form: signs with `useMwaSigning()`'s retry-wrapped `signMessages`, normalized by `pickSignature` (same as `er.ts`). */
export function useRelayerSession() {
  const { signMessages } = useMwaSigning()
  const ensure = useCallback(
    (owner: PublicKey) => ensureRelayerSession(owner, async (message) => pickSignature(message, await signMessages(message), owner)),
    [signMessages],
  )
  return { ensureRelayerSession: ensure }
}
```

- [ ] **Step 3: `sponsor.ts` / `nonce.ts` (app)**

`sponsorTx(tx: Transaction, owner: PublicKey)`: у `fetch` — `headers: { 'content-type': 'application/json', ...(await relayerAuthHeaders(owner)) }`; перед `if (!res.ok)` — `if (res.status === 401) await clearRelayerToken(owner)`. У `fetchNonces` — те саме (заголовки + `clearRelayerToken` на 401). Шапки: одне речення про Bearer-сесію (spec §2.7).

- [ ] **Step 4: Connect — `auth-provider.tsx`**

```ts
    mutationFn: async () => {
      // spec §2.7: a relayer nonce in the SAME SIWS prompt yields a relayer
      // session for free. Relayer unreachable → plain SIWS as before; flows
      // fetch the session later via `ensureRelayerSession`.
      const challenge = await fetchChallenge().catch((e) => {
        if (__DEV__) console.log(`[dexxer] relayer challenge unavailable — ${String(e)}`)
        return null
      })
      const payload = challenge ? siwsPayload(challenge) : { uri: AppConfig.uri, domain: IDENTITY_DOMAIN }
      const out = await ensureAuthorized(identity, () => signIn(payload), store)
      if (challenge) {
        const owner = toPublicKey(out.account.address)
        try {
          await exchangeSiws(owner, out.signedMessage, pickSignature(out.signedMessage, out.signature, owner))
        } catch (e) {
          if (__DEV__) console.log(`[dexxer] relayer session not issued at Connect — ${String(e)}`)
        }
      }
      return out
    },
```

Імпорти: `fetchChallenge, exchangeSiws, siwsPayload` з `@/src/lib/relayerAuth`; `pickSignature, toPublicKey` з `@/src/spikes/mwa`.

- [ ] **Step 5: точки входу**

`batchOnboarding.ts`: у `interface Mwa` — `/** Relayer session before any relayer call (spec §2.7) — see relayerAuth.ts. */ ensureRelayerSession: (owner: PublicKey) => Promise<void>`; першим рядком `runBatchedOnboarding` (до `onProgress`) — `await mwa.ensureRelayerSession(ctx.owner)`; `sponsorTx(signed)` → `sponsorTx(signed, owner)`, `sponsorTx(toSend)` → `sponsorTx(toSend, ctx.owner)`.
`useOnboarding.ts`: `const { ensureRelayerSession } = useRelayerSession()`; `const mwa: Mwa = { signAndSendTransaction, signTransactions, getConnection, ensureRelayerSession }`; `ensureRelayerSession` у масиви залежностей `advance` і `runDeposit`.
`AccountScreen.tsx`: `const { ensureRelayerSession } = useRelayerSession()`; `useMemo(() => ({ signTransactions, getConnection, ensureRelayerSession }), [signTransactions, getConnection, ensureRelayerSession])`.
`accountTx.ts`: `depositTx(p, mwa: Pick<Mwa, 'signTransactions' | 'getConnection' | 'ensureRelayerSession'>, …)`, першим рядком — `await mwa.ensureRelayerSession(p.owner)`.

- [ ] **Step 6: typecheck + lint (як CI)**

Run: `cd app && npx tsc --noEmit && npm run lint:check`
Expected: без помилок.

### Task 4: документи

**Files:**
- Modify: `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.7 «Реалізовано», §7.1 #27)
- Modify: `CLAUDE.md` (правило приватності, «Правила тижня 6», лічильник тестів relayer-а)
- Modify: `docs/deployments.md` (env `SIWS_DOMAIN`, `AUTH_SESSION_TTL_HOURS`, порядок розкатки)

- [ ] **Step 1:** §7.1 #27 — у колонці мітигації: «**частково (week 6, §2.7):** `/sponsor`/`/nonce` лише за SIWS-сесією власника; `/nonce` більше не анонімний; Sybil свіжими ключами — відкритий (потрібен дефіцитний ресурс)»; статус — «частково мітиговано, тиждень 6».
- [ ] **Step 2:** §2.7 — абзац «**Реалізовано.**» з фактичними цифрами тестів і відхиленнями, якщо були.
- [ ] **Step 3:** CLAUDE.md — до правила «жоден сервіс, крім crank-а, не тримає owner/session-токенів» додати «(SIWS-сесії API relayer-а — не owner/TEE-токени: відкривають лише `/sponsor`/`/nonce`, у БД лише `sha256`, spec §2.7)»; новий розділ «Правила тижня 6» з пунктом про гейт, env і розкатку; оновити число тестів relayer-а.
- [ ] **Step 4:** `docs/deployments.md` — рядки env і порядок: `SIWS_DOMAIN` → деплой → новий APK.

### Task 5: живий прогін (наскільки дозволяє середовище)

- [ ] **Step 1:** якщо локально є Postgres (або Docker) — підняти relayer з `SPONSOR_ENABLED=true`, `SIWS_DOMAIN=localhost:8080`, `DATABASE_URL=…`; перевірити міграцію `006_auth.sql`, цикл `challenge → siws` скриптом із тестовим ключем, `/nonce` без токена → 401, з токеном → 200 (pgAuthStore у справжньому Postgres).
- [ ] **Step 2:** якщо емулятор/збірка dev-client доступні — fakewallet: Connect → онбординг → депозит, у логах relayer-а жодного 401 (`docs/emulator-runbook.md`).
- [ ] **Step 3:** що не вдалося прогнати — чесно зафіксувати в §2.7 «Реалізовано» і в звіті; Phantom-чекліст — користувачу.
