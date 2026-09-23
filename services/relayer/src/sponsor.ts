// services/relayer/src/sponsor.ts
//
// POST /sponsor (Task 6, week 4) — the relayer's `fee_payer` key
// co-signs a whitelisted onboarding transaction the owner has ALREADY
// signed, so the app can batch faucet_init/init_user/delegateSpl/
// delegate_user into a couple of MWA `signTransactions([...])` legs with
// `fee_payer` fronting network fees and PDA/eSPL rent for those two L1
// legs. The whitelist ALSO accepts init_permissions/set_session/a matching
// SystemProgram session-top-up transfer (an ER leg) — the app tried
// sponsoring that leg too this fix round and reverted it (real devnet-tee
// rejects fee_payer as an ER tx's fee payer — see
// app/src/features/onboard/batchOnboarding.ts's file header for the exact
// error and the revert); this whitelist support is kept as tested,
// currently-unused forward capacity, not something the app calls today.
//
// The relayer never originates anything here and never calls
// `sendRawTransaction` — it only `partialSign`s with `fee_payer` and hands
// the (now dual-signed) tx back as base64 for the caller to submit itself,
// exactly like the rest of the owner-signed pipeline
// (`sendL1`/`sendErOwner` in app/src/features/onboard/batchOnboarding.ts).
//
// --- Fix round 1 (task-6 controller ruling), what changed here ----------
//
// Finding A: `programs/dexxer_core/src/instructions/user.rs`'s
// `FaucetInit`/`InitUser` gained a `payer` account distinct from `owner`
// (`payer = payer` in every `init` constraint) — `fee_payer` now genuinely
// fronts PDA rent, not just the flat network fee, for those two
// instructions (verified on real devnet this fix round). `delegateSpl`'s
// `payer` option lets `fee_payer` front the eSPL leg's rent too (app-side
// change, also verified on real devnet). Sponsoring the ER leg
// (`init_permissions` + `set_session` + the session top-up) was ALSO
// attempted — the whitelist below still accepts that shape (plus exactly
// one `SystemProgram` transfer shape for the session top-up) — but the app
// reverted to NOT using it after real devnet-tee rejected `fee_payer` as
// that leg's fee payer (`"InvalidAccountForFee"` — see
// `app/src/features/onboard/batchOnboarding.ts`'s file header for the full
// account). This whitelist capacity is kept, tested, currently unused.
//
// Finding B (critical): the old whitelist matched programId + discriminator
// only, never WHERE `fee_payer`/`owner` actually sit in an instruction's
// account list — an attacker could smuggle a foreign pubkey into `owner`'s
// slot (or `fee_payer`'s own pubkey into `payer`'s slot of an unrelated
// account) and get `fee_payer` to fund rent for accounts that have nothing
// to do with the signing owner. `checkInstruction` now validates every
// whitelisted instruction's account POSITIONS against the IDL/SDK account
// order (`IxShape` below), not just its discriminator.
//
// --- Whitelist -------------------------------------------------------
//
// dexxer_core, matched by the 8-byte Anchor discriminator baked into
// `app/src/idl/dexxer_core.json` (same IDL `tests/er/lib/program.ts`
// already loads for every other relayer subsystem):
//   faucet_init, init_user       — owner@0, payer@1 (payer must be fee_payer)
//   delegate_user                — owner@0, payer@1 (week-5 Task 3 P1: the
//                                   three delegation records got their own
//                                   payer, split out of `owner`)
//   init_permissions, set_session — owner@0, no payer account (the
//                                   permissioned account self-funds its own
//                                   permission rent inside the ER — see
//                                   user.rs's `InitPermissions`/`SetSession`)
// `init_position`/`init_dq`/`delegate_position`/`delegate_dq` don't exist as
// standalone instructions — `init_user`/`delegate_user` cover all three
// per-user PDAs in one call.
//
// eSPL: the exact instruction shape `delegateSpl(owner, mint, amount,
// { payer: feePayer, validator, initVaultIfMissing: false, idempotent:
// false })` builds (`buildDelegateSplInstructions` in the SDK,
// `initIfMissing` defaults true, `initVaultIfMissing` explicitly false, no
// `private`) — three `EPHEMERAL_SPL_TOKEN_PROGRAM_ID` instructions, matched
// by their one-byte discriminant prefix:
//   0 — initEphemeralAtaIx     payer@1 (fee_payer), owner@2
//   2 — transferToVaultIx      owner@5 (signer), no payer account at all
//   4 — delegateEphemeralAtaIx payer@0 (fee_payer), no owner account at all
// Any other eSPL opcode (idempotent/private/shuttle variants) is NOT
// whitelisted.
//
// ATA program: `createAssociatedTokenAccountIdempotentInstruction(owner,
// ownerAta, owner, mint)` — `useOnboarding.ts` prepends this ahead of
// `faucet_init` when the owner's dUSDC ATA doesn't exist yet. This one
// stays OWNER-funded, not fee_payer — its `payer`@0 must be the owner, its
// `owner`@2 must be the owner, and `fee_payer` must not appear in it at
// all. Matched by `ASSOCIATED_TOKEN_PROGRAM_ID` + the single-byte
// `CreateIdempotent` opcode (`[1]`); the (data-less) non-idempotent
// `Create` is NOT whitelisted.
//
// SystemProgram: exactly ONE `SystemProgram::transfer` is ever sponsored
// per tx — the session top-up (`app/src/lib/session.ts`'s
// `sessionTopUpIx`), now paid by `fee_payer` instead of the owner. It must
// (a) originate `from` fee_payer, (b) transfer `to` the exact pubkey the
// SAME tx's `set_session` instruction passes as its `session_key` argument
// (cross-instruction check — decoded straight from the instruction's Borsh
// args, no IDL coder needed for three fixed-width fields), and (c) move at
// most `SESSION_FUND_LAMPORTS` lamports. Any other SystemProgram
// instruction (or a transfer that fails any of those three checks, or a
// second SystemProgram instruction in the same tx) is rejected outright —
// letting an owner move `fee_payer`'s own lamports anywhere else would let
// them drain the shared fee_payer on every call.
//
// --- Signature checks --------------------------------------------------
//
// `tx.feePayer` must already equal `cfg.feePayer.publicKey`. `fee_payer`'s
// own signature slot must still be empty (fix round 1, finding B — closes
// a replay/pre-signed-slot smuggling angle). The owner is resolved from
// `tx.signatures` (every account the COMPILED message actually requires a
// signature from — not from scanning each instruction's caller-supplied
// `keys` for `isSigner: true`, which a crafted instruction could set on any
// account it likes): exactly one non-fee_payer entry must exist, and it
// must already carry a present, cryptographically valid signature
// (`tx.verifySignatures(false)` — `false` because `fee_payer`'s own slot is
// still empty at this point). Every whitelisted instruction's `owner`
// position (per `IxShape` above) must equal that SAME resolved pubkey.
//
// --- Rate limit + daily budget -----------------------------------------
//
// Fix round 1, finding C: the old rate limit was a check-then-insert race
// (`lastSponsorAt` read, then `record` written, as two separate calls) — two
// concurrent requests for the same owner could both pass the check before
// either recorded. `SponsorStore.reserve` now does the atomic part with a
// single `INSERT ... ON CONFLICT (owner, "window", slot) DO NOTHING
// RETURNING` against a UNIQUE index on `(owner, "window", slot)`
// (`"window" = floor(ts / RATE_LIMIT_MS)`, `migrations/002_sponsors.sql` +
// `004_sponsors_slot.sql`) — the database's own uniqueness constraint is the
// race-closer, not application logic. `slot` ranges over
// `MAX_SPONSOR_CALLS_PER_OWNER_WINDOW` (fix round 1, post-verification
// finding: a single onboarding attempt needs up to three sponsored legs —
// L1a, L1b, the ER leg — so "one sponsored tx per owner per hour" from the
// original design literally could never complete an onboarding; widened to
// a small bounded ceiling instead of a single slot, still atomic per slot).
// The handler reserves FIRST (`store.reserve`, before the budget check); a
// `null` return means every slot in the window is already taken (=> 429, no
// other check runs). Only after a successful reservation does the
// daily-budget check run (`store.spentSince`, which only sums FINALIZED
// rows — `lamports > 0` — so the just-inserted 0-lamport reservation row
// never self-counts); if that check rejects, `store.release` deletes the
// reservation so a request that was ultimately never sponsored doesn't
// burn one of the owner's slots. `reserve`+`release`/`finalize` are not
// wrapped in one held database transaction spanning the cost-estimation RPC
// call in between (that would hold a Postgres transaction open across a
// network round trip to simulate against the RPC — bad practice); the
// UNIQUE index alone is what makes the per-owner race safe regardless.
//
// `dailyBudgetSol` (`SPONSOR_DAILY_SOL`, default `DEFAULT_DAILY_BUDGET_SOL`)
// caps the sum of `lamports` sponsored across ALL owners in the trailing
// 24h. The cost of a given tx is estimated via the injected `CostEstimator`
// (real impl: `simulateCostEstimator`, a `fee_payer` balance-delta
// simulate) rather than assumed — this now measures real PDA/eSPL rent plus
// the session top-up, not just the flat network fee, now that `payer`
// fields actually route to `fee_payer` (see Finding A above; previously
// this was flagged in the task-6 report as sponsoring only the network
// fee — no longer true after this fix round's program/app changes).

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
/**
 * Fix round 1 (post-A/B/C verification finding): a single onboarding
 * attempt needs up to THREE sponsored legs (L1a, L1b, the ER leg) — plus,
 * per finding D, one more per leg whose blockhash expired and had to be
 * re-signed. The original design's "1 sponsored tx per owner per 60 min"
 * literally could not complete a real onboarding (leg 2 always got a 429
 * from leg 1's own reservation) — caught only once this fix round actually
 * drove a fresh wallet through the full batch (see task-6-report.md "fix
 * round 1"). Widened to a small per-owner ceiling instead of a single slot;
 * still bounded (so a compromised/malicious owner identity can't spam
 * unlimited sponsorship) and still atomic per slot (finding C's guarantee
 * is unchanged, just applied N times instead of once).
 */
