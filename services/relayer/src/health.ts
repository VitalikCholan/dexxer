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

/** Task 5 (indexer) snapshot — zeroed/null when the indexer is disabled or hasn't produced anything yet. */
export interface IndexerSnapshot {
  ticks: number;
  lastTickTs: number | null;
  lastPoolSlot: number | null;
  disclosures: number;
  wsClients: number;
  /** Fix round 1 (code review): `now - lastTickTs > ORACLE_STALE_MS` (indexer/prices.ts's `isStale`) — the base-layer feed copy is a stale commit snapshot, not a live fallback, so this must be surfaced rather than silently serving old prices. `true` (not `false`) when the indexer has never ticked at all. */
  oracleStale: boolean;
}

const EMPTY_INDEXER_SNAPSHOT: IndexerSnapshot = { ticks: 0, lastTickTs: null, lastPoolSlot: null, disclosures: 0, wsClients: 0, oracleStale: true };

/** Task 6 (sponsor): today's rolling-24h sponsor spend — zeroed when sponsoring is disabled or no Postgres. */
export interface SponsorHealthSnapshot {
  today_sol: number;
  count_today: number;
}
const EMPTY_SPONSOR_SNAPSHOT: SponsorHealthSnapshot = { today_sol: 0, count_today: 0 };

export interface HealthPayload {
  ok: boolean;
  lastTickAt: number | null;
  lastCommitAt: number | null;
  tick: number;
  crankSol: number | null;
  feePayerSol: number | null;
  /** Task 7 wires the scheduler up; always false until then. */
  schedulerActive: boolean;
  db: "ok" | "error";
  indexer: IndexerSnapshot;
  sponsor: SponsorHealthSnapshot;
}

/** Pure: no I/O, so this is what test/health.test.ts exercises directly. */
export function buildHealthPayload(
  state: RelayerState,
  now: number,
  crankSol: number | null,
  feePayerSol: number | null,
  dbStatus: "ok" | "error",
  indexer?: IndexerSnapshot,
  sponsor?: SponsorHealthSnapshot,
): HealthPayload {
  const stale = state.lastTickAt === null || now - state.lastTickAt > STALE_MS;
  return {
    ok: !stale,
    lastTickAt: state.lastTickAt,
    lastCommitAt: state.lastCommitAt,
    tick: state.tick,
    crankSol,
    feePayerSol,
    schedulerActive: false,
    db: dbStatus,
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
  /** Task 5: getter (not a value) so `/healthz` always reads the indexer's live counters rather than a snapshot captured at router-construction time. */
  getIndexerSnapshot?: () => IndexerSnapshot;
  /** Task 6: async getter (a Postgres query) for today's sponsor spend/count — undefined when sponsoring is disabled. */
  getSponsorSnapshot?: () => Promise<SponsorHealthSnapshot>;
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
    const payload = buildHealthPayload(deps.state, now, cache.crankSol, cache.feePayerSol, dbStatus, deps.getIndexerSnapshot?.(), sponsor);
    res.status(payload.ok ? 200 : 503).json(payload);
  });

  return router;
}
