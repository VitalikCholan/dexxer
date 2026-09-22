// services/relayer/src/sponsor.ts
//
// POST /sponsor (Task 6, week 4) — the relayer's `fee_payer` key
// co-signs a whitelisted onboarding transaction the owner has ALREADY
// signed, so the app can batch faucet_init/init_user/delegateSpl/
// delegate_user into one MWA `signTransactions([...])` prompt without the
// owner needing any devnet SOL to cover the *network fee*.
//
// The relayer never originates anything here and never calls
// `sendRawTransaction` — it only `partialSign`s with `fee_payer` and hands
// the (now dual-signed) tx back as base64 for the caller to submit itself,
// exactly like the rest of the owner-signed pipeline
// (`sendL1`/`sendErOwner` in app/src/features/onboard/useOnboarding.ts).
//
// --- Whitelist -------------------------------------------------------
//
// The IDL has no standalone `init_position`/`init_dq`/`delegate_position`/
// `delegate_dq` — `init_user` creates `UserAccount`+`Position`+
// `DisclosureQueue` in one call, `delegate_user` delegates all three. So
// the dexxer_core whitelist is exactly `{faucet_init, init_user,
// delegate_user}`, matched by the 8-byte Anchor discriminator baked into
// `app/src/idl/dexxer_core.json` (same IDL `tests/er/lib/program.ts`
// already loads for every other relayer subsystem — see `DEXXER_IDL_DIR`'s
// header comment there for why that file, not `target/idl/`, is the one
// that exists in a fresh Docker build).
//
// The eSPL whitelist is the exact instruction shape
// `useOnboarding.ts::runFlow` builds — `delegateSpl(owner, mint, amount,
// { validator, initVaultIfMissing: false, idempotent: false })` — which
// (per `buildDelegateSplInstructions` in the SDK, `initIfMissing` defaults
// true, `initVaultIfMissing` explicitly false, no `private`) emits exactly
// three `EPHEMERAL_SPL_TOKEN_PROGRAM_ID` instructions, matched by their
// one-byte discriminant prefix:
//   0 — initEphemeralAtaIx        (creates the owner's eATA)
//   2 — transferToVaultIx         (owner's ATA -> vault ATA)
//   4 — delegateEphemeralAtaIx    (delegates the eATA to the ER validator)
// Any other eSPL opcode (idempotent/private/shuttle variants) is NOT
// whitelisted — this relayer only ever needs to recognize what
// `useOnboarding.ts` actually builds.
//
// One ATA-program instruction is also whitelisted: `useOnboarding.ts`
// conditionally prepends `createAssociatedTokenAccountIdempotentInstruction
// (owner, ownerAta, owner, mint)` ahead of `faucet_init` when the owner's
// dUSDC ATA doesn't exist yet — true for every genuinely fresh wallet. Its
// `payer` is `owner` (signer, writable — the OWNER'S OWN lamports fund
// this rent, never fee_payer's), so sponsoring it is safe under the same
// rule as everything else here. Matched by `ASSOCIATED_TOKEN_PROGRAM_ID` +
// the single-byte `CreateIdempotent` opcode (`[1]`) — the only variant this
// app ever builds; the (data-less) non-idempotent `Create` is NOT
// whitelisted, since nothing here emits it.
//
// ANY `SystemProgram` instruction is rejected outright, unconditionally —
// a sponsored tx must never be able to move `fee_payer`'s own lamports
// (the owner fully controls instruction content before it ever reaches
// this endpoint; if a `SystemProgram::transfer` from `fee_payer` were
// tolerated, an owner could drain the shared fee_payer on every call).
//
// --- Signature checks --------------------------------------------------
//
// `tx.feePayer` must already equal `cfg.feePayer.publicKey` (not
// something this endpoint can set — it only ever adds ONE signature, to a
// slot the wire format already reserved when the owner built and signed
// the tx). Every whitelisted instruction's non-fee_payer signer accounts
// must all resolve to the SAME single pubkey (`owner`); that pubkey must
// already carry a present, cryptographically valid signature
// (`tx.verifySignatures(false)` — `false` because `fee_payer`'s own slot
// is still empty at this point).
//
// --- Rate limit + daily budget -----------------------------------------
//
// One successful sponsor per owner per `RATE_LIMIT_MS` (60 min), tracked
// in Postgres (`migrations/002_sponsors.sql`) behind the `SponsorStore`
// interface below so `test/sponsor.test.ts` needs no live Postgres (an
// in-memory fake implements the same interface). `dailyBudgetSol`
// (`SPONSOR_DAILY_SOL`, default `DEFAULT_DAILY_BUDGET_SOL`) caps the sum
// of `lamports` sponsored across ALL owners in the trailing 24h — the cost
// of a given tx is estimated via the injected `CostEstimator` (real impl:
// `simulateCostEstimator`, a `fee_payer` balance-delta simulate; tests
// inject a fixed-cost fake) rather than assumed, since which accounts'
// rent `fee_payer` actually fronts depends on instruction wiring this
// module doesn't own (see `simulateCostEstimator`'s comment: under the
// current `payer = owner` account constraints in
// `programs/dexxer_core/src/instructions/user.rs` and the `delegateSpl`
// call's default `payer` option, `fee_payer` currently only ever fronts
// the flat per-signature network fee, not PDA rent — the owner still pays
// their own PDAs' rent out of pocket. Flagged in the task-6 report as a
// concern, not silently assumed away here).