export const MAX_SPONSOR_CALLS_PER_OWNER_WINDOW = 6;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_BUDGET_SOL = 0.5;
/**
 * Session top-up cap (fix round 1, finding A.3) — mirrors `SESSION_LAMPORTS`
 * in `app/src/lib/session.ts`. Duplicated, not imported: the relayer and
 * the app are separate deployables with no shared package.
 */
export const SESSION_FUND_LAMPORTS = 10_000_000;

// --- whitelist -----------------------------------------------------------

const CORE_WHITELIST = new Set(["faucet_init", "init_user", "delegate_user", "init_permissions", "set_session"]);

interface CoreIx {
  name: string;
  discriminator: number[];
}

/** hex(8-byte discriminator) -> instruction name, for the dexxer_core instructions this endpoint sponsors. */
const CORE_DISCRIMINATORS: Map<string, string> = new Map(
  ((DEXXER_CORE_IDL as unknown as { instructions: CoreIx[] }).instructions)
    .filter((ix) => CORE_WHITELIST.has(ix.name))
    .map((ix) => [Buffer.from(ix.discriminator).toString("hex"), ix.name]),
);
if (CORE_DISCRIMINATORS.size !== CORE_WHITELIST.size) {
  throw new Error(`sponsor: expected ${CORE_WHITELIST.size} dexxer_core whitelist discriminators, found ${CORE_DISCRIMINATORS.size} in the IDL`);
}

