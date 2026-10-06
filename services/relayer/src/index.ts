// services/relayer/src/index.ts
//
// Entrypoint: reads config from env, starts the health endpoint, the crank
// loop (Task 4), and — in later tasks — the indexer (Task 5) and sponsor
// (Task 6). Graceful SIGTERM/SIGINT (see shutdown.ts): tell the crank loop
// to finish its in-flight tick/cycle and stop, WAIT for that to actually
// happen (bounded by a hard-kill timeout), only then close the HTTP server
// and exit — a Railway redeploy's SIGTERM must not kill the loop mid
// `sendRawTransaction`/`confirm` or mid `runRootCycle`/`runCommitCycle`.
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
import { Connection, PublicKey } from "@solana/web3.js";

type PublicKeyT = InstanceType<typeof PublicKey>;
import { createPool, getMeta, migrate, setMeta } from "./db.js";
import { buildMarketsHealth, computeSchedulerActive, createHealthCollector, healthRouter, type HealthDeps } from "./health.js";
import { shutdown } from "./shutdown.js";
import { envNum } from "./env.js";
import type { RelayerConfig, RelayerState } from "./crank.js";
import { attachWs, indexerRouter } from "./indexer/http.js";
import type { IndexerStats } from "./indexer/accounts.js";
import { ORACLE_STALE_MS, isStale } from "./indexer/prices.js";
import { DEFAULT_ASSETLINKS_PACKAGE, assetlinksRouter, parseFingerprintsEnv } from "./assetlinks.js";
import { nonceRouter } from "./nonce.js";
import { DEFAULT_SESSION_TTL_HOURS, authRouter, pgAuthStore } from "./auth.js";
import { parseAllowlist } from "./betaAccess.js";
import { feedbackRouter, pgFeedbackStore, type FeedbackStore, type Notifier } from "./feedback.js";
import { CRASH_WINDOW_MS, DEFAULT_ALERT_THRESHOLDS, consoleNotifier, startAlerts, telegramNotifier } from "./alerts.js";
import { metricsRouter } from "./metrics.js";
import {
  DEFAULT_DAILY_BUDGET_SOL,
  DEFAULT_SPONSOR_MAX_CU_PRICE_MICROLAMPORTS,
  pgSponsorStore,
  simulateCostEstimator,
  sponsorRouter,
  sponsorSnapshot,
} from "./sponsor.js";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { keypairFromEnv } = await import("./keys.js");
const { startCrank, requestStop, withSol } = await import("./crank.js");
const { COMMIT_INTERVAL_MS } = await import("./commit.js");
const { NET, BASE, ER, ER_WS, teeConn } = await import("../../../tests/er/lib/env.js");
const { accountNs, dexxerCoreProgram, pdas } = await import("../../../tests/er/lib/program.js");
const { startMarketWatch } = await import("./marketWatch.js");

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
// Fix (live Phantom smoke, 24.09): Phantom prepends ComputeBudget ixs to
// legacy transactions it signs — see sponsor.ts's DEFAULT_SPONSOR_MAX_CU_PRICE_MICROLAMPORTS doc comment for the bound this caps.
const sponsorMaxCuPriceMicroLamports = Number(process.env.SPONSOR_MAX_CU_PRICE_MICROLAMPORTS ?? DEFAULT_SPONSOR_MAX_CU_PRICE_MICROLAMPORTS);
// Week 6 (spec §2.7): SIWS sessions gate /sponsor and /nonce. SIWS_DOMAIN is
// the app's MWA identity domain (IDENTITY_DOMAIN — today the relayer's own
// host); without it the gate cannot verify anything, so the write endpoints
// stay unmounted (fail-closed) rather than silently open.
const siwsDomain = process.env.SIWS_DOMAIN?.trim() || null;
const authSessionTtlHours = Number(process.env.AUTH_SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
const authSessionTtlMs =
  (Number.isFinite(authSessionTtlHours) && authSessionTtlHours > 0 ? authSessionTtlHours : DEFAULT_SESSION_TTL_HOURS) * 60 * 60 * 1000;
// Task 7: default true so this is a no-op change for every existing
// deployment — set `CRANK_ENABLED=false` only to measure the MagicBlock
// scheduler's own `crank_tick` (schedule-eternal.ts) as the SOLE thing
// keeping Market ticking, without this relayer's own 1s loop competing.
const crankEnabled = process.env.CRANK_ENABLED !== "false";

const state: RelayerState = { lastTickAt: null, lastCommitAt: null, tick: 0, errors: [], marketTicks: {} };

const pool = createPool(cfg.databaseUrl);
await migrate(pool);
if (pool) {
  // Final review I2: only `lastCommitAt` is restored (informational). The
  // health gate's `lastTickAt` always starts `null` in a new process, so
  // `/healthz.ok` is false until THIS process ticked SOL after a good
  // discovery — a restored value would report a dead process healthy for up
  // to `STALE_MS`. For the same reason `lastTickAt` is no longer persisted
  // (nothing reads it back); the `meta` row an older relayer wrote stays as
  // it is.
  try {
    const lastCommitAt = await getMeta(pool, "lastCommitAt");
    if (lastCommitAt) state.lastCommitAt = Number(lastCommitAt);
    console.log("index: restored persisted state", { lastCommitAt: state.lastCommitAt });
  } catch (e) {
    console.error("index: failed to load persisted state from db", String(e));
  }
  // Best-effort periodic persistence — not on crank.ts's hot path (a
  // Postgres round-trip inside the 1s tick loop would eat into its
  // cadence), never awaited by the tick loop itself.
  setInterval(() => {
    if (state.lastCommitAt === null) return;
    void setMeta(pool, "lastCommitAt", String(state.lastCommitAt)).catch((e) => console.error("index: persistState failed", String(e)));
  }, 5000).unref();
}

const app = express();
// Railway's edge proxy is the one hop in front of us: `req.ip` is then the
// client's address (X-Forwarded-For), which `/feedback` rate-limits on.
app.set("trust proxy", 1);
// Digital Asset Links for MWA identity verification (see assetlinks.ts).
// Mounted first: static, key-free, must answer even if every loop below is off.
app.use(
  assetlinksRouter({
    packageName: process.env.ASSETLINKS_PACKAGE ?? DEFAULT_ASSETLINKS_PACKAGE,
    fingerprints: parseFingerprintsEnv(process.env.ASSETLINKS_SHA256_FINGERPRINTS),
  }),
);

// Token information (`/assets/:symbol`): public market data from CoinGecko plus
// static text from the repo; no keys, no Postgres, no trader data — mounted
// unconditionally (ASSETS_ENABLED=false turns it off).
if (process.env.ASSETS_ENABLED !== "false") {
  const { loadStaticAssets } = await import("./assets/staticAssets.js");
  const { createAssetService } = await import("./assets/service.js");
  const { assetsRouter } = await import("./assets/http.js");
  const assets = createAssetService({
    assets: loadStaticAssets(),
    ttlMs: envNum("ASSETS_CACHE_MS", 10 * 60_000, 60_000),
    apiKey: process.env.COINGECKO_API_KEY || undefined,
  });
  app.use(assetsRouter(assets));
  console.log(`assets: /assets/:symbol for ${assets.symbols().join(", ")}`);
}

const server = app.listen(cfg.port, () => {
  console.log(`relayer: listening on :${cfg.port} net=${cfg.net}`);
});

// Plan 2 (Task 5): the market registry (markets.ts) — every `Market` in the
// ER, public unauthenticated read, refreshed every MARKETS_REFRESH_MS. One
// awaited refresh before the crank and the indexer start (hence it sits above
// the indexer block) so both already see every market; if it fails the list
// stays empty — the crank still ticks SOL (crank.ts's `withSol`) and the
// indexer indexes SOL on its known feed (accounts.ts's `reconcile`) until a
// later refresh brings the rest.
//
// Final review F2: a market is listed only once its `MarketRisk` permission
// PDA is owned by the Permission Program (markets.ts `keepPrivateMarkets`).
// That owner read goes over a CRANK-authenticated TEE connection: the crank
// is a member of every `MarketRisk` permission (`[crank, admin]`), so it is
// certain to see the permission account. This does not bend the "servers
// read only public data" rule — only the ACCOUNT OWNER of the permission PDA
// is read, never `MarketRisk` data, and nothing of it is served. The
// connection is created lazily and dropped after any error, so a stale
// token heals on the next refresh; the `Market` read itself stays
// unauthenticated.
let permissionOwnerConn: Connection | null = null;
const readPermissionOwners = async (keys: PublicKeyT[]): Promise<(PublicKeyT | null)[]> => {
  try {
    permissionOwnerConn ??= await teeConn(cfg.crank);
    const out: (PublicKeyT | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const infos = await permissionOwnerConn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed");
      out.push(...infos.map((a) => a?.owner ?? null));
    }
    return out;
  } catch (e) {
    permissionOwnerConn = null;
    throw e;
  }
};
const { createMarketRegistry, loadMarketsFromEr } = await import("./markets.js");
const markets = createMarketRegistry({ load: loadMarketsFromEr(cfg.erRpc, readPermissionOwners) });
await markets.refresh();
markets.start();

// Task 5: public-data indexer (oracle candles per market, Pool/BalancesRoot
// snapshots) — needs Postgres (`pool`) and `INDEXER_ENABLED=true`.
// Reads ONLY public accounts (see indexer/accounts.ts's header comment) —
// never `cfg.crank`/`cfg.feePayer`.
const indexerStats: IndexerStats = { ticks: 0, lastTickTs: null, lastPublishTimeMs: null, lastPoolSlot: null, feeds: {} };
let wsHub: ReturnType<typeof attachWs> | null = null;
let stopIndexer: (() => void) | null = null;
let stopRetention: (() => void) | null = null;
let backfill: { snapshot: () => import("./indexer/backfill.js").BackfillSnapshot; stop: () => void } | null = null;
if (cfg.indexerEnabled && !pool) {
  console.warn("indexer: INDEXER_ENABLED=true but no DATABASE_URL — indexer disabled (needs Postgres)");
} else if (cfg.indexerEnabled && pool) {
  wsHub = attachWs(server);
  let assetNames = new Map<string, string>();
  try {
    const { loadStaticAssets } = await import("./assets/staticAssets.js");
    assetNames = new Map([...loadStaticAssets()].map(([sym, a]) => [sym, a.name]));
  } catch (e) {
    console.warn(`indexer: assets.json unreadable, /markets names are null: ${(e as Error).message}`);
  }
  app.use(
    indexerRouter(pool, {
      markets: () => markets.list(),
      names: (s) => assetNames.get(s) ?? null,
      tickersCacheMs: envNum("TICKERS_CACHE_MS", 30_000, 5_000),
    }),
  );
  try {
    const { startIndexer } = await import("./indexer/accounts.js");
    const hub = wsHub;
    stopIndexer = startIndexer({ pool, stats: indexerStats, broadcast: (msg) => hub.broadcast(msg), markets: () => markets.list() });
    console.log("indexer: started (oracle candles per market, Pool/BalancesRoot snapshots, /ws)");
    const { startRetention, TICKS_RETENTION_MS } = await import("./indexer/retention.js");
    stopRetention = startRetention(pool, { intervalMs: COMMIT_INTERVAL_MS });
    console.log(`retention: ticks older than ${TICKS_RETENTION_MS} ms deleted every ${COMMIT_INTERVAL_MS} ms`);
    const { startBackfill, backfillEnvFromProcess } = await import("./indexer/backfill.js");
    // SOL even while the registry is empty (boot-time refresh failed) — the same `withSol` view the crank ticks.
    backfill = startBackfill({
      pool,
      env: backfillEnvFromProcess(),
      markets: () => withSol(markets.list().map((m) => ({ symbol: m.symbol })), () => ({ symbol: "SOL" })),
      fetch: globalThis.fetch.bind(globalThis),
    });
  } catch (e) {
    // Fix round 1 (code review): the indexer is a best-effort add-on — a
    // failure starting its subscriptions (bad IDL path, RPC unreachable at
    // boot, etc.) must never take the crank loop down with it.
    console.error("indexer: failed to start, continuing without it", String(e));
  }
}

const baseConn = new Connection(cfg.baseRpc, "confirmed");

// Closed beta (06.10.2026): one notifier for alerts and new reports — Telegram
// when ALERT_TELEGRAM_BOT_TOKEN/ALERT_TELEGRAM_CHAT_ID are set, the log
// otherwise. BETA_ALLOWLIST limits relayer sessions (and with them sponsored
// onboarding) to the invited wallets — see betaAccess.ts.
const telegram =
  process.env.ALERT_TELEGRAM_BOT_TOKEN && process.env.ALERT_TELEGRAM_CHAT_ID
    ? telegramNotifier(process.env.ALERT_TELEGRAM_BOT_TOKEN, process.env.ALERT_TELEGRAM_CHAT_ID)
    : null;
const notifier: Notifier = telegram ?? consoleNotifier;
const betaAllowlist = parseAllowlist(process.env.BETA_ALLOWLIST, (bad) => console.warn(`auth: BETA_ALLOWLIST entry is not a public key, skipped: ${bad}`));

// In-app bug and crash reports (feedback.ts): needs Postgres. The admin read
// API is mounted only with FEEDBACK_ADMIN_TOKEN.
let feedbackStore: FeedbackStore | null = null;
if (process.env.FEEDBACK_ENABLED !== "false" && pool) {
  feedbackStore = pgFeedbackStore(pool);
  app.use(
    feedbackRouter({
      store: feedbackStore,
      authStore: pgAuthStore(pool),
      notifier: telegram ?? undefined,
      adminToken: process.env.FEEDBACK_ADMIN_TOKEN?.trim() || undefined,
      ipSalt: process.env.FEEDBACK_IP_SALT || undefined,
    }),
  );
  console.log(`feedback: POST /feedback enabled${process.env.FEEDBACK_ADMIN_TOKEN ? ", admin API on" : " (no FEEDBACK_ADMIN_TOKEN — admin API off)"}${telegram ? ", Telegram notices on" : ""}`);
} else if (process.env.FEEDBACK_ENABLED !== "false") {
  console.warn("feedback: no DATABASE_URL — /feedback disabled (needs Postgres)");
}

// Task 6: `/sponsor` — fee_payer co-signs whitelisted onboarding txs (see
// sponsor.ts's header comment). Needs Postgres for the rate-limit/budget
// store, same gating pattern as the indexer above.
let getSponsorHealthSnapshot: (() => Promise<{ today_sol: number; count_today: number; maxCuPriceMicroLamports: number }>) | undefined;
if (cfg.sponsorEnabled && !pool) {
  console.warn("sponsor: SPONSOR_ENABLED=true but no DATABASE_URL — /sponsor disabled (needs Postgres for the rate-limit store)");
} else if (cfg.sponsorEnabled && pool && !siwsDomain) {
  console.error("sponsor: SPONSOR_ENABLED=true but SIWS_DOMAIN is not set — /auth, /sponsor and /nonce NOT mounted (fail-closed, spec §2.7)");
} else if (cfg.sponsorEnabled && pool && siwsDomain) {
  const store = pgSponsorStore(pool);
  const authStore = pgAuthStore(pool);
  app.use(authRouter({ store: authStore, domain: siwsDomain, sessionTtlMs: authSessionTtlMs, allowlist: betaAllowlist }));
  if (betaAllowlist) console.log(`auth: closed beta — sessions only for ${betaAllowlist.size} allowlisted wallet(s) (BETA_ALLOWLIST)`);
  // Week-5 final review M2: the only mint a sponsored ATA may be created for.
  // Read once at boot from the public base `Config` (no secret involved, same
  // source crank.ts uses for the `Pool` PDAs). If this read fails the endpoint
  // still starts, but every ATA instruction is then rejected (fail-closed in
  // `checkPositions`) — a loud, recoverable state, not a silent drain hole.
  let dusdcMint: PublicKeyT | undefined;
  try {
    const cfgAcc = await accountNs(dexxerCoreProgram(baseConn, cfg.feePayer)).config.fetch(pdas.config());
    dusdcMint = cfgAcc.dusdcMint as PublicKeyT;
  } catch (e) {
    console.error("sponsor: could not read Config.dusdcMint from base — ATA sponsoring will be refused", String(e));
  }
  app.use(
    sponsorRouter({
      feePayer: cfg.feePayer,
      store,
      estimateLamports: simulateCostEstimator(baseConn, cfg.feePayer),
      dailyBudgetSol: sponsorDailyBudgetSol,
      dusdcMint,
      maxCuPriceMicroLamports: sponsorMaxCuPriceMicroLamports,
      authStore,
    }),
  );
  // Durable-nonce accounts for owners (nonce.ts) — same store/rate limit/budget as /sponsor.
  app.use(
    nonceRouter({
      conn: baseConn,
      feePayer: cfg.feePayer,
      store,
      dailyBudgetLamports: Math.round(sponsorDailyBudgetSol * 1e9),
      authStore,
    }),
  );
  getSponsorHealthSnapshot = sponsorSnapshot(store, sponsorMaxCuPriceMicroLamports);
  console.log(
    `sponsor: /sponsor enabled (daily budget ${sponsorDailyBudgetSol} SOL, dUSDC mint ${dusdcMint ? dusdcMint.toBase58() : "UNKNOWN — ATA refused"}, max CU price ${sponsorMaxCuPriceMicroLamports} µL, SIWS domain ${siwsDomain}, session TTL ${authSessionTtlMs / 3_600_000} h)`,
  );
}

// Task 7: watches the public `Market` account (unauthenticated ER read, see
// marketWatch.ts's header comment) regardless of `crankEnabled` — this is
// what lets `/healthz` prove the scheduler is ticking `Market` on its own
// when `CRANK_ENABLED=false`.
let lastMarketChangeAt: number | null = null;
const marketPda = pdas.market();
const stopMarketWatch = startMarketWatch(cfg.erRpc, marketPda, (now) => {
  lastMarketChangeAt = now;
});
console.log(`marketWatch: watching ${marketPda.toBase58()} on ${cfg.erRpc} (unauthenticated, public read)`);

const healthDeps: HealthDeps = {
  getBackfillSnapshot: () => backfill?.snapshot() ?? { enabled: false, lastRunAt: null, lastOkAt: null, lastError: null, rows: 0, source: "hyperliquid" as const },
  state,
  baseConn,
  crankPubkey: cfg.crank.publicKey,
  feePayerPubkey: cfg.feePayer.publicKey,
  db: pool,
  crankEnabled,
  getSchedulerActive: () => computeSchedulerActive(crankEnabled, lastMarketChangeAt, Date.now()),
  getIndexerSnapshot: () => ({
    ...indexerStats,
    wsClients: wsHub?.clientCount() ?? 0,
    // Week-5 Task 5: by the oracle's own publish time, not by when this
    // process last received a notification — see indexer/prices.ts.
    oracleStale: isStale(indexerStats.lastPublishTimeMs, Date.now(), ORACLE_STALE_MS),
  }),
  getSponsorSnapshot: getSponsorHealthSnapshot,
  commitIntervalMs: COMMIT_INTERVAL_MS,
  // The same view the crank ticks (`withSol`): SOL is listed even while the
  // registry is empty or lacks it.
  getMarketsHealth: () =>
    buildMarketsHealth(
      withSol(markets.list().map((m) => ({ symbol: m.symbol })), () => ({ symbol: "SOL" })).map((m) => m.symbol),
      state.marketTicks,
      indexerStats.feeds,
      Date.now(),
    ),
};
const collectHealth = createHealthCollector(healthDeps);
app.use(healthRouter(healthDeps, collectHealth));
app.use(
  metricsRouter({
    collect: collectHealth,
    feedbackCounts: feedbackStore ? () => feedbackStore!.counts() : undefined,
    token: process.env.METRICS_TOKEN?.trim() || undefined,
  }),
);

// Closed beta: alert on state changes (alerts.ts). On by default; the log is
// the sink without Telegram.
let stopAlerts: (() => void) | null = null;
if (process.env.ALERTS_ENABLED !== "false") {
  const fs = feedbackStore;
  stopAlerts = startAlerts({
    intervalMs: envNum("ALERT_INTERVAL_MS", 30_000, 5_000),
    env: cfg.net,
    notifier,
    thresholds: {
      ...DEFAULT_ALERT_THRESHOLDS,
      minFeePayerSol: envNum("ALERT_MIN_FEE_PAYER_SOL", DEFAULT_ALERT_THRESHOLDS.minFeePayerSol, 0),
      minCrankSol: envNum("ALERT_MIN_CRANK_SOL", DEFAULT_ALERT_THRESHOLDS.minCrankSol, 0),
      marketTickAgeMs: envNum("ALERT_MARKET_TICK_AGE_MS", DEFAULT_ALERT_THRESHOLDS.marketTickAgeMs, 10_000),
      crashBurst: envNum("ALERT_CRASH_BURST", DEFAULT_ALERT_THRESHOLDS.crashBurst, 1),
    },
    collect: async () => {
      const now = Date.now();
      return {
        now,
        health: await collectHealth(),
        crashesRecent: fs ? await fs.countSince("crash", now - CRASH_WINDOW_MS).catch(() => null) : null,
        sponsorBudgetSol: getSponsorHealthSnapshot ? sponsorDailyBudgetSol : null,
      };
    },
  });
  console.log(`alerts: on (${telegram ? "Telegram" : "log only — set ALERT_TELEGRAM_BOT_TOKEN/ALERT_TELEGRAM_CHAT_ID"})`);
}

// Task 7: `CRANK_ENABLED=false` skips the crank loop entirely — used only
// to measure the scheduler as the sole source of `crank_tick`s (see
// marketWatch.ts above). `crankDone` resolves immediately in that case so
// `shutdown()` never waits on a loop that was never started.
if (!crankEnabled) {
  console.log("crank: CRANK_ENABLED=false — crank loop NOT started (scheduler-only mode, see docs/deployments.md Task 7)");
}
// Kept as a reference (not just `.catch()`ed and discarded): `shutdown()`
// below awaits this to know the loop has actually stopped. `.catch()` here
// makes `crankDone` itself never reject, so shutdown never hangs on it.
//
// Final review I2: a `startCrank` that rejects — a boot failure (TEE auth,
// `Config`/SOL `Market` read) or a crash of the loop — exits the process with
// code 1. Railway's restart policy is ON_FAILURE (railway.json), and its
// healthcheck runs only at deploy time, so a relayer that stayed up with a
// dead crank would never be restarted. During a SIGTERM/SIGINT shutdown the
// exit is left to `shutdown()`. (The loop's own watchdog — crank.ts
// `CRANK_WATCHDOG_MS` — covers a loop that hangs instead of rejecting.)
let shuttingDown = false;
const crankDone: Promise<void> = crankEnabled
  ? startCrank(cfg, state, markets).catch((e) => {
      console.error("relayer: crank loop crashed — exiting with code 1 for a restart", e);
      state.errors.push(String(e instanceof Error ? e.message : e));
      if (!shuttingDown) process.exit(1);
    })
  : Promise.resolve();

function handleSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopIndexer?.();
  stopRetention?.();
  backfill?.stop();
  wsHub?.close();
  stopMarketWatch();
  stopAlerts?.();
  markets.stop();
  void shutdown(signal, {
    requestStop,
    crankDone,
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
  });
}
process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));
