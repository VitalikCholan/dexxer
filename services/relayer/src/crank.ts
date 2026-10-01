// services/relayer/src/crank.ts
//
// Moved from scripts/crank-fallback/index.ts (Task 4, week 4): the
// `tick()`/`main()` loop, minus `SIGINT` (index.ts owns the process
// lifecycle — see `requestStop` below; the one `process.exit` here is the
// watchdog's, injectable through `CrankOpts.exit`) and minus the
// `DEXXER_NET=devnet` env-forcing dance (index.ts does that, as plain
// top-level statements, before it dynamically imports this module — see
// index.ts's header comment for why that has to be a dynamic import).
//
// `startCrank(cfg, state, registry)` mutates the shared `RelayerState` object
// on every successful tick/commit so `health.ts` can report `lastTickAt`/
// `lastCommitAt`/`tick`/`marketTicks` without polling this module or the
// chain again.
//
// Fallback for the ER scheduler (spec §3.5): "Бекенду нема. Crank — у ER
// (scheduler), fallback-скрипт зовні". Signer is `Config.crank` — on devnet
// a dedicated `devnet-crank` identity (`tests/er/.keys/devnet-crank.json`
// locally, `CRANK_KEY_B58` on Railway — see keys.ts) that is also a member
// of every trader's private `Positions`/`UserAccount` permission — required
// for the candidate-discovery `getProgramAccounts` below to see them at all.
//
// Position slots (spec §2.9.2): a trader's positions on every market are the
// slots of ONE `Positions` account. Every `CRANK_INTERVAL_MS` (default 1000):
// ONE `getProgramAccounts` over the `Positions` discriminator, every OPEN slot
// becomes a candidate for that slot's market (candidates.ts — an account that
// does not decode is dropped there, because handed to the program it would
// abort the whole batch), owners whose `UserAccount` does not decode are
// dropped too, and the rest are grouped by market.
//
// Which markets are ticked (final review I3, `tickSet`): SOL always
// (`withSol`), every market the registry lists (markets.ts), every market this
// process has ever ticked (sticky — a registry that shrinks or fails never
// stops a market's ticks), and every market that has open candidates this
// loop: one not known yet has its PUBLIC `Market` account read once and is
// ticked from then on. The registry's privacy gate (a market is listed only
// once its `MarketRisk` is permissioned) protects what the relayer
// PUBLISHES (`/markets`, the indexer), not liquidation: ticking reads and
// writes nothing private that the crank is not already a member of.
//
// Each market gets its own `crank_tick` transactions, candidates as pairs
// `[Positions, UserAccount]`, at most `CRANK_TX_MAX_CANDIDATES` pairs per
// transaction (the legacy-transaction size ceiling; the program's own cap is
// 16), at least one transaction even with no candidate — liquidation
// hysteresis counts the oracle prints a `crank_tick` accepts, so a market that
// is not ticked is not liquidated at all. One market's send plan is
// candidates.ts `tickCandidates`: a chunk rejected ON CHAIN is followed by a
// zero-candidate probe; if the probe lands, the chunk is retried one
// candidate per transaction and a pair rejected alone is quarantined for
// `CRANK_BAD_PAIR_COOLDOWN_MS`; if the probe is rejected too, the market is
// broken and nobody is blamed. The FIRST connection-class error (errors.ts:
// anything not on chain — auth, timeout, fetch failed, 429, 5xx) stops the
// market AND the rest of the loop (`runMarkets`, I4): one reconnect, then
// the next loop starts again with SOL.
//
// If candidate discovery itself fails, every market is still ticked with no
// candidate (`planTick`) — the mark, the price sample and with them the
// scheduler's `liquidation_check` keep moving — but SOL's `lastTickAt`
// (`/healthz.ok`) does not advance, so the outage stays visible.
//
// Logs carry no trader key (final review I5): one line per landed
// transaction, `tick n=... market=... mark=... mark_slot=... sig=... cu=...
// tick_ms=... candidates=<count> liquidated=<count>` (`formatTickLine`; a
// field whose read failed is `null`), written by best-effort reads that run
// AFTER the tick and are not awaited by the loop. Where one trader must be
// told apart from another (quarantine, discovery skips) the line carries
// `tagOf(PROCESS_SALT, key)` (logTag.ts) instead of the key.
//
// Liveness (final review I2): the loop never waits on the commit cycle; a
// watchdog (`CRANK_WATCHDOG_MS`, default 120 000, min 30 000) exits the
// process with code 1 when no loop iteration completed within that time, and
// index.ts exits with code 1 when `startCrank` rejects — Railway's
// ON_FAILURE restart policy is what restarts the relayer (its healthcheck runs
// only at deploy time).
//
// Three mb-stack/devnet-tee quirks fixed here, none reproducible on LiteSVM
// (no real ER/RPC there) — first fixed in scripts/crank-fallback/index.ts:
//
// 1. Duplicate-transaction guard (`freshBlockhash()` below): `crank_tick`
//    takes no instruction args, so two back-to-back ticks against an
//    unchanged candidate set build byte-identical messages whenever
//    `getLatestBlockhash("processed")` hands out the same blockhash twice in
//    a row — identical message bytes sign to an identical signature, and
//    the ER then rejects the resend with "This transaction has already been
//    processed." `nextFreshBlockhash` gives up after FRESH_BLOCKHASH_LIMIT_MS
//    (5 s) with a connection-class error instead of spinning forever (I2d).
//
// 2. `Connection.confirmTransaction`'s websocket-based confirmation stalls
//    unreliably on this validator — `confirmSignature` (tests/er/lib/env.ts)
//    polls `getSignatureStatuses` directly instead.
//
// 3. devnet-tee auth tokens are per-identity and can go stale (401) or hang
//    past what's reasonable for a 1s tick cadence — `reconnect()` below
//    re-derives a fresh `teeConn` and is triggered (at most once per loop)
//    on a connection-class error of the loop, or on a 401 that the commit
//    cycle hit on either TEE connection.
//
// Every `COMMIT_INTERVAL_MS` of WALL-CLOCK time (commit.ts; a tick count
// would stretch with the number of markets) the loop STARTS the cycle
// detached (`createCycleRunner`, final review I1 — at most one in flight; the
// ticks never wait for it): in order and each step isolated from the others
// (`runIsolated`), `runRootCycle` (a fresh `BalancesRoot`), `runCommitCycle`
// (`commit_aggregate()` — `Pool` snapshot + `BalancesRoot`, nothing else;
// trades are not disclosed), and the janitor (janitor.ts — L1 accounts of
// owners who have left). `requestStop` lets the in-flight cycle finish before
// `startCrank` resolves.