/**
 * Fix round 1, finding B: where `payer`/`owner` sit in a whitelisted
 * instruction's account list, by IDL/SDK order. `undefined` means "this
 * instruction has no such account at all" — for `payerIdx`, that's enforced
 * by `checkPositions`' "no other key may equal fee_payer" sweep (fee_payer
 * must not appear anywhere in an instruction that has no payer role); for
 * `ownerIdx`, it simply means the owner-position check is skipped.
 */
interface IxShape {
  payerIdx?: number;
  ownerIdx?: number;
}

const CORE_SHAPES: Record<string, IxShape> = {
  faucet_init: { ownerIdx: 0, payerIdx: 1 },
  init_user: { ownerIdx: 0, payerIdx: 1 },
  // Week-5 Task 3 (P1): `DelegateUser` gained `payer: Signer` at index 1.
  delegate_user: { ownerIdx: 0, payerIdx: 1 },
  init_permissions: { ownerIdx: 0 },
  set_session: { ownerIdx: 0 },
};
if (Object.keys(CORE_SHAPES).length !== CORE_WHITELIST.size) {
  throw new Error("sponsor: CORE_SHAPES is out of sync with CORE_WHITELIST");
}

/** eSPL instruction-data one-byte prefix -> label + account shape, for the exact shape `delegateSpl(..., { payer: feePayer, initVaultIfMissing: false, idempotent: false })` emits. */
const ESPL_SHAPES: Map<number, IxShape & { label: string }> = new Map([
  [0, { label: "espl:init_ephemeral_ata", payerIdx: 1, ownerIdx: 2 }],
  [2, { label: "espl:transfer_to_vault", ownerIdx: 5 }],
  [4, { label: "espl:delegate_ephemeral_ata", payerIdx: 0 }],
]);

