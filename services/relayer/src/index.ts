// services/relayer/src/index.ts
//
// Entrypoint: reads config from env, starts the health endpoint, the crank
// loop (Task 4), and — in later tasks — the indexer (Task 5) and sponsor
// (Task 6). Graceful SIGTERM/SIGINT (see shutdown.ts): tell the crank loop
// to finish its in-flight tick/cycle and stop, WAIT for that to actually
// happen (bounded by a hard-kill timeout), only then close the HTTP server
// and exit — a Railway redeploy's SIGTERM must not kill the loop mid
// `sendRawTransaction`/`confirm` or mid `runRootCycle`/`runDisclosureCycle`.
//
// --- DEXXER_NET=devnet env-forcing, and why this file has almost no static
// imports ---
//
// `tests/er/lib/env.ts` resolves its `NET`/`BASE`/`ER`/`ER_WS` exports from
// `process.env` (falling back to a per-profile default) once, at module
// top-level, the first time ANYTHING imports it — and ES modules only ever
// evaluate a given specifier once (the result is cached for the life of the
// process). So `BASE_RPC`/`ER_RPC`/etc must already be in `process.env`
// *before* env.ts is first imported by anything, anywhere in this process's
// module graph, or `NET`/`BASE`/`ER` lock in to the wrong (local) profile
// permanently.
//
// A static `import` declaration is hoisted above the rest of its module's
// top-level code regardless of where it's textually written, so plain
// top-level statements in THIS file (like the env-forcing block below)
// cannot run before a static import elsewhere in the graph does. That's why
// `keys.ts` and `crank.ts` — both of which transitively import env.ts — are
// loaded with dynamic `await import(...)` below, after the env-forcing
// block runs as an ordinary (non-hoisted) statement. `db.ts` and
// `health.ts` don't touch env.ts, so they stay plain static imports.
// (Same pattern scripts/crank-fallback/index.ts used before this move.)

import express from "express";
import { Connection } from "@solana/web3.js";
import { createPool, getMeta, migrate, setMeta } from "./db.js";
import { healthRouter } from "./health.js";
import { shutdown } from "./shutdown.js";
import type { RelayerConfig, RelayerState } from "./crank.js";
import { attachWs, indexerRouter } from "./indexer/http.js";
import type { IndexerStats } from "./indexer/accounts.js";
import { ORACLE_STALE_MS, isStale } from "./indexer/prices.js";
import { DEFAULT_DAILY_BUDGET_SOL, pgSponsorStore, simulateCostEstimator, sponsorRouter, sponsorSnapshot } from "./sponsor.js";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { keypairFromEnv } = await import("./keys.js");
const { startCrank, requestStop } = await import("./crank.js");
const { NET, BASE, ER, ER_WS } = await import("../../../tests/er/lib/env.js");

const cfg: RelayerConfig = {
  net: NET,
  baseRpc: BASE,
  erRpc: ER,
  erWs: ER_WS,
  crank: keypairFromEnv("CRANK_KEY_B58", NET === "devnet" ? "devnet-crank" : "admin"),
  // `commit_aggregate`'s `payer` must equal `Config.fee_payer` exactly —
  // locally that's `admin` (see tests/er/lib/admin.ts's `init_config`
  // call), on devnet the dedicated `devnet-fee-payer` identity.
  feePayer: keypairFromEnv("FEE_PAYER_KEY_B58", NET === "devnet" ? "devnet-fee-payer" : "admin"),
  port: Number(process.env.PORT ?? 8080),
  indexerEnabled: process.env.INDEXER_ENABLED === "true",
  sponsorEnabled: process.env.SPONSOR_ENABLED === "true",
  databaseUrl: process.env.DATABASE_URL,
};
const sponsorDailyBudgetSol = Number(process.env.SPONSOR_DAILY_SOL ?? DEFAULT_DAILY_BUDGET_SOL);

const state: RelayerState = { lastTickAt: null, lastCommitAt: null, tick: 0, errors: [] };

const pool = createPool(cfg.databaseUrl);
await migrate(pool);
if (pool) {
  try {
    const lastTickAt = await getMeta(pool, "lastTickAt");
    const lastCommitAt = await getMeta(pool, "lastCommitAt");
    if (lastTickAt) state.lastTickAt = Number(lastTickAt);
    if (lastCommitAt) state.lastCommitAt = Number(lastCommitAt);
    console.log("index: restored persisted state", { lastTickAt: state.lastTickAt, lastCommitAt: state.lastCommitAt });
  } catch (e) {
    console.error("index: failed to load persisted state from db", String(e));
  }
  // Best-effort periodic persistence — not on crank.ts's hot path (a
  // Postgres round-trip inside the 1s tick loop would eat into its
  // cadence), never awaited by the tick loop itself.
  setInterval(() => {
    const writes: Promise<void>[] = [];
    if (state.lastTickAt !== null) writes.push(setMeta(pool, "lastTickAt", String(state.lastTickAt)));
    if (state.lastCommitAt !== null) writes.push(setMeta(pool, "lastCommitAt", String(state.lastCommitAt)));
    void Promise.all(writes).catch((e) => console.error("index: persistState failed", String(e)));
  }, 5000).unref();
}