import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { confirmSignature, sleep, teeConn } from "../../../tests/er/lib/env.js";
import type { Net } from "../../../tests/er/lib/env.js";
import { POSITIONS_DISC, accountNs, dexxerCoreProgram, pdas } from "../../../tests/er/lib/program.js";
import { marketInfoFrom } from "./markets.js";
import type { MarketInfo, MarketRegistry } from "./markets.js";
import { CRANK_BAD_PAIR_COOLDOWN_MS, candidatesFrom, liquidatedIn, pairAccounts, splitPairKey, tickCandidates } from "./candidates.js";
import type { Candidate } from "./candidates.js";
import { COMMIT_INTERVAL_MS, commitDue, createCycleRunner, runCommitCycle, runIsolated, runRootCycle } from "./commit.js";
import { envNum } from "./env.js";
import { errorMessage, isConnectionClass, looksLikeAuthError, looksLikeOnChainFailure, normalizeErrorMessage } from "./errors.js";
import { crankTickAccounts } from "./ixAccounts.js";
import { janitorDeps, runJanitorCycle } from "./janitor.js";
import { PROCESS_SALT, tagOf } from "./logTag.js";
import { withSol } from "./withSol.js";

export { withSol };

type PublicKeyT = InstanceType<typeof PublicKey>;

export interface RelayerState {
  /**
   * `Date.now()` of the last loop in which the SOL market ticked AND candidate
   * discovery succeeded — what `/healthz.ok` gates (final review F3: SOL is
   * the only market the shipped APK trades). A loop whose discovery failed
   * ticks SOL with no candidate and does NOT count: nobody was checked
   * against that print. Starts `null` in every process — never restored from
   * Postgres (final review I2), so `/healthz.ok` reflects THIS process.
   */
  lastTickAt: number | null;
  /** `Date.now()` of the last `commit_aggregate` that succeeded (not of the last attempt). */
  lastCommitAt: number | null;
  /** Last loop number in which at least one market ticked. */
  tick: number;
  /** Bounded ring of recent error strings (most recent last) — see MAX_ERRORS below. */
  errors: string[];
  /** `Date.now()` of each market's last successful `crank_tick`, keyed by symbol — lets health tell one stuck market apart from a healthy loop. */
  marketTicks: Record<string, number>;
}