/** ATA `CreateIdempotent(payer, ata, owner, mint, ...)` — owner-funded, `fee_payer` must not appear in it at all. */
const ATA_SHAPE: IxShape = { ownerIdx: 2 };

interface IxCheck {
  ok: boolean;
  label?: string;
  reason?: string;
}

/**
 * Validates one instruction's account list against `shape`: `payerIdx` (if
 * present) must hold `feePayer`; `ownerIdx` (if present) must hold `owner`;
 * and — the actual anti-smuggling check — `feePayer` must not appear at ANY
 * other position, including implicitly (when `shape.payerIdx` is
 * `undefined`, `feePayer` must not appear anywhere in this instruction).
 */
function checkPositions(ix: TransactionInstruction, shape: IxShape, feePayer: PublicKey, owner: PublicKey, label: string): string | null {
  if (shape.payerIdx !== undefined) {
    const k = ix.keys[shape.payerIdx];
    if (!k || !k.pubkey.equals(feePayer)) return `${label}: account index ${shape.payerIdx} (payer) must be fee_payer`;
  }
  if (shape.ownerIdx !== undefined) {
    const k = ix.keys[shape.ownerIdx];
    if (!k || !k.pubkey.equals(owner)) return `${label}: account index ${shape.ownerIdx} (owner) must be the tx's owner signer`;
  }
  for (let i = 0; i < ix.keys.length; i++) {
    if (i === shape.payerIdx) continue;
    if (ix.keys[i].pubkey.equals(feePayer)) {
      return `${label}: fee_payer may only appear at the payer position${shape.payerIdx !== undefined ? ` (index ${shape.payerIdx})` : ""}, found it at index ${i}`;
    }
  }
  return null;
}

function checkInstruction(ix: TransactionInstruction, feePayer: PublicKey, owner: PublicKey): IxCheck {
  if (ix.programId.equals(DEXXER_CORE_PROGRAM_ID)) {
    if (ix.data.length < 8) return { ok: false, reason: `dexxer_core instruction too short (${ix.data.length} bytes, need >=8 for a discriminator)` };
    const disc = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
    const name = CORE_DISCRIMINATORS.get(disc);
    if (!name) return { ok: false, reason: `dexxer_core discriminator ${disc} not in whitelist {${[...CORE_WHITELIST].join(", ")}}` };
    const label = `dexxer_core:${name}`;
    const posErr = checkPositions(ix, CORE_SHAPES[name], feePayer, owner, label);
    if (posErr) return { ok: false, reason: posErr };
    return { ok: true, label };
  }
  if (ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)) {
    if (ix.data.length < 1) return { ok: false, reason: "eSPL instruction has no data byte" };
    const shape = ESPL_SHAPES.get(ix.data[0]);
    if (!shape) return { ok: false, reason: `eSPL instruction-data prefix ${ix.data[0]} not in whitelist {0,2,4} (delegateSpl idempotent:false shape)` };
    const posErr = checkPositions(ix, shape, feePayer, owner, shape.label);
    if (posErr) return { ok: false, reason: posErr };
    return { ok: true, label: shape.label };
  }
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
    if (!(ix.data.length === 1 && ix.data[0] === 1)) {
      return { ok: false, reason: "only the ATA program's CreateIdempotent (data=[1]) instruction is whitelisted" };
    }
    const posErr = checkPositions(ix, ATA_SHAPE, feePayer, owner, "ata:create_idempotent");
    if (posErr) return { ok: false, reason: posErr };
    return { ok: true, label: "ata:create_idempotent" };
  }
  return { ok: false, reason: `programId ${ix.programId.toBase58()} not in whitelist {dexxer_core, eSPL, ATA, SystemProgram (session top-up only)}` };
}

