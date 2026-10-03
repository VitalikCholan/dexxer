// services/relayer/src/commit.ts
//
// The fixed-interval cycle (spec §2.9.2), run by crank.ts by WALL-CLOCK time:
// `runRootCycle` recomputes the public `BalancesRoot` from every current
// `UserAccount`, then `runCommitCycle` sends `commit_aggregate()` — the one
// commit of the coarse `Pool` snapshot and `BalancesRoot` to L1. Trades are
// not disclosed any more, so the commit carries no actions and no remaining
// accounts. `runIsolated` keeps the steps (and the janitor after them)
// independent of each other; `createCycleRunner` runs the whole cycle
// DETACHED from the tick loop (final review I1) — an L1 close or a commit
// waiting out a confirm timeout must not stop every market's ticks.
import { randomBytes } from "crypto";
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { sendAndConfirmIx } from "../../../tests/er/lib/env.js";
import { ROOT_BATCH, USER_DISC, accountNs, decodeBalancesRoot, pdas } from "../../../tests/er/lib/program.js";
import { envNum } from "./env.js";
import { errorMessage } from "./errors.js";
import { commitAggregateAccounts, setBalancesRootAccounts } from "./ixAccounts.js";
import { PROCESS_SALT, tagOf } from "./logTag.js";

// Min 10 s: a NaN/0 would commit on every loop — commits are billed (spec §2.2) and must stay a fixed-interval batch.
export const COMMIT_INTERVAL_MS = envNum("COMMIT_INTERVAL_MS", 300_000, 10_000);

/** Wall-clock, not a tick count: with several markets one loop takes seconds, and a tick count would stretch the interval with the market count. */
export function commitDue(lastAttemptAt: number | null, now: number, intervalMs: number): boolean {
  return lastAttemptAt === null || now - lastAttemptAt >= intervalMs;
}

export interface CommitCtx {
  /** ER connection authenticated as the crank — reads `UserAccount`s and sends `set_balances_root`. */
  conn: Connection;
  prog: Program;
  crank: Keypair;
  /** ER connection authenticated as `fee_payer` — `commit_aggregate`'s only accepted `payer`. */
  feePayerConn: Connection;
  feePayerProg: Program;
  feePayer: Keypair;
  pool: PublicKey;
  poolLive: PublicKey;
  balancesRoot: PublicKey;
  feeEscrow: PublicKey;
}

export async function runRootCycle(ctx: CommitCtx): Promise<void> {
  const userAccs = await ctx.conn.getProgramAccounts(ctx.prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: USER_DISC } }],
  });
  // Task 8b / Task 8's legacy-layout finding: pre-`exit_salt`/`last_withdraw_slot`
  // `UserAccount`s from weeks 1-2 testing are shorter than the current layout and
  // make the whole `set_balances_root` batch fail (`InvalidLeafAccount`) if included
  // — filter by exact byte length (discriminator + `INIT_SPACE`, from the IDL coder,
  // i.e. `8 + UserAccount::INIT_SPACE`) before building any batch.
  const expectedUserAccountLen = ctx.prog.coder.accounts.size("userAccount"); // camelCased by `new Program(idl)` — see index.ts
  const currentUserAccs = userAccs.filter((u) => {
    const ok = u.account.data.length === expectedUserAccountLen;
    // A tag, not the key: the crank read this over its private TEE token (I5).
    if (!ok) console.log(`skipped legacy UserAccount tag=${tagOf(PROCESS_SALT, u.pubkey)} len=${u.account.data.length}`);
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
        .accounts(setBalancesRootAccounts(ctx.crank.publicKey, ctx.balancesRoot))
        .remainingAccounts(batches[i].map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false })))
        .instruction();
      await sendAndConfirmIx(ctx.conn, ctx.crank, ix);
    } catch (e) {
      // Thrown, not swallowed (final review): `runIsolated` records it in
      // `state.errors` and still runs the commit. A partial cycle leaves a
      // stale root_slot — safe to retry next cycle (begin=true resets it).
      throw new Error(`set_balances_root batch ${i + 1}/${batches.length} failed: ${errorMessage(e)}`);
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

/** `commit_aggregate()` — the fixed-interval commit of the coarse `Pool` snapshot and `BalancesRoot`. No arguments, no remaining accounts: nothing else ever leaves the rollup (spec §2.9.2). */
export async function runCommitCycle(ctx: CommitCtx): Promise<string> {
  const config = await accountNs(ctx.feePayerProg).config.fetch(pdas.config());
  const ix = await ctx.feePayerProg.methods
    .commitAggregate()
    .accounts(
      commitAggregateAccounts({
        payer: ctx.feePayer.publicKey, pool: ctx.pool, poolLive: ctx.poolLive,
        balancesRoot: ctx.balancesRoot, feeEscrow: ctx.feeEscrow, magicFeeVault: config.magicFeeVault,
      }),
    )
    .instruction();
  return sendAndConfirmIx(ctx.feePayerConn, ctx.feePayer, ix);
}

/** The cycle's steps each stand alone: a failed root cycle must not skip the commit, and none of them may stop the crank's ticks. */
export async function runIsolated(steps: [name: string, run: () => Promise<void>][], onError: (name: string, e: unknown) => void): Promise<string[]> {
  const ok: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
      ok.push(name);
    } catch (e) {
      onError(name, e);
    }
  }
  return ok;
}

export interface CycleRunner {
  /** Starts a cycle unless one is in flight; true if it started one. */
  trigger(): boolean;
  busy(): boolean;
  /** `now()` when the cycle in flight started, null when none is (R2's `cycleStuck`). */
  startedAt(): number | null;
  /** Resolves when no cycle is in flight (at once if none is). Never rejects. */
  idle(): Promise<void>;
}

/**
 * The in-flight guard of the detached commit cycle (final review I1). The tick
 * loop calls `trigger()` and does not await it; at most one cycle runs at a
 * time; a cycle's rejection goes to `onError` (never an unhandled rejection)
 * and clears the flag; `idle()` lets shutdown wait for the cycle in flight.
 */
export function createCycleRunner(run: () => Promise<void>, onError: (e: unknown) => void, now: () => number = Date.now): CycleRunner {
  let inFlight: Promise<void> | null = null;
  let startedAt: number | null = null;
  return {
    trigger() {
      if (inFlight) return false;
      startedAt = now();
      let started: Promise<void>;
      try {
        started = run();
      } catch (e) {
        started = Promise.reject(e); // a `run` that throws synchronously is handled like a rejection
      }
      inFlight = started
        .catch(onError)
        .finally(() => {
          inFlight = null;
          startedAt = null;
        });
      return true;
    },
    busy: () => inFlight !== null,
    startedAt: () => startedAt,
    idle: () => inFlight ?? Promise.resolve(),
  };
}