export interface RelayerConfig {
  net: Net;
  baseRpc: string;
  /** Not read by startCrank directly — teeConn()/baseConn (tests/er/lib/env.ts, imported below) already resolve the ER endpoint from the same process.env forcing index.ts does before import. Kept on the config shape for other consumers (index.ts's market registry). */
  erRpc: string;
  erWs: string;
  crank: Keypair;
  feePayer: Keypair;
  port: number;
  indexerEnabled: boolean;
  sponsorEnabled: boolean;
  databaseUrl?: string;
}

const INTERVAL = Number(process.env.CRANK_INTERVAL_MS ?? 1000);
const MAX_ERRORS = 50;
// Final review F7: a market failing every 1 s tick with the same message
// would flush the whole 50-entry ring (and the log) within a minute, hiding
// every other error — record a market's repeat only once per window.
const MARKET_ERROR_WINDOW_MS = 60_000;
// Solana RPC's `getMultipleAccounts` limit per call.
const MULTIPLE_ACCOUNTS_MAX = 100;
/** No loop iteration completed within this → `process.exit(1)` (I2). Min 30 s: a NaN/0 would kill a healthy relayer. */
export const CRANK_WATCHDOG_MS = envNum("CRANK_WATCHDOG_MS", 120_000, 30_000);
/** `freshBlockhash` gives up after this (I2d). */
const FRESH_BLOCKHASH_LIMIT_MS = 5_000;

let stopRequested = false;

/** index.ts calls this from its SIGTERM/SIGINT handler; the in-flight tick and the in-flight commit cycle still finish. */
export function requestStop(): void {
  stopRequested = true;
}

function pushError(state: RelayerState, e: unknown): void {
  state.errors.push(errorMessage(e));
  if (state.errors.length > MAX_ERRORS) state.errors.shift();
}

/** Record a market's error only when it differs from the last one recorded for that market, or the window since that record has elapsed (F7). `msg` is normalised by the caller (`normalizeErrorMessage`, m5). */
export function shouldRecordError(prev: { msg: string; at: number } | undefined, msg: string, now: number, windowMs: number): boolean {
  return prev === undefined || prev.msg !== msg || now - prev.at >= windowMs;
}

export interface RunMarketsResult {
  ticked: string[];
  failed: string[];
  /** Markets not tried in this loop because a connection-class error stopped it (I4). */
  notTicked: string[];
  solTicked: boolean;
  needsReconnect: boolean;
}

/** What one market's tick reports back: a market that landed something can still have hit a connection error afterwards. */
export type MarketTickOutcome = { connectionError: boolean } | void;

/**
 * Ticks the markets in order, each in its own try/catch: a market rejected ON
 * CHAIN must not stop the others' mark/EMA advance or their liquidations. The
 * FIRST connection-class error (a throw that `isConnectionClass`, or a market
 * that ticked and then reported `connectionError`) stops the loop (I4): all
 * markets share one connection, so the later sends would fail the same way —
 * `needsReconnect` is set, the caller reconnects once, and the next loop
 * starts again from the first market (SOL).
 */
export async function runMarkets(
  markets: MarketInfo[],
  tickFn: (m: MarketInfo) => Promise<MarketTickOutcome>,
  onError: (m: MarketInfo, e: unknown) => void,
  isConnectionClass: (e: unknown) => boolean,
): Promise<RunMarketsResult> {
  const out: RunMarketsResult = { ticked: [], failed: [], notTicked: [], solTicked: false, needsReconnect: false };
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    let stop = false;
    try {
      const r = await tickFn(m);
      out.ticked.push(m.symbol);
      if (m.symbol === "SOL") out.solTicked = true;
      stop = Boolean(r && r.connectionError);
    } catch (e) {
      out.failed.push(m.symbol);
      onError(m, e);
      stop = isConnectionClass(e);
    }
    if (stop) {
      out.needsReconnect = true;
      out.notTicked = markets.slice(i + 1).map((x) => x.symbol);
      break;
    }
  }
  return out;
}

export function groupOpenByMarket<T extends { market: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.market, [...(out.get(r.market) ?? []), r]);
  return out;
}

export type Discovery = { ok: true; candidates: Candidate[] } | { ok: false };