/** `set_session(session_key: Pubkey, expiry: i64, actions: u32)` — session_key is the first 32 bytes after the 8-byte discriminator. */
function decodeSetSessionKey(ix: TransactionInstruction): PublicKey | null {
  if (ix.data.length < 40) return null;
  return new PublicKey(ix.data.subarray(8, 40));
}

const SYSTEM_TRANSFER_TAG = 2; // SystemInstruction::Transfer, 4-byte LE u32 tag

function decodeSystemTransfer(ix: TransactionInstruction): { from: PublicKey; to: PublicKey; lamports: number } | null {
  if (ix.data.length !== 12) return null; // 4-byte tag + 8-byte lamports, exactly
  if (ix.data.readUInt32LE(0) !== SYSTEM_TRANSFER_TAG) return null;
  if (ix.keys.length !== 2) return null;
  const [fromMeta, toMeta] = ix.keys;
  if (!fromMeta.isSigner || !fromMeta.isWritable) return null;
  return { from: fromMeta.pubkey, to: toMeta.pubkey, lamports: Number(ix.data.readBigUInt64LE(4)) };
}

export type WhitelistCheck = { ok: true; owner: PublicKey; labels: string[] } | { ok: false; error: string };

/**
 * Validates a fully-built (owner-signed) transaction against the fixed
 * whitelist and extracts the single owner pubkey every whitelisted
 * instruction's `owner` position must agree on. Pure (no I/O, no clock) —
 * exercised directly by test/sponsor.test.ts. Rejects versioned
 * transactions implicitly: `Transaction.from()` (the caller, in the
 * `/sponsor` handler below) already throws
 * "Versioned messages must be deserialized with VersionedMessage.deserialize()"
 * before a `Transaction` object — and thus this function — is ever reached.
 */
export function checkWhitelist(tx: Transaction, feePayer: PublicKey, allowSessionTopUp = false): WhitelistCheck {
  if (!tx.feePayer || !tx.feePayer.equals(feePayer)) {
    return { ok: false, error: `tx.feePayer must equal the relayer's fee_payer (${feePayer.toBase58()})` };
  }
  if (tx.instructions.length === 0) {
    return { ok: false, error: "transaction has no instructions" };
  }

  // Fix round 1, finding B: fee_payer's own signature slot must still be
  // empty — a filled slot means either a replay of an already-sponsored tx
  // or a forged/pre-populated signature the caller is trying to smuggle in.
  const feePayerSig = tx.signatures.find((s) => s.publicKey.equals(feePayer));
  if (feePayerSig && feePayerSig.signature !== null) {
    return { ok: false, error: "fee_payer's signature slot is already filled" };
  }

  // The owner is resolved from `tx.signatures` — every account the COMPILED
  // message actually requires a signature from — not by scanning each
  // instruction's caller-supplied `keys` for `isSigner: true` (which a
  // crafted instruction could set on any account it likes).
  const otherSigners = tx.signatures.filter((s) => !s.publicKey.equals(feePayer));
  if (otherSigners.length !== 1) {
    return { ok: false, error: `expected exactly one owner signer besides fee_payer, found ${otherSigners.length}` };
  }
  const ownerSig = otherSigners[0];
  if (ownerSig.signature === null) {
    return { ok: false, error: "owner has not signed the transaction" };
  }
  const owner = ownerSig.publicKey;
  // `false`: fee_payer's own signature slot is still empty at this point —
  // we're only verifying what the caller already signed.
  if (!tx.verifySignatures(false)) {
    return { ok: false, error: "transaction carries an invalid signature" };
  }

  const labels: string[] = [];
  const seenLabels = new Set<string>();
  let sessionKeyArg: PublicKey | null = null;
  let transfer: { from: PublicKey; to: PublicKey; lamports: number } | null = null;

  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i];

    if (ix.programId.equals(SystemProgram.programId)) {
      // Fix round 1, finding A.3: exactly one SystemProgram instruction is
      // ever sponsored — the session top-up transfer. Cross-checked against
      // `set_session`'s argument after the loop (order-independent: the
      // transfer can precede or follow `set_session` in the same tx).
      //
      // Gated behind `allowSessionTopUp` (env `SPONSOR_ALLOW_SESSION_TOPUP`,
      // default false — see sponsor.ts's header comment): the app doesn't
      // call this leg today (real devnet-tee rejects fee_payer as an ER
      // tx's fee payer), so by default this behaves exactly like before
      // finding A.3 — any SystemProgram instruction is rejected outright.
      if (!allowSessionTopUp) {
        return { ok: false, error: `instruction ${i}: SystemProgram transfer sponsorship is disabled (set SPONSOR_ALLOW_SESSION_TOPUP=true to enable)` };
      }
      if (transfer) {
        return { ok: false, error: `instruction ${i}: only one SystemProgram transfer is ever sponsored per tx` };
      }
      const t = decodeSystemTransfer(ix);
      if (!t) {
        return { ok: false, error: `instruction ${i}: only a plain SystemProgram Transfer (the session top-up) is ever sponsored` };
      }
      if (!t.from.equals(feePayer)) {
        return { ok: false, error: `instruction ${i}: SystemProgram transfer must originate from fee_payer` };
      }
      if (t.lamports > SESSION_FUND_LAMPORTS) {
        return { ok: false, error: `instruction ${i}: SystemProgram transfer of ${t.lamports} lamports exceeds the session fund cap (${SESSION_FUND_LAMPORTS})` };
      }
      transfer = t;
      labels.push("system:transfer");
      continue;
    }

    const check = checkInstruction(ix, feePayer, owner);
    if (!check.ok) {
      return { ok: false, error: `instruction ${i}: ${check.reason}` };
    }
    const label = check.label as string;
    if (seenLabels.has(label)) {
      return { ok: false, error: `instruction ${i}: duplicate ${label} — each whitelisted instruction shape may appear at most once per sponsored tx` };
    }
    seenLabels.add(label);
    labels.push(label);
    if (label === "dexxer_core:set_session") {
      sessionKeyArg = decodeSetSessionKey(ix);
    }
  }

  if (transfer) {
    if (!sessionKeyArg) {
      return { ok: false, error: "SystemProgram transfer present without a set_session instruction in the same tx" };
    }
    if (!transfer.to.equals(sessionKeyArg)) {
      return { ok: false, error: "SystemProgram transfer destination must equal set_session's session_key argument" };
    }
  }

  return { ok: true, owner, labels };
}

