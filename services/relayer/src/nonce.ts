// services/relayer/src/nonce.ts
//
// POST /nonce — the relayer creates (once, idempotently) two durable-nonce
// accounts for an owner and returns their addresses + current nonce values.
//
// Why the relayer and not the owner's wallet (24.09.2026, live Phantom):
// Alpenglow devnet blockhashes live ~25 s; a Phantom prompt takes ~38 s
// (its fee estimation backs off on 429s from api.devnet.solana.com before the
// user can even confirm), so the owner cannot land ANY plain-blockhash tx —
// including the one that would create their nonce accounts. The relayer
// signs instantly, so it creates them; the nonce AUTHORITY is still the
// owner (only the owner can advance/use them), the relayer merely fronts
// the rent (~0.00145 SOL each). Every owner L1 tx then rides on a nonce and
// can wait for the wallet indefinitely (`app/src/lib/nonce.ts`).
//
// Addresses are deterministic — `createWithSeed(fee_payer, "dn<slot>-" +
// base58(owner)[0:28], System)` (seed ≤ 32 bytes) — so `sponsor.ts` can
// verify a tx's `AdvanceNonceAccount` targets one of the owner's two
// accounts without a database. Creation goes through the same per-owner
// rate limit as `/sponsor` (`SponsorStore.reserve`) and counts against the
// daily budget; an owner whose accounts already exist costs nothing and
// consumes no slot.
//
// Privacy: touches only System accounts derived from a public owner key;
// no private state, no keys other than the relayer's own `fee_payer`.
//
// Week 6 (spec §2.7): the owner is the relayer SIWS session's owner —
// `body.owner` is optional and must match it; an unauthenticated POST no
// longer spends SOL.
import express from "express";
import type { Router } from "express";
import { createHash } from "node:crypto";
import { NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import { requireSession, type AuthStore } from "./auth.js";
import type { SponsorStore } from "./sponsor.js";

// Three per owner (25.09.2026): a sponsored fresh onboarding needs three L1
// legs — `faucet+init_user`, `delegate_spl`, `delegate_user` — the last two
// used to share one tx and overflowed the 1232-byte packet once the nonce
// advance + ComputeBudget pair were prepended (`Transaction too large:
// 1322 > 1232`, live fakewallet, 0-SOL wallet).
export const NONCE_SEED_PREFIXES = ["dn0-", "dn1-", "dn2-"] as const;
export type NonceSlot = 0 | 1 | 2;
export const NONCE_SLOTS: readonly NonceSlot[] = [0, 1, 2];

/** `"dn<slot>-" + base58(owner)[0:28]` — 32 bytes, the System Program's seed maximum. */
export function nonceSeedFor(owner: PublicKey, slot: NonceSlot): string {
  return `${NONCE_SEED_PREFIXES[slot]}${owner.toBase58().slice(0, 28)}`;
}

/** Synchronous `PublicKey.createWithSeed(base, seed, SystemProgram)` — sha256(base ‖ seed ‖ programId). */
export function createWithSeedSync(base: PublicKey, seed: string): PublicKey {
  const h = createHash("sha256").update(base.toBuffer()).update(Buffer.from(seed, "utf8")).update(SystemProgram.programId.toBuffer()).digest();
  return new PublicKey(h);
}

/** The owner's nonce accounts (one per `NONCE_SLOTS` entry), as the relayer with `feePayer` derives them. */
export function nonceAccountsFor(feePayer: PublicKey, owner: PublicKey): PublicKey[] {
  return NONCE_SLOTS.map((slot) => createWithSeedSync(feePayer, nonceSeedFor(owner, slot)));
}

export interface NonceState {
  account: string;
  nonce: string | null;
}

/** Minimal `Connection` surface the router needs — mockable in tests. */
export interface NonceConn {
  getNonce: Connection["getNonce"];
  getMinimumBalanceForRentExemption: Connection["getMinimumBalanceForRentExemption"];
  getLatestBlockhash: Connection["getLatestBlockhash"];
  sendRawTransaction: Connection["sendRawTransaction"];
  getSignatureStatuses: Connection["getSignatureStatuses"];
}

export async function readNonceStates(conn: NonceConn, feePayer: PublicKey, owner: PublicKey): Promise<NonceState[]> {
  const accounts = nonceAccountsFor(feePayer, owner);
  return Promise.all(
    accounts.map(async (account) => {
      try {
        const st = await conn.getNonce(account, "confirmed");
        return { account: account.toBase58(), nonce: st && st.authorizedPubkey.equals(owner) ? st.nonce : null };
      } catch {
        return { account: account.toBase58(), nonce: null };
      }
    }),
  );
}

export function createNonceInstructions(feePayer: PublicKey, owner: PublicKey, missing: NonceSlot[], lamports: number): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  for (const slot of missing) {
    const seed = nonceSeedFor(owner, slot);
    const newAccountPubkey = createWithSeedSync(feePayer, seed);
    ixs.push(
      SystemProgram.createAccountWithSeed({
        fromPubkey: feePayer,
        newAccountPubkey,
        basePubkey: feePayer,
        seed,
        lamports,
        space: NONCE_ACCOUNT_LENGTH,
        programId: SystemProgram.programId,
      }),
      SystemProgram.nonceInitialize({ noncePubkey: newAccountPubkey, authorizedPubkey: owner }),
    );
  }
  return ixs;
}