/**
 * What one loop ticks. Discovery failed → every market is still ticked, with
 * NO candidate (never last loop's): `liq_due` counts a price sample only when
 * it checks a position, so a sample nobody was checked against costs nothing,
 * while not ticking would freeze every market's mark/EMA and `sample_seq` —
 * and with them the scheduler's `liquidation_check`, which only reads the
 * market. Such a loop does not count for health (`lastTickAt`), so a
 * discovery outage stays visible on `/healthz`.
 */
export function planTick(d: Discovery): { byMarket: Map<string, Candidate[]>; countsForHealth: boolean } {
  return d.ok ? { byMarket: groupOpenByMarket(d.candidates), countsForHealth: true } : { byMarket: new Map(), countsForHealth: false };
}

/** Markets (base58) that have open positions but are not in `ticked`. */
export function untickedMarkets(byMarket: Map<string, unknown[]>, ticked: MarketInfo[]): string[] {
  const known = new Set(ticked.map((m) => m.market.toBase58()));
  return [...byMarket.keys()].filter((k) => !known.has(k)).sort();
}

/**
 * The crank's tick set for one loop (final review I3): SOL first (`withSol`),
 * then the registry's markets (the registry's entry wins for a market it
 * lists), then every market of the sticky map the registry no longer lists.
 * `unknown` = markets that have open candidates but are in neither — the
 * caller reads their public `Market` account and ticks them too. Pure: the
 * caller adds the result to the sticky map.
 */
export function tickSet(
  sticky: Map<string, MarketInfo>,
  registry: MarketInfo[],
  sol: () => MarketInfo,
  byMarket: Map<string, unknown[]>,
): { markets: MarketInfo[]; unknown: string[] } {
  const out = new Map<string, MarketInfo>();
  for (const m of withSol(registry, sol)) out.set(m.market.toBase58(), m);
  for (const [key, m] of sticky) if (!out.has(key)) out.set(key, m);
  const markets = [...out.values()];
  return { markets, unknown: untickedMarkets(byMarket, markets) };
}

/** No loop iteration completed within `limitMs` (I2): the process is wedged and must be restarted. */
export function watchdogExpired(lastLoopDoneAt: number, now: number, limitMs: number): boolean {
  return now - lastLoopDoneAt > limitMs;
}

/**
 * A blockhash different from `last` (quirk 1 in the header), polled every
 * `pollMs`; gives up after `limitMs` with an error that is connection-class
 * (it is not an on-chain failure), so the loop stops and reconnects (I2d).
 */
export async function nextFreshBlockhash<T extends { blockhash: string }>(
  get: () => Promise<T>,
  last: string | null,
  o: { limitMs: number; pollMs: number; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  const deadline = o.now() + o.limitMs;
  for (;;) {
    const res = await get();
    if (res.blockhash !== last) return res;
    if (o.now() >= deadline) throw new Error(`freshBlockhash timeout: no new blockhash within ${o.limitMs} ms`);
    await o.sleep(o.pollMs);
  }
}

export interface TickLineFields {
  n: number;
  market: string;
  mark: string | null;
  markSlot: string | null;
  sig: string;
  cu: number | null;
  tickMs: number;
  candidates: number;
  /** How many of the chunk's candidates lost their slot on this market in this tick — a count, never keys (I5). */
  liquidated: number | null;
}

/** The one log line per landed `crank_tick` (parsed by scripts/demo/week1-cli.ts `parseTickLine`). */
export function formatTickLine(f: TickLineFields): string {
  return `tick n=${f.n} market=${f.market} mark=${f.mark} mark_slot=${f.markSlot} sig=${f.sig} cu=${f.cu} tick_ms=${f.tickMs} candidates=${f.candidates} liquidated=${f.liquidated}`;
}

export interface CrankOpts {
  /** What the watchdog calls when it fires. Default `process.exit` — only `startCrank` starts the watchdog, tests never call it. */
  exit?: (code: number) => void;
}

export async function startCrank(cfg: RelayerConfig, state: RelayerState, registry: MarketRegistry, opts: CrankOpts = {}): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  // Started before the boot reads: a TEE auth or RPC call that hangs at boot
  // is a wedge too.
  let lastLoopDoneAt = Date.now();
  const watchdog = setInterval(
    () => {
      const now = Date.now();
      if (!watchdogExpired(lastLoopDoneAt, now, CRANK_WATCHDOG_MS)) return;
      console.error(`crank: watchdog — no loop iteration completed for ${now - lastLoopDoneAt} ms (CRANK_WATCHDOG_MS=${CRANK_WATCHDOG_MS}); exiting with code 1 for a restart`);
      exit(1);
    },
    Math.min(10_000, CRANK_WATCHDOG_MS / 4),
  );
  watchdog.unref();
  try {
    await runCrank(cfg, state, registry, () => {
      lastLoopDoneAt = Date.now();
    }, () => clearInterval(watchdog));
  } finally {
    clearInterval(watchdog);
  }
}