const app = express();

const server = app.listen(cfg.port, () => {
  console.log(`relayer: listening on :${cfg.port} net=${cfg.net}`);
});

// Task 5: public-data indexer (oracle candles, Pool/BalancesRoot snapshots,
// Disclosure feed) — needs Postgres (`pool`) and `INDEXER_ENABLED=true`.
// Reads ONLY public accounts (see indexer/accounts.ts's header comment) —
// never `cfg.crank`/`cfg.feePayer`.
const indexerStats: IndexerStats = { ticks: 0, lastTickTs: null, lastPoolSlot: null, disclosures: 0 };
let wsHub: ReturnType<typeof attachWs> | null = null;
let stopIndexer: (() => void) | null = null;
if (cfg.indexerEnabled && !pool) {
  console.warn("indexer: INDEXER_ENABLED=true but no DATABASE_URL — indexer disabled (needs Postgres)");
} else if (cfg.indexerEnabled && pool) {
  wsHub = attachWs(server);
  app.use(indexerRouter(pool));
  try {
    const { startIndexer } = await import("./indexer/accounts.js");
    const hub = wsHub;
    stopIndexer = startIndexer({ pool, stats: indexerStats, broadcast: (msg) => hub.broadcast(msg) });
    console.log("indexer: started (oracle candles, Pool/BalancesRoot snapshots, Disclosure feed, /ws)");
  } catch (e) {
    // Fix round 1 (code review): the indexer is a best-effort add-on — a
    // failure starting its subscriptions (bad IDL path, RPC unreachable at
    // boot, etc.) must never take the crank loop down with it.
    console.error("indexer: failed to start, continuing without it", String(e));
  }
}

const baseConn = new Connection(cfg.baseRpc, "confirmed");

// Task 6: `/sponsor` — fee_payer co-signs whitelisted onboarding txs (see
// sponsor.ts's header comment). Needs Postgres for the rate-limit/budget
// store, same gating pattern as the indexer above.
let getSponsorHealthSnapshot: (() => Promise<{ today_sol: number; count_today: number }>) | undefined;
if (cfg.sponsorEnabled && !pool) {
  console.warn("sponsor: SPONSOR_ENABLED=true but no DATABASE_URL — /sponsor disabled (needs Postgres for the rate-limit store)");
} else if (cfg.sponsorEnabled && pool) {
  const store = pgSponsorStore(pool);
  app.use(
    sponsorRouter({
      feePayer: cfg.feePayer,
      store,
      estimateLamports: simulateCostEstimator(baseConn, cfg.feePayer),
      dailyBudgetSol: sponsorDailyBudgetSol,
    }),
  );
  getSponsorHealthSnapshot = sponsorSnapshot(store);
  console.log(`sponsor: /sponsor enabled (daily budget ${sponsorDailyBudgetSol} SOL)`);
}

app.use(
  healthRouter({
    state,
    baseConn,
    crankPubkey: cfg.crank.publicKey,
    feePayerPubkey: cfg.feePayer.publicKey,
    db: pool,
    getIndexerSnapshot: () => ({
      ...indexerStats,
      wsClients: wsHub?.clientCount() ?? 0,
      oracleStale: isStale(indexerStats.lastTickTs, Date.now(), ORACLE_STALE_MS),
    }),
    getSponsorSnapshot: getSponsorHealthSnapshot,
  }),
);

// Kept as a reference (not just `.catch()`ed and discarded): `shutdown()`
// below awaits this to know the loop has actually stopped. `.catch()` here
// makes `crankDone` itself never reject — a crash still logs/records into
// `state.errors` exactly as before, it just also resolves so shutdown never
// hangs on a promise that rejected instead of resolving.
const crankDone: Promise<void> = startCrank(cfg, state).catch((e) => {
  console.error("relayer: crank loop crashed", e);
  state.errors.push(String(e instanceof Error ? e.message : e));
});

let shuttingDown = false;
function handleSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopIndexer?.();
  wsHub?.close();
  void shutdown(signal, {
    requestStop,
    crankDone,
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
  });
}
process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));
