// services/relayer/src/health.ts
//
// GET /healthz — liveness for Railway's healthcheck (`railway.json`'s
// `healthcheckPath`) and for a human `curl`. 503 when the crank loop has
// gone stale (no successful tick in the last `STALE_MS`) — an uncaught
// throw inside `startCrank` is already impossible (every await in its loop
// is wrapped, see crank.ts), so a stale `lastTickAt` is the actual signal
// something is wedged (stuck TEE auth, RPC outage, etc.) that should make
// Railway restart the container.
//
// Task 7 (eternal scheduler backstop): when `CRANK_ENABLED=false` this
// relayer's own crank loop never starts (`lastTickAt` stays `null`
// forever), so staleness must NOT drive `ok`/503 in that mode — a relayer
// that has deliberately turned its crank off is healthy by definition, not
// wedged. `crankEnabled` (from `index.ts`'s `CRANK_ENABLED` env, default
// `true`) gates the staleness check: `ok = !crankEnabled || !stale`.
//
// `schedulerActive` reports whether the MagicBlock scheduler's own
// `crank_tick` (registered via `scripts/admin/schedule-eternal.ts`) is the
// thing moving `Market` forward, INDEPENDENT of this relayer's crank
// identity — see `marketWatch.ts`'s header comment for exactly what is
// read and why. Per the controller ruling for Task 7, attributing "this
// tick was the scheduler's, not ours" is not attempted (both write the same
// public `Market` account with no per-tick attribution available over
// RPC) — the definition actually implemented is the simple, honest one:
// `schedulerActive = Market changed within SCHEDULER_ACTIVE_WINDOW_MS while
// CRANK_ENABLED=false; otherwise null` (not attributable while our own
// crank could equally be the cause) — see `computeSchedulerActive` below.
//
// `buildHealthPayload` is a pure function (no network, no Express) so it can
// be unit-tested directly with a fake `RelayerState` — see test/health.test.ts.
// `healthRouter` is the thin Express wrapper: it fetches `crankSol`/
// `feePayerSol` via `getBalance`, cached for `BALANCE_CACHE_MS` so repeated
// health-check hits stay cheap, and probes `db` with a trivial query.
//
// `db` is informational only — a database hiccup does not flip the 5xx
// status (only a stale tick does); Railway restarting the relayer container
// would not fix a Postgres outage.

import type { Connection, PublicKey } from "@solana/web3.js";
import express from "express";
import type { Router } from "express";
import type { DbPool } from "./db.js";
import type { RelayerState } from "./crank.js";

export const STALE_MS = 60_000;
const BALANCE_CACHE_MS = 60_000;

/** Task 7: how recent a `Market` change must be to count as "the scheduler is ticking" — see `marketWatch.ts`. */
export const SCHEDULER_ACTIVE_WINDOW_MS = 10_000;

/**
 * Task 7 predicate, kept pure/standalone so it's directly unit-testable
 * (test/health.test.ts) without any Express/RPC plumbing. See this file's
 * header comment for why it returns `null` instead of guessing while our
 * own crank is also enabled.
 */
export function computeSchedulerActive(crankEnabled: boolean, lastMarketChangeAt: number | null, now: number): boolean | null {
  if (crankEnabled) return null;
  if (lastMarketChangeAt === null) return false;
  return now - lastMarketChangeAt < SCHEDULER_ACTIVE_WINDOW_MS;
}

/** Task 5 (indexer) snapshot — zeroed/null when the indexer is disabled or hasn't produced anything yet. */
export interface IndexerSnapshot {
  ticks: number;
  lastTickTs: number | null;
  lastPoolSlot: number | null;
  disclosures: number;
  wsClients: number;
  /** Week-5 Task 5: the ORACLE's `publish_time` of the newest update, epoch ms — `null` when nothing has been decoded yet. */
  lastPublishTimeMs: number | null;
  /** Week-5 Task 5: `now - lastPublishTimeMs > ORACLE_STALE_MS` (indexer/prices.ts's `isStale`) — measured against the oracle's own publish time, not against when this process last received a notification (the TEE pushes one every ER slot regardless of whether the feed changed). `true` (not `false`) when the indexer has never decoded an update at all. */
  oracleStale: boolean;
}

const EMPTY_INDEXER_SNAPSHOT: IndexerSnapshot = {
  ticks: 0,
  lastTickTs: null,
  lastPublishTimeMs: null,
  lastPoolSlot: null,
  disclosures: 0,
  wsClients: 0,
  oracleStale: true,
};

/** Task 6 (sponsor): today's rolling-24h sponsor spend — zeroed when sponsoring is disabled or no Postgres. */
export interface SponsorHealthSnapshot {
  today_sol: number;
  count_today: number;
  /** `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS` (fix: wallet-prepended ComputeBudget ixs, Phantom smoke 24.09) — the ceiling enforced on a sponsored `SetComputeUnitPrice`, 0 when sponsoring is disabled. */
  maxCuPriceMicroLamports: number;
}
const EMPTY_SPONSOR_SNAPSHOT: SponsorHealthSnapshot = { today_sol: 0, count_today: 0, maxCuPriceMicroLamports: 0 };