async function runCrank(
  cfg: RelayerConfig,
  state: RelayerState,
  registry: MarketRegistry,
  loopDone: () => void,
  stopWatchdog: () => void,
): Promise<void> {
  let conn = await teeConn(cfg.crank);
  let prog = dexxerCoreProgram(conn, cfg.crank);
  // Separate connection/program pair, authenticated as `feePayer` —
  // `commit_aggregate`'s only accepted `payer` signer, distinct from
  // `crank`'s identity (commit.ts's `CommitCtx`).
  let feePayerConn = await teeConn(cfg.feePayer);
  let feePayerProg = dexxerCoreProgram(feePayerConn, cfg.feePayer);
  // The janitor's `close_exited_user` is a plain L1 transaction signed by
  // `fee_payer` — no TEE auth, no reconnect dance, so this pair is built once
  // and never re-derived.
  const baseConn = new Connection(cfg.baseRpc, "confirmed");
  const baseFeePayerProg = dexxerCoreProgram(baseConn, cfg.feePayer);
  let lastBlockhash: string | null = null;
  // Set by the detached commit cycle on a 401 from either TEE connection; the
  // loop reconnects at its next iteration.
  let cycleWantsReconnect = false;

  async function reconnect(): Promise<void> {
    conn = await teeConn(cfg.crank);
    prog = dexxerCoreProgram(conn, cfg.crank);
    feePayerConn = await teeConn(cfg.feePayer);
    feePayerProg = dexxerCoreProgram(feePayerConn, cfg.feePayer);
    lastBlockhash = null; // the old value belongs to the just-replaced connection
    console.log("crank: reconnected (fresh TEE auth token)");
  }

  /** A blockhash guaranteed different from the one the previous tick used. */
  async function freshBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const c = conn;
    const res = await nextFreshBlockhash(() => c.getLatestBlockhash("processed"), lastBlockhash, {
      limitMs: FRESH_BLOCKHASH_LIMIT_MS,
      pollMs: 200,
      now: Date.now,
      sleep,
    });
    lastBlockhash = res.blockhash;
    return res;
  }

  /** ONE `getProgramAccounts` per tick for every market's candidates. The crank's own TEE token reads these private accounts — it is a permission member of each. */
  async function openCandidates(n: number): Promise<Candidate[]> {
    const rows = await conn.getProgramAccounts(prog.programId, { filters: [{ memcmp: { offset: 0, bytes: POSITIONS_DISC } }] });
    const found = candidatesFrom(
      rows.map((r) => ({ pubkey: r.pubkey, data: r.account.data })),
      (pubkey, reason) => console.error(`crank n=${n}: skipping account tag=${tagOf(PROCESS_SALT, pubkey)} — not a Positions account (${reason})`),
    );
    // A pair whose UserAccount does not decode is skipped by the program, but
    // dropping it here keeps the chunk's room for real candidates.
    const owners = [...new Map(found.map((c) => [c.owner.toBase58(), c.owner])).values()];
    const userAccounts = owners.map((o) => pdas.userAccount(o));
    // In pages of 100 — the RPC's per-call limit; one oversized call would
    // fail discovery, and with it every market's tick.
    const infos: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> = [];
    for (let i = 0; i < userAccounts.length; i += MULTIPLE_ACCOUNTS_MAX) {
      infos.push(...(await conn.getMultipleAccountsInfo(userAccounts.slice(i, i + MULTIPLE_ACCOUNTS_MAX), "confirmed")));
    }
    const ok = new Set<string>();
    owners.forEach((o, i) => {
      const info = infos[i];
      if (!info) {
        console.error(`crank n=${n}: skipping owner tag=${tagOf(PROCESS_SALT, o)} — UserAccount not found`);
        return;
      }
      try {
        prog.coder.accounts.decode("userAccount", info.data);
        ok.add(o.toBase58());
      } catch (e) {
        console.error(`crank n=${n}: skipping owner tag=${tagOf(PROCESS_SALT, o)} — UserAccount failed to decode: ${errorMessage(e)}`);
      }
    });
    return found.filter((c) => ok.has(c.owner.toBase58()));
  }

  /**
   * The log line of a landed tick, from reads made AFTER it — fired and
   * forgotten: the tick path does not wait for them, and a failed read only
   * turns its field into `null` (and a debug line), never the landed tick
   * into a failed one.
   */
  function logLanded(m: MarketInfo, chunk: Candidate[], n: number, sig: string, tickMs: number): void {
    const c = conn;
    const p = prog;
    void (async () => {
      const [tx, after, market] = await Promise.allSettled([
        c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
        chunk.length > 0 ? c.getMultipleAccountsInfo(chunk.map((x) => x.positions), "confirmed") : Promise.resolve([]),
        accountNs(p).market.fetch(m.market),
      ]);
      // A slot of this market that was open before the tick and is gone after
      // it was closed by this tick: a liquidation. Logged as a count.
      const liquidated = after.status === "fulfilled" ? liquidatedIn(chunk, after.value.map((a) => a?.data ?? null)).length : null;
      console.log(
        formatTickLine({
          n,
          market: m.symbol,
          mark: market.status === "fulfilled" ? market.value.mark.toString() : null,
          markSlot: market.status === "fulfilled" ? market.value.markSlot.toString() : null,
          sig,
          cu: tx.status === "fulfilled" ? (tx.value?.meta?.computeUnitsConsumed ?? null) : null,
          tickMs,
          candidates: chunk.length,
          liquidated,
        }),
      );
      for (const r of [tx, after, market]) {
        if (r.status === "rejected") console.debug(`crank: post-tick read failed market=${m.symbol}: ${errorMessage(r.reason)}`);
      }
    })().catch((e) => console.debug(`crank: post-tick log failed market=${m.symbol}: ${errorMessage(e)}`));
  }

  /** One `crank_tick` over one chunk of a market's candidates. Resolves once it is confirmed, throws only if it did not land. */
  async function tickChunk(m: MarketInfo, poolLive: PublicKeyT, chunk: Candidate[], n: number): Promise<void> {
    const ix = await prog.methods
      .crankTick()
      .accounts(crankTickAccounts(cfg.crank.publicKey, m, poolLive))
      .remainingAccounts(pairAccounts(chunk, (o) => pdas.userAccount(o)))
      .instruction();

    const sendT0 = Date.now();
    // The guard is per-connection, not per-market: every send in the tick
    // (all markets, all chunks) waits for a blockhash the previous send did
    // not use — cheap at the ER's ~80 slots/s.
    const { blockhash } = await freshBlockhash();
    // Plan 1 measured 16 candidates in LiteSVM at 142k–172k CU with no
    // liquidation and 162k–192k with 16 liquidations (it depends on the PDA
    // bumps) — close to or above the 200k default, so the limit is raised
    // explicitly.
    const txn = new Transaction({ feePayer: cfg.crank.publicKey, recentBlockhash: blockhash })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(ix);
    txn.sign(cfg.crank);
    const sig = await conn.sendRawTransaction(txn.serialize(), { skipPreflight: true });
    await confirmSignature(conn, sig);
    logLanded(m, chunk, n, sig, Date.now() - sendT0);
  }

  // Pairs that failed `crank_tick` alone: pairKey → excluded until (ms).
  // Process lifetime, shared by all markets (the key carries the market).
  const badPairs = new Map<string, number>();
  // I3: every market this process has ticked, by base58 — never shrinks.
  const tickMarkets = new Map<string, MarketInfo>();
  const symbolOf = (market: string): string => tickMarkets.get(market)?.symbol ?? market; // a Market address is public

  /**
   * One market for one loop (`tickCandidates`). The market counts as ticked
   * if at least one of its transactions landed — one bad pair must not hold
   * SOL's `lastTickAt` hostage. If none landed, the error that decided it is
   * rethrown for `runMarkets` (a connection-class one if the market stopped
   * on one); errors of a market that did tick are still recorded.
   */
  async function tickMarket(m: MarketInfo, poolLive: PublicKeyT, open: Candidate[], n: number): Promise<MarketTickOutcome> {
    const r = await tickCandidates(open, {
      send: (chunk) => tickChunk(m, poolLive, chunk, n),
      isOnChainFailure: looksLikeOnChainFailure,
      quarantine: badPairs,
      now: Date.now(),
      cooldownMs: CRANK_BAD_PAIR_COOLDOWN_MS,
    });
    // m3: a released key may belong to any market — the market comes from the key.
    for (const key of r.released) {
      const k = splitPairKey(key);
      console.log(`crank n=${n} market=${symbolOf(k.market)}: pair tag=${tagOf(PROCESS_SALT, k.positions)} back in the batches after its cooldown`);
    }
    for (const key of r.quarantined) {
      const k = splitPairKey(key);
      console.warn(`crank n=${n} market=${symbolOf(k.market)}: pair tag=${tagOf(PROCESS_SALT, k.positions)} failed crank_tick alone on chain — excluded for ${CRANK_BAD_PAIR_COOLDOWN_MS} ms`);
    }
    if (r.landed === 0) {
      const decisive = r.connectionError ? r.errors.find(isConnectionClass) : r.errors[0];
      throw decisive ?? new Error(`market ${m.symbol}: no crank_tick landed`);
    }
    for (const e of r.errors) onMarketError(m, e);
    return { connectionError: r.connectionError };
  }

  const config = await accountNs(prog).config.fetch(pdas.config());
  const solMarket = pdas.market();
  // Read ONCE at start: SOL's `MarketInfo` (feed + public params), used
  // whenever the registry's list has no SOL entry (`withSol`) — so a registry
  // that cannot read the ER leaves SOL ticking, never idle.
  const solInfo = marketInfoFrom(solMarket, await accountNs(prog).market.fetch(solMarket));
  const solFallback = (): MarketInfo => solInfo;
  const pool = pdas.pool(config.dusdcMint as PublicKeyT);
  const poolLive = pdas.poolLive(config.dusdcMint as PublicKeyT);
  const balancesRoot = pdas.balancesRoot();
  const feeEscrow = pdas.feeEscrow();
  console.log("crank starting", {
    net: cfg.net,
    crank: cfg.crank.publicKey.toBase58(),
    feePayer: cfg.feePayer.publicKey.toBase58(),
    solMarket: solMarket.toBase58(),
    markets: withSol(registry.list(), solFallback).map((mi) => mi.symbol),
    pool: pool.toBase58(),
    balancesRoot: balancesRoot.toBase58(),
    intervalMs: INTERVAL,
    commitIntervalMs: COMMIT_INTERVAL_MS,
    watchdogMs: CRANK_WATCHDOG_MS,
  });

  // Last logged set of candidate markets whose `Market` could not be read —
  // logged on change only, not at the 1s cadence.
  let lastUnresolved = "";
  /** I3: candidate markets nobody listed — read the PUBLIC `Market` once, cache it, tick it. A failed read is retried next loop. */
  async function resolveUnknown(keys: string[], n: number): Promise<MarketInfo[]> {
    const found: MarketInfo[] = [];
    const failed: string[] = [];
    for (const key of keys) {
      try {
        const pk = new PublicKey(key);
        const info = marketInfoFrom(pk, await accountNs(prog).market.fetch(pk));
        tickMarkets.set(key, info);
        found.push(info);
        console.warn(`crank n=${n}: market ${info.symbol} (${key}) has open positions but is not in the registry — ticked from now on`);
      } catch {
        failed.push(key);
      }
    }
    const joined = failed.join(",");
    if (joined !== lastUnresolved) {
      if (joined) console.warn(`crank n=${n}: open positions on markets whose Market account could not be read — not cranked this loop, retried next loop: ${joined}`);
      lastUnresolved = joined;
    }
    return found;
  }

  // F7: last recorded (normalised) error per market symbol.
  const lastMarketError = new Map<string, { msg: string; at: number }>();
  const onMarketError = (m: MarketInfo, e: unknown): void => {
    const msg = errorMessage(e);
    const key = normalizeErrorMessage(msg); // m5: a new signature is not a new error
    const now = Date.now();
    if (!shouldRecordError(lastMarketError.get(m.symbol), key, now, MARKET_ERROR_WINDOW_MS)) return;
    lastMarketError.set(m.symbol, { msg: key, at: now });
    console.error(`tick failed market=${m.symbol}`, msg);
    pushError(state, `${m.symbol}: ${msg}`);
  };

  // I1: root → commit → janitor, detached from the ticks, one at a time.
  const cycle = createCycleRunner(
    async () => {
      const commitCtx = { conn, prog, crank: cfg.crank, feePayerConn, feePayerProg, feePayer: cfg.feePayer, pool, poolLive, balancesRoot, feeEscrow };
      const onStepError = (name: string, e: unknown): void => {
        console.error(`${name} cycle failed`, errorMessage(e));
        pushError(state, e);
        if (looksLikeAuthError(e)) cycleWantsReconnect = true;
      };
      const ok = await runIsolated(
        [
          ["root", () => runRootCycle(commitCtx)],
          ["commit", async () => {
            await runCommitCycle(commitCtx);
          }],
          ["janitor", async () => {
            const r = await runJanitorCycle(janitorDeps({ baseConn, baseProg: baseFeePayerProg, feePayer: cfg.feePayer }));
            for (const err of r.errors) pushError(state, err);
            if (r.closed.length > 0 || r.errors.length > 0) {
              console.log(`janitor: scanned=${r.scanned} closed=${r.closed.length} skipped=${r.skipped} errors=${r.errors.length} aborted=${r.aborted} low_balance=${r.lowBalance}`);
            }
          }],
        ],
        onStepError,
      );
      if (ok.includes("commit")) state.lastCommitAt = Date.now();
    },
    (e) => {
      // Not expected (`runIsolated` catches per step) — recorded, never thrown.
      console.error("commit cycle failed", errorMessage(e));
      pushError(state, e);
    },
  );

  let lastCommitAttemptAt: number | null = null;
  let n = 0;
  while (!stopRequested) {
    const t0 = Date.now();
    n += 1;
    // At most ONE reconnect per loop — every market shares the same `conn`,
    // so one fresh token fixes all of them.
    let needReconnect = cycleWantsReconnect;
    cycleWantsReconnect = false;
    let discovery: Discovery;
    try {
      discovery = { ok: true, candidates: await openCandidates(n) };
    } catch (e) {
      // Discovery failed: the markets are still ticked below, with no
      // candidate (`planTick`); this loop does not count for `lastTickAt`.
      console.error(`crank n=${n}: candidate discovery failed — ticking every market without candidates`, errorMessage(e));
      pushError(state, e);
      needReconnect ||= isConnectionClass(e);
      discovery = { ok: false };
    }
    const plan = planTick(discovery);
    try {
      const set = tickSet(tickMarkets, registry.list(), solFallback, plan.byMarket);
      for (const mi of set.markets) tickMarkets.set(mi.market.toBase58(), mi);
      const markets = [...set.markets, ...(await resolveUnknown(set.unknown, n))];
      const r = await runMarkets(markets, (m) => tickMarket(m, poolLive, plan.byMarket.get(m.market.toBase58()) ?? [], n), onMarketError, isConnectionClass);
      const now = Date.now();
      for (const sym of r.ticked) state.marketTicks[sym] = now;
      if (r.ticked.length > 0) state.tick = n;
      // F3: `lastTickAt` (and so `/healthz.ok`) follows SOL alone — a healthy
      // BTC tick must not hide a stuck SOL, the only market the shipped APK
      // trades. Other markets are informational in `/healthz.markets`. A loop
      // whose discovery failed does not count: SOL was ticked, but nobody was
      // checked against its print.
      if (r.solTicked && plan.countsForHealth) state.lastTickAt = now;
      if (r.notTicked.length > 0) console.warn(`crank n=${n}: connection-class error — not ticked this loop: ${r.notTicked.join(",")}; reconnecting`);
      needReconnect ||= r.needsReconnect;
    } catch (e) {
      // Not expected (`runMarkets` catches per market) — never stop the loop.
      console.error("tick failed", errorMessage(e));
      pushError(state, e);
      needReconnect ||= isConnectionClass(e);
    }
    if (needReconnect) {
      try {
        await reconnect();
      } catch (re) {
        console.error("reconnect failed", errorMessage(re));
        pushError(state, re);
      }
    }

    // I1: started, not awaited — the ticks never wait for an L1 close or a
    // commit's confirm. A cycle still in flight is not doubled; the next due
    // check after it finished starts the next one.
    const now = Date.now();
    if (!cycle.busy() && commitDue(lastCommitAttemptAt, now, COMMIT_INTERVAL_MS)) {
      lastCommitAttemptAt = now;
      cycle.trigger();
    }

    loopDone();
    await sleep(Math.max(0, INTERVAL - (Date.now() - t0)));
  }
  // The watchdog guards the loop, not the shutdown (shutdown.ts has its own
  // hard-kill timeout).
  stopWatchdog();
  if (cycle.busy()) console.log("crank: stop requested — waiting for the in-flight commit cycle");
  await cycle.idle();
  console.log("crank stopped (requestStop)");
}