// --- rate limit / daily budget -------------------------------------------

/** One reserved (owner, 60-min window, slot) — see `SponsorStore.reserve`. */
export interface SponsorReservation {
  owner: string;
  ts: number;
  window: number;
  slot: number;
}

export interface SponsorStore {
  /**
   * Atomically reserves ONE of `owner`'s `MAX_SPONSOR_CALLS_PER_OWNER_WINDOW`
   * slots for the 60-minute window containing `ts` (`window = floor(ts /
   * RATE_LIMIT_MS)`). Returns `null` if every slot in that window is already
   * taken for this owner (=> 429 in the router). MUST be safe against
   * concurrent calls for the same `(owner, ts)` — `pgSponsorStore` tries
   * each slot's UNIQUE `(owner, "window", slot)` index in turn (`INSERT ...
   * ON CONFLICT DO NOTHING`), not a held transaction, to guarantee that
   * (fix round 1, finding C) no matter how many slots there are.
   */
  reserve(owner: string, ts: number): Promise<SponsorReservation | null>;
  /** Sum of lamports/count of FINALIZED rows (`lamports > 0`) since `sinceTs`, across all owners — pending reservations don't count. */
  spentSince(sinceTs: number): Promise<{ lamports: number; count: number }>;
  /** Finalizes a reservation with the real signature/cost once fee_payer has actually signed. */
  finalize(reservation: SponsorReservation, sig: string, lamports: number): Promise<void>;
  /** Releases a reservation that must not count — a later check (the daily budget) rejected the request, so this slot isn't burned for a request that was never actually sponsored. */
  release(reservation: SponsorReservation): Promise<void>;
}

