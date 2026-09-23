// services/relayer/src/disclosure.ts
//
// Moved from scripts/crank-fallback/disclosure.ts (Task 4, week 4) — no
// logic changes, only the relative import paths below (one directory
// deeper: services/relayer/src/ vs scripts/crank-fallback/).
//
// Week 3 (Task 7): the two cycles that ride on top of the crank tick loop
// (crank.ts) every `COMMIT_INTERVAL_TICKS` — root BEFORE disclosure, so a
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
// `runDisclosureCycle`: finds every `DisclosureQueue` with outstanding work
// and hands them to a single `commit_aggregate` call (signed by
// `Config.fee_payer`). Since week-5 Task 1 a close pushes its `ClosedRecord`
// straight into the owner's ring, so the queue is the ONLY candidate kind:
// `commit_aggregate` schedules a `write_commitment` for every record that
// has not been committed yet and a `write_disclosure` for every record that
// is both committed and past its reveal slot, in that order, inside one
// bundle. The old `Position`-candidate scan and the `mark_committed`
// follow-up (which needed the crank to observe the L1 `Commitment` first)
// are gone with it.
//
// `commit_aggregate` IS the fixed-interval `Pool`+`BalancesRoot` commit
// (CLAUDE.md: "фіксованим інтервалом батчем, ніколи подієво") — it is called
// EVERY cycle, even with zero candidates (`remaining_accounts` empty), so a
// quiet window still lands `runRootCycle`'s freshly computed root on L1. The
// program's own `actions.is_empty()` branch already handles that case.
//
// CANDIDATE SELECTION: each queue is added while the running action estimate
// is under `MAX_ACTIONS_PER_COMMIT` (8). The estimate is only a hint — the
// program clamps every candidate to the budget actually left
// (`pending_commitments`/`due_reveals`'s `room`), so an over-estimate costs
// a deferred action, never a failed bundle.

import { randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import {
  DQ_DISC,
  MAX_ACTIONS_PER_COMMIT,
  ROOT_BATCH,
  USER_DISC,
  accountNs,
  decodeBalancesRoot,
  pdas,
} from "../../../tests/er/lib/program.js";

export interface DisclosureCtx {
  /** Crank-authenticated ER connection: reads the private `DisclosureQueue`/`UserAccount` accounts via `getProgramAccounts`, and signs `set_balances_root`. */
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

/**
 * How many post-commit actions `commit_aggregate` would schedule for `dq` at
 * `slot`: one `write_commitment` per not-yet-committed record, plus one
 * `write_disclosure` per record that is already committed and due. Mirrors
 * `pending_commitments`/`due_reveals`'s selection without mutating — and
 * deliberately does NOT count the disclosure a commitment scheduled in this
 * same bundle unlocks, since the program only reaches it if budget is left.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pendingActionCount(dq: any, slot: bigint): number {
  const cap = dq.records.length as number;
  let actions = 0;
  for (let i = 0; i < dq.len; i++) {
    const rec = dq.records[(dq.head + i) % cap];
    if (!rec.commitmentWritten) actions++;
    else if (BigInt(rec.revealAfterSlot.toString()) <= slot) actions++;
  }
  return actions;
}

/**
 * `closed_slot` of the OLDEST record that still owes L1 something — the
 * fairness key (week-5 Task 1 review, minor 8). Without an ordering, the
 * queues come back in whatever order `getProgramAccounts` returns them and a
 * single trader with a full ring (`DQ_CAPACITY` records, more than one
 * bundle's worth of actions) can take the whole `MAX_ACTIONS_PER_COMMIT`
 * budget every cycle forever, so a trader who closed one position behind
 * them never gets committed at all. Serving the oldest debt first bounds
 * every queue's wait by the number of queues ahead of it.
 *
 * `Number.MAX_SAFE_INTEGER` for a queue with nothing pending — it is
 * filtered out before the sort anyway, this only keeps the comparator total.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function oldestPendingSlot(dq: any, slot: bigint): number {
  const cap = dq.records.length as number;
  for (let i = 0; i < dq.len; i++) {
    const rec = dq.records[(dq.head + i) % cap];
    const due = !rec.commitmentWritten || BigInt(rec.revealAfterSlot.toString()) <= slot;
    // The ring is in close order, so the first pending record IS the oldest.
    if (due) return Number(rec.closedSlot.toString());
  }
  return Number.MAX_SAFE_INTEGER;
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
  // --- (1) DisclosureQueue candidates: every queue with at least one record
  // that still owes L1 a commitment or a (due) disclosure. Since week-5 Task 1
  // this is the only candidate kind `commit_aggregate` accepts. ---
  const dqAccs = await ctx.conn.getProgramAccounts(ctx.prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: DQ_DISC } }],
  });
  // `ctx.conn` is the ER connection, and `reveal_after_slot` is an ER slot
  // (~80/s, vs ~2.5/s on base — measured, week-5 Task 4): reading the slot
  // off base here would make every reveal look due decades early.
  const slot = BigInt(await ctx.conn.getSlot("confirmed"));
  const pendingQueues = dqAccs
    .map((p) => ({ key: p.pubkey, acc: decodeOrSkip(p.pubkey, p.account.data, () => decodeDisclosureQueue(ctx.prog, p.account.data)) }))
    .filter((p): p is { key: PublicKey; acc: ReturnType<typeof decodeDisclosureQueue> } => p.acc !== null)
    .map((p) => ({ ...p, actions: pendingActionCount(p.acc, slot), oldest: oldestPendingSlot(p.acc, slot) }))
    .filter((p) => p.actions > 0)
    // Oldest debt first — see `oldestPendingSlot`. Ties (two closes in the
    // same slot) fall back to the pubkey so the order is at least stable
    // across cycles rather than RPC-order-dependent.
    .sort((a, b) => a.oldest - b.oldest || a.key.toBase58().localeCompare(b.key.toBase58()));

  // --- (2) fill the bundle up to MAX_ACTIONS_PER_COMMIT — see the CANDIDATE
  // SELECTION comment at the top of this file. ---
  const candidates: { key: PublicKey; actions: number }[] = [];
  let budget = MAX_ACTIONS_PER_COMMIT;
  for (const q of pendingQueues) {
    if (budget <= 0) break;
    const actions = Math.min(budget, q.actions);
    candidates.push({ key: q.key, actions });
    budget -= actions;
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
}