import express from "express";
import type { Router } from "express";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEXXER_CORE_IDL, DEXXER_CORE_PROGRAM_ID } from "../../../tests/er/lib/program.js";
import type { DbPool } from "./db.js";

export const LAMPORTS_PER_SIGNATURE = 5000;
export const RATE_LIMIT_MS = 60 * 60 * 1000; // 60 min
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_BUDGET_SOL = 0.5;

// --- whitelist -----------------------------------------------------------

const CORE_WHITELIST = new Set(["faucet_init", "init_user", "delegate_user"]);

interface CoreIx {
  name: string;
  discriminator: number[];
}

/** hex(8-byte discriminator) -> instruction name, for the three dexxer_core instructions this endpoint sponsors. */
const CORE_DISCRIMINATORS: Map<string, string> = new Map(
  ((DEXXER_CORE_IDL as unknown as { instructions: CoreIx[] }).instructions)
    .filter((ix) => CORE_WHITELIST.has(ix.name))
    .map((ix) => [Buffer.from(ix.discriminator).toString("hex"), ix.name]),
);
if (CORE_DISCRIMINATORS.size !== CORE_WHITELIST.size) {
  throw new Error(`sponsor: expected ${CORE_WHITELIST.size} dexxer_core whitelist discriminators, found ${CORE_DISCRIMINATORS.size} in the IDL`);
}

/** eSPL instruction-data one-byte prefix -> label, for the exact shape `delegateSpl(..., { initVaultIfMissing: false, idempotent: false })` emits. */
const ESPL_PREFIXES: Map<number, string> = new Map([
  [0, "espl:init_ephemeral_ata"],
  [2, "espl:transfer_to_vault"],
  [4, "espl:delegate_ephemeral_ata"],
]);

interface IxCheck {
  ok: boolean;
  label?: string;
  reason?: string;
}

function checkInstruction(ix: TransactionInstruction): IxCheck {
  if (ix.programId.equals(DEXXER_CORE_PROGRAM_ID)) {
    if (ix.data.length < 8) return { ok: false, reason: `dexxer_core instruction too short (${ix.data.length} bytes, need >=8 for a discriminator)` };
    const disc = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
    const name = CORE_DISCRIMINATORS.get(disc);
    if (!name) return { ok: false, reason: `dexxer_core discriminator ${disc} not in whitelist {faucet_init, init_user, delegate_user}` };
    return { ok: true, label: `dexxer_core:${name}` };
  }
  if (ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)) {
    if (ix.data.length < 1) return { ok: false, reason: "eSPL instruction has no data byte" };
    const label = ESPL_PREFIXES.get(ix.data[0]);
    if (!label) return { ok: false, reason: `eSPL instruction-data prefix ${ix.data[0]} not in whitelist {0,2,4} (delegateSpl idempotent:false shape)` };
    return { ok: true, label };
  }
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    if (ix.data.length === 1 && ix.data[0] === 1) return { ok: true, label: "ata:create_idempotent" };
    return { ok: false, reason: "only the ATA program's CreateIdempotent (data=[1]) instruction is whitelisted" };
  }
  return { ok: false, reason: `programId ${ix.programId.toBase58()} not in whitelist {dexxer_core, eSPL, ATA}` };
}