export interface HealthPayload {
  ok: boolean;
  lastTickAt: number | null;
  lastCommitAt: number | null;
  tick: number;
  crankSol: number | null;
  feePayerSol: number | null;
  /** Task 7: `CRANK_ENABLED` env, default `true`. */
  crankEnabled: boolean;
  /** Task 7: see this file's header comment / `computeSchedulerActive` for the exact definition. */
  schedulerActive: boolean | null;
  db: "ok" | "error";
  /** Week-5 Task 5: `COMMIT_INTERVAL_TICKS` (env, default 300) — how many 1s ticks between one `commit_aggregate`/root/orphan cycle and the next. */
  commitIntervalTicks: number;
  /** Week-5 Task 7: `disclosure.ts`'s `COMMIT_MAX_ACTIONS` (env, default 4, clamped to `[1, MAX_ACTIONS_PER_COMMIT=8]`) — the per-bundle post-commit-action budget the relayer requests, tuned below the program's hard ceiling because the MagicBlock bridge's own action cap is lower (measured, 0xA0000002). */
  commitMaxActions: number;
  indexer: IndexerSnapshot;
  sponsor: SponsorHealthSnapshot;
}

/**
 * Pure: no I/O, so this is what test/health.test.ts exercises directly.
 * `crankEnabled` defaults to `true` and `schedulerActive` to `null` so
 * existing positional call sites (this file's own pre-Task-7 tests) keep
 * their original behavior unchanged.
 */
export function buildHealthPayload(
  state: RelayerState,
  now: number,
  crankSol: number | null,
  feePayerSol: number | null,
  dbStatus: "ok" | "error",
  indexer?: IndexerSnapshot,
  sponsor?: SponsorHealthSnapshot,
  crankEnabled = true,
  schedulerActive: boolean | null = null,
  commitIntervalTicks = 300,
  commitMaxActions = 4,
): HealthPayload {
  const stale = crankEnabled && (state.lastTickAt === null || now - state.lastTickAt > STALE_MS);
  return {
    ok: !stale,
    lastTickAt: state.lastTickAt,
    lastCommitAt: state.lastCommitAt,
    tick: state.tick,
    crankSol,
    feePayerSol,
    crankEnabled,
    schedulerActive,
    db: dbStatus,
    commitIntervalTicks,
    commitMaxActions,
    indexer: indexer ?? EMPTY_INDEXER_SNAPSHOT,
    sponsor: sponsor ?? EMPTY_SPONSOR_SNAPSHOT,
  };
}

export interface HealthDeps {
  state: RelayerState;
  baseConn: Connection;
  crankPubkey: PublicKey;
  feePayerPubkey: PublicKey;
  db: DbPool | null;
  /** Task 7: `CRANK_ENABLED` env, default `true` — see this file's header comment. */
  crankEnabled: boolean;
  /** Task 7: getter (not a value) so `/healthz` always reads `marketWatch.ts`'s live `lastMarketChangeAt` rather than a snapshot captured at router-construction time. Undefined only in tests that don't care about this field. */
  getSchedulerActive?: () => boolean | null;
  /** Task 5: getter (not a value) so `/healthz` always reads the indexer's live counters rather than a snapshot captured at router-construction time. */
  getIndexerSnapshot?: () => IndexerSnapshot;
  /** Task 6: async getter (a Postgres query) for today's sponsor spend/count — undefined when sponsoring is disabled. */
  getSponsorSnapshot?: () => Promise<SponsorHealthSnapshot>;
  /** Week-5 Task 5: `crank.ts`'s `COMMIT_INTERVAL_TICKS`, reported as-is. */
  commitIntervalTicks: number;
  /** Week-5 Task 7: `crank.ts`'s re-exported `COMMIT_MAX_ACTIONS`, reported as-is. */
  commitMaxActions: number;
}

interface BalanceCache {
  at: number;
  crankSol: number | null;
  feePayerSol: number | null;
}

export function healthRouter(deps: HealthDeps): Router {
  const router = express.Router();
  let cache: BalanceCache = { at: 0, crankSol: null, feePayerSol: null };

  router.get("/healthz", async (_req, res) => {
    const now = Date.now();
    if (now - cache.at > BALANCE_CACHE_MS) {
      try {
        const [crankLamports, feePayerLamports] = await Promise.all([
          deps.baseConn.getBalance(deps.crankPubkey, "confirmed"),
          deps.baseConn.getBalance(deps.feePayerPubkey, "confirmed"),
        ]);
        cache = { at: now, crankSol: crankLamports / 1e9, feePayerSol: feePayerLamports / 1e9 };
      } catch (e) {
        console.error("healthz: getBalance failed", String(e));
        cache = { ...cache, at: now }; // keep last-known balances (possibly null on first failure), just refresh the cache timestamp
      }
    }

    let dbStatus: "ok" | "error" = "ok";
    if (deps.db) {
      try {
        await deps.db.query("SELECT 1");
      } catch (e) {
        console.error("healthz: db check failed", String(e));
        dbStatus = "error";
      }
    } else {
      dbStatus = "error"; // no DATABASE_URL configured (local dev without Postgres — see db.ts)
    }

    const sponsor = deps.getSponsorSnapshot ? await deps.getSponsorSnapshot().catch(() => undefined) : undefined;
    const payload = buildHealthPayload(
      deps.state,
      now,
      cache.crankSol,
      cache.feePayerSol,
      dbStatus,
      deps.getIndexerSnapshot?.(),
      sponsor,
      deps.crankEnabled,
      deps.getSchedulerActive?.() ?? null,
      deps.commitIntervalTicks,
      deps.commitMaxActions,
    );
    res.status(payload.ok ? 200 : 503).json(payload);
  });

  return router;
}