async function confirmSig(conn: NonceConn, sig: string, tries = 100, delayMs = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st) {
      if (st.err) throw new Error(`nonce creation tx ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`nonce creation tx ${sig} not confirmed in time`);
}

export interface NonceRouterDeps {
  conn: NonceConn;
  feePayer: Keypair;
  store: SponsorStore;
  /** Same trailing-24h cap as /sponsor, in lamports. */
  dailyBudgetLamports: number;
  now?: () => number;
  /** Relayer session store (auth.ts) — the owner comes from the session (spec §2.7). */
  authStore: AuthStore;
}

export function nonceRouter(deps: NonceRouterDeps): Router {
  const router = express.Router();
  const now = deps.now ?? (() => Date.now());
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
    const before = await readNonceStates(deps.conn, deps.feePayer.publicKey, owner);
    const missing = NONCE_SLOTS.filter((slot) => before[slot].nonce === null);
    if (missing.length === 0) {
      res.status(200).json({ owner: owner.toBase58(), created: false, nonces: before });
      return;
    }
    const ts = now();
    const reservation = await deps.store.reserve(owner.toBase58(), ts);
    if (!reservation) {
      res.status(429).json({ error: "rate limit: this owner has used every sponsor slot in the current window" });
      return;
    }
    try {
      const rent = await deps.conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const cost = rent * missing.length;
      const spent = await deps.store.spentSince(ts - 24 * 60 * 60 * 1000);
      if (spent.lamports + cost > deps.dailyBudgetLamports) {
        await deps.store.release(reservation);
        res.status(400).json({ error: "daily sponsor budget exceeded" });
        return;
      }
      const tx = new Transaction().add(...createNonceInstructions(deps.feePayer.publicKey, owner, [...missing], rent));
      tx.feePayer = deps.feePayer.publicKey;
      tx.recentBlockhash = (await deps.conn.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(deps.feePayer);
      const sig = await deps.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await confirmSig(deps.conn, sig);
      await deps.store.finalize(reservation, sig, cost);
      const after = await readNonceStates(deps.conn, deps.feePayer.publicKey, owner);
      console.log(`nonce: created ${missing.length} account(s) for ${owner.toBase58()} (${cost} lamports) ${sig}`);
      res.status(200).json({ owner: owner.toBase58(), created: true, signature: sig, nonces: after });
    } catch (e) {
      await deps.store.release(reservation);
      console.error("nonce: creation failed", String(e));
      res.status(502).json({ error: `nonce creation failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
  return router;
}