export type WhitelistCheck = { ok: true; owner: PublicKey; labels: string[] } | { ok: false; error: string };

/**
 * Validates a fully-built (owner-signed) transaction against the fixed
 * whitelist and extracts the single owner pubkey every whitelisted
 * instruction's non-fee_payer signer must agree on. Pure (no I/O, no
 * clock) — exercised directly by test/sponsor.test.ts.
 */
export function checkWhitelist(tx: Transaction, feePayer: PublicKey): WhitelistCheck {
  if (!tx.feePayer || !tx.feePayer.equals(feePayer)) {
    return { ok: false, error: `tx.feePayer must equal the relayer's fee_payer (${feePayer.toBase58()})` };
  }
  if (tx.instructions.length === 0) {
    return { ok: false, error: "transaction has no instructions" };
  }

  const labels: string[] = [];
  const signers = new Set<string>();
  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i];
    if (ix.programId.equals(SystemProgram.programId)) {
      return { ok: false, error: `instruction ${i}: SystemProgram instructions are never sponsored (would let the owner move fee_payer's lamports)` };
    }
    const check = checkInstruction(ix);
    if (!check.ok) {
      return { ok: false, error: `instruction ${i}: ${check.reason}` };
    }
    labels.push(check.label as string);
    for (const k of ix.keys) {
      if (k.isSigner && !k.pubkey.equals(feePayer)) signers.add(k.pubkey.toBase58());
    }
  }
  if (signers.size !== 1) {
    return { ok: false, error: `expected exactly one owner signer besides fee_payer across all instructions, found ${signers.size}` };
  }
  const owner = new PublicKey([...signers][0]);

  const ownerSig = tx.signatures.find((s) => s.publicKey.equals(owner));
  if (!ownerSig || ownerSig.signature === null) {
    return { ok: false, error: "owner has not signed the transaction" };
  }
  // `false`: fee_payer's own signature slot is still empty at this point —
  // we're only verifying what the caller already signed.
  if (!tx.verifySignatures(false)) {
    return { ok: false, error: "transaction carries an invalid signature" };
  }
  return { ok: true, owner, labels };
}

// --- rate limit / daily budget -------------------------------------------

export interface SponsorStore {
  /** ms epoch of `owner`'s most recent successful sponsor, or null if none. */
  lastSponsorAt(owner: string): Promise<number | null>;
  /** Sum of lamports sponsored (and count of calls) since `sinceTs`, across all owners. */
  spentSince(sinceTs: number): Promise<{ lamports: number; count: number }>;
  record(owner: string, ts: number, sig: string, lamports: number): Promise<void>;
}

export function pgSponsorStore(pool: DbPool): SponsorStore {
  return {
    async lastSponsorAt(owner) {
      const { rows } = await pool.query<{ ts: string }>("SELECT ts FROM sponsors WHERE owner = $1 ORDER BY ts DESC LIMIT 1", [owner]);
      return rows[0] ? Number(rows[0].ts) : null;
    },
    async spentSince(sinceTs) {
      const { rows } = await pool.query<{ sum: string | null; count: string }>(
        "SELECT COALESCE(SUM(lamports), 0) AS sum, COUNT(*) AS count FROM sponsors WHERE ts >= $1",
        [sinceTs],
      );
      return { lamports: Number(rows[0]?.sum ?? 0), count: Number(rows[0]?.count ?? 0) };
    },
    async record(owner, ts, sig, lamports) {
      await pool.query("INSERT INTO sponsors (owner, ts, sig, lamports) VALUES ($1, $2, $3, $4)", [owner, ts, sig, lamports]);
    },
  };
}

export type CostEstimator = (tx: Transaction) => Promise<number>;

/**
 * Real cost estimator: signs a scratch copy with `feePayer`, simulates it,
 * and reads `feePayer`'s own balance delta (pre-sim `getBalance` minus the
 * simulated post-sim balance) — this measures whatever `fee_payer` ACTUALLY
 * fronts, rather than assuming PDA rent is sponsored. Under the current
 * on-chain wiring (`payer = owner` in every whitelisted instruction — see
 * this file's header comment) that delta is just the flat network fee
 * (`LAMPORTS_PER_SIGNATURE * signatures.length`); the fallback below
 * returns exactly that if simulation fails or doesn't report a balance
 * (e.g. the tx would fail on-chain for an unrelated reason — this endpoint
 * still sponsors it, since re-validating full on-chain preconditions is out
 * of scope for a fee-payer co-sign gate; the owner's own submission will
 * surface any such failure).
 */