export function pgSponsorStore(pool: DbPool): SponsorStore {
  return {
    async reserve(owner, ts) {
      const window = Math.floor(ts / RATE_LIMIT_MS);
      // Try each slot's own UNIQUE (owner, "window", slot) index in turn —
      // each slot can be won by at most one concurrent caller, so this stays
      // atomic (finding C) even though there are now several slots per
      // owner+window instead of one.
      for (let slot = 0; slot < MAX_SPONSOR_CALLS_PER_OWNER_WINDOW; slot++) {
        const { rows } = await pool.query<{ owner: string; ts: string; window: string; slot: number }>(
          'INSERT INTO sponsors (owner, ts, "window", slot, sig, lamports) VALUES ($1, $2, $3, $4, \'\', 0) ON CONFLICT (owner, "window", slot) DO NOTHING RETURNING owner, ts, "window", slot',
          [owner, ts, window, slot],
        );
        if (rows.length > 0) {
          return { owner: rows[0].owner, ts: Number(rows[0].ts), window: Number(rows[0].window), slot: rows[0].slot };
        }
      }
      return null;
    },
    async spentSince(sinceTs) {
      const { rows } = await pool.query<{ sum: string | null; count: string }>(
        "SELECT COALESCE(SUM(lamports), 0) AS sum, COUNT(*) AS count FROM sponsors WHERE ts >= $1 AND lamports > 0",
        [sinceTs],
      );
      return { lamports: Number(rows[0]?.sum ?? 0), count: Number(rows[0]?.count ?? 0) };
    },
    async finalize(reservation, sig, lamports) {
      await pool.query('UPDATE sponsors SET sig = $4, lamports = $5 WHERE owner = $1 AND "window" = $2 AND slot = $3', [
        reservation.owner,
        reservation.window,
        reservation.slot,
        sig,
        lamports,
      ]);
    },
    async release(reservation) {
      await pool.query('DELETE FROM sponsors WHERE owner = $1 AND "window" = $2 AND slot = $3 AND lamports = 0', [
        reservation.owner,
        reservation.window,
        reservation.slot,
      ]);
    },
  };
}

export type CostEstimator = (tx: Transaction) => Promise<number>;

/**
 * Real cost estimator: signs a scratch copy with `feePayer`, simulates it,
 * and reads `feePayer`'s own balance delta (pre-sim `getBalance` minus the
 * simulated post-sim balance) — this measures whatever `fee_payer` ACTUALLY
 * fronts (network fee, PDA rent via the `payer` account fields, eSPL rent,
 * and the session top-up — see this file's header, Finding A) rather than
 * assuming any one of those. The fallback below (flat network fee) applies
 * only if simulation fails or doesn't report a balance (e.g. the tx would
 * fail on-chain for an unrelated reason — this endpoint still sponsors it,
 * since re-validating full on-chain preconditions is out of scope for a
 * fee-payer co-sign gate; the owner's own submission will surface any such
 * failure).
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
  /**
   * Env `SPONSOR_ALLOW_SESSION_TOPUP`, default false — see `checkWhitelist`'s
   * `allowSessionTopUp` param and this file's header comment. Week-5 route,
   * unused by the app today.
   */
  allowSessionTopUp?: boolean;
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

    const check = checkWhitelist(tx, deps.feePayer.publicKey, deps.allowSessionTopUp ?? false);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    const ownerStr = check.owner.toBase58();
    const t = now();

    // Fix round 1, finding C: reserve FIRST — the atomic per-slot UNIQUE
    // index is the actual race-closer (see `SponsorStore.reserve`'s doc).
    // No row => this owner already used all its slots this 60-minute
    // window; 429 before any other check runs.
    const reservation = await deps.store.reserve(ownerStr, t);
    if (!reservation) {
      res.status(429).json({
        error: `rate limit: at most ${MAX_SPONSOR_CALLS_PER_OWNER_WINDOW} sponsored transactions per owner per 60 minutes`,
        retryAfterMs: RATE_LIMIT_MS - (t % RATE_LIMIT_MS),
      });
      return;
    }

    const estimate = await deps.estimateLamports(tx);
    const spent = await deps.store.spentSince(t - DAY_MS);
    if (spent.lamports + estimate > dailyBudgetLamports) {
      await deps.store.release(reservation);
      res.status(400).json({
        error: `daily sponsor budget exceeded: ${(spent.lamports / 1e9).toFixed(6)} + ${(estimate / 1e9).toFixed(6)} > ${(dailyBudgetLamports / 1e9).toFixed(6)} SOL`,
      });
      return;
    }

    tx.partialSign(deps.feePayer);
    const sigBuf = tx.signature;
    if (!sigBuf) {
      await deps.store.release(reservation);
      res.status(500).json({ error: "internal: fee_payer signature missing after partialSign" });
      return;
    }
    const sig = bs58.encode(sigBuf);
    await deps.store.finalize(reservation, sig, estimate);

    res.json({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") });
  });

  return router;
}
