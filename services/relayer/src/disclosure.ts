// services/relayer/src/disclosure.ts
//
// Moved from scripts/crank-fallback/disclosure.ts (Task 4, week 4) — no
// logic changes, only the relative import paths below (one directory
// deeper: services/relayer/src/ vs scripts/crank-fallback/).
//
// Week 3 (Task 7): the two cycles that ride on top of the crank tick loop
// (crank.ts) every `DISCLOSURE_EVERY_TICKS` — root BEFORE disclosure, so a
// `commit_aggregate` call always carries a freshly computed `BalancesRoot`
// (plan Task 7 Interfaces).
//
// `runRootCycle`: rebuilds the public `BalancesRoot` from the real
// `UserAccount` bytes, `ROOT_BATCH` (16) accounts per `set_balances_root`
// call, `begin`/`finalize` marking the first/last batch of the cycle. The
// leaves themselves are computed BY THE PROGRAM (state/balances_root.rs) —
// this script only chooses which `UserAccount`s to pass in and a fresh
// `padding_seed`; it can never forge a balance, only omit a user (spec risk
// #19).
//
// `runDisclosureCycle`: (1) finds `Position`s with `Closed &&
// !closed.commitment_written` and `DisclosureQueue`s with at least one due
// record (`reveal_after_slot <= slot`), builds a `remaining_accounts` list
// (possibly empty — see below) for a single `commit_aggregate` call (signed
// by `Config.fee_payer` — see the CANDIDATE-SELECTION HEURISTIC comment
// below), then (2) for every Position already `commitment_written` (from an
// EARLIER cycle — a bundle just sent in this same cycle has not propagated
// to L1 yet), checks whether its `Commitment` PDA now exists on the base
// layer and, if so, calls `mark_committed` (crank) to retire the record into
// `DisclosureQueue` and free the `Position` back to `Empty`.
//
// `commit_aggregate` IS the fixed-interval `Pool`+`BalancesRoot` commit
// (CLAUDE.md: "фіксованим інтервалом батчем, ніколи подієво") — it is called
// EVERY cycle, even with zero candidates (`remaining_accounts` empty), so a
// quiet window (no closed positions, no due reveals) still lands
// `runRootCycle`'s freshly computed root on L1. The program's own
// `actions.is_empty()` branch on the Rust side already handles the
// zero-candidate case (no post-commit actions attached, the `Pool`/
// `BalancesRoot` commit itself still fires).
//
// CANDIDATE-SELECTION HEURISTIC (MAX_ACTIONS_PER_COMMIT = 4, program-enforced
// via `TooManyActions`): every pending `Position` contributes exactly one
// `write_commitment` action, so the candidate list is built as at most 4
// `Position` accounts; a single `DisclosureQueue` account is added ONLY if
// there is still room left in the 4-account cap after Positions (the queue's
// own due-record count is then further clamped in-program to whatever budget
// remains — `disclosure::due_reveals`'s `room` parameter — so it never
// overflows the action budget on its own). This keeps every call at <=4
// remaining_accounts total and prioritises Positions (whose flag flip is
// itself the only way to ever call `mark_committed` on them) over queue
// reveals (which can wait one more cycle for free).

import { randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import {
  DQ_DISC,
  MAX_ACTIONS_PER_COMMIT,
  POSITION_DISC,
  ROOT_BATCH,
  USER_DISC,
  accountNs,
  commitmentHash,
  decodeBalancesRoot,
  pdas,
  reasonIndex,
  sideIndex,
  type DisclosureArgsBytes,
} from "../../../tests/er/lib/program.js";

/**
 * Rebuilds the `commitmentHash` args from a decoded (camelCase) `Position.closed`
 * `ClosedRecord`, mirroring `tests/er/devnet/06-commitment-reveal.ts`'s `recToArgs`.
 * Needed because (Task 8b, ruling 9) `Commitment`/`Disclosure` are seeded by this
 * hash, not by `nonce` alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function argsFromClosedRecord(rec: any): { args: DisclosureArgsBytes; salt: Uint8Array } {
  return {
    args: {
      market: new PublicKey(rec.market),
      side: sideIndex(rec.side),
      size: BigInt(rec.size.toString()),
      entry: BigInt(rec.entry.toString()),
      exit: BigInt(rec.exit.toString()),
      pnl: BigInt(rec.pnl.toString()),
      fees: BigInt(rec.fees.toString()),
      reason: reasonIndex(rec.reason),
      openedSlot: BigInt(rec.openedSlot.toString()),
      closedSlot: BigInt(rec.closedSlot.toString()),
      nonce: BigInt(rec.nonce.toString()),
      revealAfterSlot: BigInt(rec.revealAfterSlot.toString()),
    },
    salt: Uint8Array.from(rec.salt as number[]),
  };
}

export interface DisclosureCtx {
  /** Base-layer (L1) connection — only used to poll for a `Commitment` PDA's existence before `mark_committed`. */
  baseConn: Connection;
  /** Crank-authenticated ER connection: reads private Position/DisclosureQueue/UserAccount via `getProgramAccounts`, and signs `set_balances_root`/`mark_committed`. */
  conn: Connection;
  prog: Program;
  crank: Keypair;
  /** Fee-payer-authenticated ER connection — `commit_aggregate`'s `payer` account must equal `Config.fee_payer` (see task-7 brief). */
  feePayerConn: Connection;
  feePayerProg: Program;
  feePayer: Keypair;
  pool: PublicKey;
  /** Private live pool counters (week 4, Task 1) — read-only in `commit_aggregate`, must match `pool.mint`. */
  poolLive: PublicKey;
  balancesRoot: PublicKey;
  feeEscrow: PublicKey;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodePosition(prog: Program, data: Buffer): any {
  return prog.coder.accounts.decode("position", data);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeDisclosureQueue(prog: Program, data: Buffer): any {
  return prog.coder.accounts.decode("disclosureQueue", data);
}

/**
 * Decode-or-skip: Task 8's legacy-layout finding (pre-migration accounts from
 * weeks 1-2 testing, same discriminator, shorter/different byte layout) makes
 * `coder.accounts.decode` throw (`RangeError [ERR_OUT_OF_RANGE]`) rather than
 * fail cleanly. Filters them out of the candidate set instead of crashing the
 * whole cycle, logging every skip (Task 8b).
 */
function decodeOrSkip<T>(pubkey: PublicKey, data: Buffer, decode: () => T): T | null {
  try {
    return decode();
  } catch (e) {
    console.log(`skipped legacy: ${pubkey.toBase58()} len=${data.length} (${String(e)})`);
    return null;
  }
}

/** Number of ring-occupied records in `dq` whose `reveal_after_slot <= slot` (mirrors `disclosure::due_reveals`'s selection, without mutating). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dueRecordCount(dq: any, slot: bigint): number {
  const cap = dq.records.length as number;
  let due = 0;
  for (let i = 0; i < dq.len; i++) {
    const idx = (dq.head + i) % cap;
    const revealAfterSlot = BigInt(dq.records[idx].revealAfterSlot.toString());
    if (revealAfterSlot <= slot) due++;
  }
  return due;
}

export async function runRootCycle(ctx: DisclosureCtx): Promise<void> {
  const userAccs = await ctx.conn.getProgramAccounts(ctx.prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: USER_DISC } }],
  });
  // Task 8b / Task 8's legacy-layout finding: pre-`exit_salt`/`last_withdraw_slot`
  // `UserAccount`s from weeks 1-2 testing are shorter than the current layout and
  // make the whole `set_balances_root` batch fail (`InvalidLeafAccount`) if included
  // — filter by exact byte length (discriminator + `INIT_SPACE`, from the IDL coder,
  // i.e. `8 + UserAccount::INIT_SPACE`) before building any batch.
  const expectedUserAccountLen = ctx.prog.coder.accounts.size("userAccount") // camelCased by `new Program(idl)` — see index.ts;
  const currentUserAccs = userAccs.filter((u) => {
    const ok = u.account.data.length === expectedUserAccountLen;
    if (!ok) console.log(`skipped legacy: ${u.pubkey.toBase58()} len=${u.account.data.length}`);
    return ok;
  });
  const owners = currentUserAccs.map((u) => u.pubkey);
  const paddingSeed = Array.from(randomBytes(32));

  const batches: PublicKey[][] = [];
  for (let i = 0; i < owners.length; i += ROOT_BATCH) batches.push(owners.slice(i, i + ROOT_BATCH));
  // Zero UserAccounts is a valid state (fresh bootstrap) — still run one
  // begin+finalize call so the root gets reset and fully repadded.
  if (batches.length === 0) batches.push([]);

  for (let i = 0; i < batches.length; i++) {
    const begin = i === 0;
    const finalize = i === batches.length - 1;
    try {
      const ix = await ctx.prog.methods
        .setBalancesRoot(begin, finalize, paddingSeed)
        .accounts({ crank: ctx.crank.publicKey, config: pdas.config(), balancesRoot: ctx.balancesRoot })
        .remainingAccounts(batches[i].map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false })))
        .instruction();
      await sendAndConfirmIx(ctx.conn, ctx.crank, ix);
    } catch (e) {
      console.error(`set_balances_root batch ${i + 1}/${batches.length} failed:`, String(e));
      return; // a partial cycle leaves a stale root_slot — safe to retry next cycle (begin=true resets it)
    }
  }

  const info = await ctx.conn.getAccountInfo(ctx.balancesRoot, "confirmed");
  if (!info) {
    console.error("root: balances_root account not found after cycle");
    return;
  }
  const root = decodeBalancesRoot(info.data);
  console.log(`root: filled=${root.filled} slot=${root.rootSlot}`);
}

export async function runDisclosureCycle(ctx: DisclosureCtx): Promise<void> {
  // --- (1a) Position candidates: Closed && !commitment_written, and
  // separately Closed && commitment_written (mark_committed candidates below). ---
  const positionAccs = await ctx.conn.getProgramAccounts(ctx.prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: POSITION_DISC } }],
  });
  const decodedPositions = positionAccs
    .map((p) => ({ key: p.pubkey, acc: decodeOrSkip(p.pubkey, p.account.data, () => decodePosition(ctx.prog, p.account.data)) }))
    .filter((p): p is { key: PublicKey; acc: ReturnType<typeof decodePosition> } => p.acc !== null);
  const pendingCommitment = decodedPositions.filter(
    (p) => "closed" in p.acc.state && p.acc.closed !== null && p.acc.closed.commitmentWritten === false,
  );
  const pendingMarkCommitted = decodedPositions.filter(
    (p) => "closed" in p.acc.state && p.acc.closed !== null && p.acc.closed.commitmentWritten === true,
  );

  // --- (1b) DisclosureQueue candidates: at least one due record. ---
  const dqAccs = await ctx.conn.getProgramAccounts(ctx.prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: DQ_DISC } }],
  });
  const slot = BigInt(await ctx.conn.getSlot("confirmed"));
  const dueQueues = dqAccs
    .map((p) => ({ key: p.pubkey, acc: decodeOrSkip(p.pubkey, p.account.data, () => decodeDisclosureQueue(ctx.prog, p.account.data)) }))
    .filter((p): p is { key: PublicKey; acc: ReturnType<typeof decodeDisclosureQueue> } => p.acc !== null)
    .map((p) => ({ ...p, due: dueRecordCount(p.acc, slot) }))
    .filter((p) => p.due > 0);

  // --- (1c) build the <=MAX_ACTIONS_PER_COMMIT candidate list — see the
  // CANDIDATE-SELECTION HEURISTIC comment at the top of this file. ---
  const candidates: { key: PublicKey; actions: number }[] = [];
  for (const p of pendingCommitment) {
    if (candidates.length >= MAX_ACTIONS_PER_COMMIT) break;
    candidates.push({ key: p.key, actions: 1 });
  }
  if (candidates.length < MAX_ACTIONS_PER_COMMIT && dueQueues.length > 0) {
    const room = MAX_ACTIONS_PER_COMMIT - candidates.length;
    candidates.push({ key: dueQueues[0].key, actions: Math.min(room, dueQueues[0].due) });
  }

  // `commit_aggregate` IS the fixed-interval `Pool`+`BalancesRoot` commit
  // (CLAUDE.md: "фіксованим інтервалом батчем, ніколи подієво") — it must run
  // every cycle regardless of whether there are any pending
  // Position/DisclosureQueue candidates, or a quiet window would never carry
  // `runRootCycle`'s freshly computed root to L1. The program's own
  // `actions.is_empty()` branch already handles a zero-candidate call (no
  // post-commit actions attached, `commit(&[pool, balances_root])` still
  // fires). `remaining_accounts` is simply empty in that case.
  const totalActions = candidates.reduce((n, c) => n + c.actions, 0);
  try {
    const config = await accountNs(ctx.feePayerProg).config.fetch(pdas.config());
    const ix = await ctx.feePayerProg.methods
      .commitAggregate()
      .accounts({
        config: pdas.config(),
        payer: ctx.feePayer.publicKey,
        pool: ctx.pool,
        poolLive: ctx.poolLive,
        balancesRoot: ctx.balancesRoot,
        feeEscrow: ctx.feeEscrow,
        magicFeeVault: config.magicFeeVault,
        magicContext: MAGIC_CONTEXT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .remainingAccounts(candidates.map((c) => ({ pubkey: c.key, isWritable: true, isSigner: false })))
      .instruction();
    const sig = await sendAndConfirmIx(ctx.feePayerConn, ctx.feePayer, ix);
    console.log(`commit_aggregate: sig=${sig} actions=${totalActions}`);
  } catch (e) {
    console.error("commit_aggregate failed:", String(e));
    // Final-review finding I-3 (week 3): one poison candidate (undecodable,
    // over budget, or rejected by the program's owner/discriminator checks)
    // must not block the fixed-interval Pool+BalancesRoot commit. Retry once
    // with no remaining accounts so the commit itself still lands this cycle;
    // the candidates are simply re-evaluated next cycle.
    if (candidates.length > 0) {
      try {
        const config = await accountNs(ctx.feePayerProg).config.fetch(pdas.config());
        const bare = await ctx.feePayerProg.methods
          .commitAggregate()
          .accounts({
            config: pdas.config(),
            payer: ctx.feePayer.publicKey,
            pool: ctx.pool,
            poolLive: ctx.poolLive,
            balancesRoot: ctx.balancesRoot,
            feeEscrow: ctx.feeEscrow,
            magicFeeVault: config.magicFeeVault,
            magicContext: MAGIC_CONTEXT_ID,
            magicProgram: MAGIC_PROGRAM_ID,
          })
          .remainingAccounts([])
          .instruction();
        const sig = await sendAndConfirmIx(ctx.feePayerConn, ctx.feePayer, bare);
        console.log(`commit_aggregate: retry without candidates sig=${sig} actions=0`);
      } catch (e2) {
        console.error("commit_aggregate retry (no candidates) failed:", String(e2));
      }
    }
  }

  // --- (2) mark_committed: crank observes the L1 Commitment PDA (the ER
  // cannot read L1 directly — spec §2.4.1) and, once it exists, retires the
  // record into DisclosureQueue and frees the Position back to Empty. ---
  for (const p of pendingMarkCommitted) {
    const owner = new PublicKey(p.acc.owner);
    const nonce = BigInt(p.acc.closed.nonce.toString());
    // Task 8b (ruling 9): Commitment is seeded by commitmentHash(args, salt),
    // not by nonce alone — recompute the hash from the closed record.
    const { args, salt } = argsFromClosedRecord(p.acc.closed);
    const commitmentPda = pdas.commitment(commitmentHash(args, salt));
    let exists: Awaited<ReturnType<Connection["getAccountInfo"]>>;
    try {
      exists = await ctx.baseConn.getAccountInfo(commitmentPda, "confirmed");
    } catch (e) {
      console.error(`mark_committed: base getAccountInfo failed for owner=${owner.toBase58()} nonce=${nonce}:`, String(e));
      continue;
    }
    if (!exists) continue; // not yet propagated to L1 — retry next cycle
    try {
      const ix = await ctx.prog.methods
        .markCommitted()
        .accounts({ crank: ctx.crank.publicKey, config: pdas.config(), position: p.key, dq: pdas.disclosureQueue(owner) })
        .instruction();
      const sig = await sendAndConfirmIx(ctx.conn, ctx.crank, ix);
      console.log(`mark_committed: owner=${owner.toBase58()} nonce=${nonce} sig=${sig}`);
    } catch (e) {
      console.error(`mark_committed failed for owner=${owner.toBase58()} nonce=${nonce}:`, String(e));
    }
  }
}