export function simulateCostEstimator(connection: Connection, feePayer: Keypair): CostEstimator {
  return async (tx) => {
    // A fresh clone, not the caller's `tx` — `Connection.simulateTransaction`
    // (legacy `Transaction` overload) always replaces `recentBlockhash` with
    // one it fetches itself, so signing this clone would be pointless (and
    // `sigVerify` is never requested here — no `signers` argument — so the
    // RPC doesn't check signatures at all for this call).
    const scratch = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const flatFee = LAMPORTS_PER_SIGNATURE * scratch.signatures.length;
    try {
      const preLamports = await connection.getBalance(feePayer.publicKey, "confirmed");
      const sim = await connection.simulateTransaction(scratch, undefined, [feePayer.publicKey]);
      if (sim.value.err) return flatFee;
      const acc = sim.value.accounts?.[0];
      const postLamports = acc ? Number(acc.lamports) : preLamports - flatFee;
      const delta = preLamports - postLamports;
      return delta > 0 ? delta : flatFee;
    } catch {
      return flatFee;
    }
  };
}

// --- router ---------------------------------------------------------------

export interface SponsorDeps {
  feePayer: Keypair;
  store: SponsorStore;
  estimateLamports: CostEstimator;
  dailyBudgetSol?: number;
  /** Injectable clock, defaults to `Date.now` — tests pin it. */
  now?: () => number;
}

export interface SponsorSnapshot {
  today_sol: number;
  count_today: number;
}

/** Used by `/healthz` (index.ts) to report today's sponsor spend without duplicating the store query logic. */
export function sponsorSnapshot(store: SponsorStore, now: () => number = Date.now): () => Promise<SponsorSnapshot> {
  return async () => {
    const spent = await store.spentSince(now() - DAY_MS);
    return { today_sol: spent.lamports / 1e9, count_today: spent.count };
  };
}

export function sponsorRouter(deps: SponsorDeps): Router {
  const router = express.Router();
  const dailyBudgetLamports = Math.round((deps.dailyBudgetSol ?? DEFAULT_DAILY_BUDGET_SOL) * 1e9);
  const now = deps.now ?? Date.now;

  router.post("/sponsor", express.json(), async (req, res) => {
    const body = req.body as { tx?: unknown } | undefined;
    if (!body || typeof body.tx !== "string" || body.tx.length === 0) {
      res.status(400).json({ error: "body.tx (base64-encoded transaction) is required" });
      return;
    }

    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(body.tx, "base64"));
    } catch (e) {
      res.status(400).json({ error: `could not parse tx: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    const check = checkWhitelist(tx, deps.feePayer.publicKey);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    const ownerStr = check.owner.toBase58();
    const t = now();

    const last = await deps.store.lastSponsorAt(ownerStr);
    if (last !== null && t - last < RATE_LIMIT_MS) {
      res.status(429).json({ error: "rate limit: one sponsored transaction per owner per 60 minutes", retryAfterMs: RATE_LIMIT_MS - (t - last) });
      return;
    }

    const estimate = await deps.estimateLamports(tx);
    const spent = await deps.store.spentSince(t - DAY_MS);
    if (spent.lamports + estimate > dailyBudgetLamports) {
      res.status(400).json({
        error: `daily sponsor budget exceeded: ${(spent.lamports / 1e9).toFixed(6)} + ${(estimate / 1e9).toFixed(6)} > ${(dailyBudgetLamports / 1e9).toFixed(6)} SOL`,
      });
      return;
    }

    tx.partialSign(deps.feePayer);
    const sigBuf = tx.signature;
    if (!sigBuf) {
      res.status(500).json({ error: "internal: fee_payer signature missing after partialSign" });
      return;
    }
    const sig = bs58.encode(sigBuf);
    await deps.store.record(ownerStr, t, sig, estimate);

    res.json({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") });
  });

  return router;
}
