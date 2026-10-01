// services/relayer/src/crank.ts
//
// Moved from scripts/crank-fallback/index.ts (Task 4, week 4): the
// `tick()`/`main()` loop, minus `process.exit`/`SIGINT` (index.ts now owns
// process lifecycle — see `requestStop` below) and minus the
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
// dropped too, and the rest are grouped by market. Every market of the
// registry (markets.ts; SOL always, `withSol`) then gets its own `crank_tick`
// transactions, candidates as pairs `[Positions, UserAccount]`, at most
// `CRANK_TX_MAX_CANDIDATES` pairs per transaction (the legacy-transaction
// size ceiling; the program's own cap is 16), at least one transaction even
// with no candidate — liquidation hysteresis counts the oracle prints a
// `crank_tick` accepts, so a market that is not ticked is not liquidated at
// all. Each market runs in its own try/catch (`runMarkets`), and each chunk
// of a market in its own too: one failing market or chunk must not stop the
// others. One log line per chunk: `tick n=... market=... slot=... mark=...
// mark_slot=... sig=... cu=... tick_ms=... candidates=... liquidated=[...]`.
//
// Three mb-stack/devnet-tee quirks fixed here, none reproducible on LiteSVM
// (no real ER/RPC there) — unchanged from scripts/crank-fallback/index.ts:
//
// 1. Duplicate-transaction guard (`freshBlockhash()` below): `crank_tick`
//    takes no instruction args, so two back-to-back ticks against an
//    unchanged candidate set build byte-identical messages whenever
//    `getLatestBlockhash("processed")` hands out the same blockhash twice in
//    a row — identical message bytes sign to an identical signature, and
//    the ER then rejects the resend with "This transaction has already been
//    processed."
//
// 2. `Connection.confirmTransaction`'s websocket-based confirmation stalls
//    unreliably on this validator — `confirmSignature` (tests/er/lib/env.ts)
//    polls `getSignatureStatuses` directly instead.
//
// 3. devnet-tee auth tokens are per-identity and can go stale (401) or hang
//    past what's reasonable for a 1s tick cadence — `reconnect()` below
//    re-derives a fresh `teeConn` and is triggered (at most once per loop)
//    on anything that looks like a 401/timeout/connection-reset.
//
// Every `COMMIT_INTERVAL_MS` of WALL-CLOCK time (commit.ts; a tick count
// would stretch with the number of markets) the loop runs, in order and each
// step isolated from the others (`runIsolated`): `runRootCycle` (a fresh
// `BalancesRoot`), `runCommitCycle` (`commit_aggregate()` — `Pool` snapshot +
// `BalancesRoot`, nothing else; trades are not disclosed), and the janitor
// (janitor.ts — L1 accounts of owners who have left). None of them can stop
// the ticks.

import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { confirmSignature, sleep, teeConn } from "../../../tests/er/lib/env.js";
import type { Net } from "../../../tests/er/lib/env.js";
import { POSITIONS_DISC, accountNs, dexxerCoreProgram, pdas } from "../../../tests/er/lib/program.js";
import { marketInfoFrom } from "./markets.js";
import type { MarketInfo, MarketRegistry } from "./markets.js";
import { candidatesFrom, chunkCandidates, liquidatedIn, pairAccounts } from "./candidates.js";
import type { Candidate } from "./candidates.js";
import { COMMIT_INTERVAL_MS, commitDue, runCommitCycle, runIsolated, runRootCycle } from "./commit.js";
import { janitorDeps, runJanitorCycle } from "./janitor.js";

type PublicKeyT = InstanceType<typeof PublicKey>;

export interface RelayerState {
  /** `Date.now()` of the last loop in which the SOL market ticked — what `/healthz.ok` gates (final review F3): SOL is the only market the shipped APK trades. */
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

let stopRequested = false;

/** index.ts calls this from its SIGTERM/SIGINT handler; the in-flight tick still finishes. */
export function requestStop(): void {
  stopRequested = true;
}

function looksLikeAuthOrTimeout(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : e);
  return /\b401\b|unauthor|timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg);
}

function pushError(state: RelayerState, e: unknown): void {
  state.errors.push(String(e instanceof Error ? e.message : e));
  if (state.errors.length > MAX_ERRORS) state.errors.shift();
}

/** Record a market's error only when it differs from the last one recorded for that market, or the window since that record has elapsed (F7). */
export function shouldRecordError(prev: { msg: string; at: number } | undefined, msg: string, now: number, windowMs: number): boolean {
  return prev === undefined || prev.msg !== msg || now - prev.at >= windowMs;
}

export interface RunMarketsResult {
  ticked: string[];
  failed: string[];
  solTicked: boolean;
  needsReconnect: boolean;
}

/**
 * Ticks every market in order, each in its own try/catch: a market whose
 * send/confirm throws must not stop the others' mark/EMA advance or their
 * liquidations. `needsReconnect` is set once however many markets hit a
 * 401/timeout — they all share one connection, so one fresh token fixes all.
 */
export async function runMarkets(
  markets: MarketInfo[],
  tickFn: (m: MarketInfo) => Promise<void>,
  onError: (m: MarketInfo, e: unknown) => void,
  looksLikeAuthOrTimeout: (e: unknown) => boolean,
): Promise<RunMarketsResult> {
  const out: RunMarketsResult = { ticked: [], failed: [], solTicked: false, needsReconnect: false };
  for (const m of markets) {
    try {
      await tickFn(m);
      out.ticked.push(m.symbol);
      if (m.symbol === "SOL") out.solTicked = true;
    } catch (e) {
      out.failed.push(m.symbol);
      onError(m, e);
      out.needsReconnect ||= looksLikeAuthOrTimeout(e);
    }
  }
  return out;
}

export function groupOpenByMarket<T extends { market: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.market, [...(out.get(r.market) ?? []), r]);
  return out;
}

/** SOL is ticked whatever the registry says: an empty list (first read not done yet) or a list that lost SOL must never stop the market the shipped APK trades — nor its liquidations. */
export function withSol(list: MarketInfo[], sol: () => MarketInfo): MarketInfo[] {
  return list.some((m) => m.symbol === "SOL") ? list : [sol(), ...list];
}

/** Markets (base58) that have open positions but are not in the tick list — nothing liquidates there until the registry catches up. */
export function untickedMarkets(byMarket: Map<string, unknown[]>, ticked: MarketInfo[]): string[] {
  const known = new Set(ticked.map((m) => m.market.toBase58()));
  return [...byMarket.keys()].filter((k) => !known.has(k)).sort();
}

export async function startCrank(cfg: RelayerConfig, state: RelayerState, registry: MarketRegistry): Promise<void> {
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
    for (;;) {
      const res = await conn.getLatestBlockhash("processed");
      if (res.blockhash !== lastBlockhash) {
        lastBlockhash = res.blockhash;
        return res;
      }
      await sleep(200);
    }
  }

  /** ONE `getProgramAccounts` per tick for every market's candidates. The crank's own TEE token reads these private accounts — it is a permission member of each. */
  async function openCandidates(n: number): Promise<Candidate[]> {
    const rows = await conn.getProgramAccounts(prog.programId, { filters: [{ memcmp: { offset: 0, bytes: POSITIONS_DISC } }] });
    const found = candidatesFrom(
      rows.map((r) => ({ pubkey: r.pubkey, data: r.account.data })),
      (pubkey, reason) => console.error(`tick n=${n}: skipping ${pubkey.toBase58()} — not a Positions account (${reason})`),
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
        console.error(`tick n=${n}: skipping owner ${o.toBase58()} — UserAccount not found`);
        return;
      }
      try {
        prog.coder.accounts.decode("userAccount", info.data);
        ok.add(o.toBase58());
      } catch (e) {
        console.error(`tick n=${n}: skipping owner ${o.toBase58()} — UserAccount failed to decode: ${String(e)}`);
      }
    });
    return found.filter((c) => ok.has(c.owner.toBase58()));
  }

  /** One `crank_tick` over one chunk of a market's candidates. */
  async function tickChunk(m: MarketInfo, poolLive: PublicKeyT, chunk: Candidate[], n: number, slot: number): Promise<void> {
    const ix = await prog.methods
      .crankTick()
      .accounts({ crank: cfg.crank.publicKey, config: pdas.config(), market: m.market, marketRisk: m.marketRisk, poolLive, feed: m.feed })
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
    const tickMs = Date.now() - sendT0;

    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const cu = tx?.meta?.computeUnitsConsumed ?? null;
    // A slot of this market that was open before the tick and is gone after
    // it was closed by this tick: a liquidation.
    const after = chunk.length > 0 ? await conn.getMultipleAccountsInfo(chunk.map((c) => c.positions), "confirmed") : [];
    const liquidated = liquidatedIn(chunk, after.map((a) => a?.data ?? null));

    const market = await accountNs(prog).market.fetch(m.market);
    console.log(
      `tick n=${n} market=${m.symbol} slot=${slot} mark=${market.mark.toString()} mark_slot=${market.markSlot.toString()} sig=${sig} cu=${cu} tick_ms=${tickMs} candidates=${chunk.length} liquidated=${JSON.stringify(liquidated)}`,
    );
  }

  /**
   * Every chunk of the market, each isolated: a chunk that fails (a send that
   * is rejected, a read after it) must not keep the later chunks' candidates
   * out of this tick. The market counts as ticked only if every chunk went
   * through — otherwise the first error is rethrown for `runMarkets`.
   */
  async function tickMarket(m: MarketInfo, poolLive: PublicKeyT, open: Candidate[], n: number): Promise<void> {
    const slot = await conn.getSlot("confirmed");
    const chunks = chunkCandidates(open);
    const errors: unknown[] = [];
    await runIsolated(
      chunks.map((chunk, i): [string, () => Promise<void>] => [`chunk${i}`, () => tickChunk(m, poolLive, chunk, n, slot)]),
      (name, e) => {
        if (chunks.length > 1) console.error(`tick n=${n} market=${m.symbol} ${name}/${chunks.length} failed`, String(e instanceof Error ? e.message : e));
        errors.push(e);
      },
    );
    if (errors.length > 0) throw errors[0];
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
  });

  // Last logged set of markets that have open positions but are not in the
  // tick list — logged on change only, not at the 1s cadence.
  let lastUnticked = "";
  // F7: last recorded error per market symbol.
  const lastMarketError = new Map<string, { msg: string; at: number }>();
  const onMarketError = (m: MarketInfo, e: unknown): void => {
    const msg = String(e instanceof Error ? e.message : e);
    const now = Date.now();
    if (!shouldRecordError(lastMarketError.get(m.symbol), msg, now, MARKET_ERROR_WINDOW_MS)) return;
    lastMarketError.set(m.symbol, { msg, at: now });
    console.error(`tick failed market=${m.symbol}`, msg);
    pushError(state, `${m.symbol}: ${msg}`);
  };
  let lastCommitAttemptAt: number | null = null;
  let n = 0;
  while (!stopRequested) {
    const t0 = Date.now();
    n += 1;
    // At most ONE reconnect per tick, however many markets hit a 401/timeout —
    // they all share the same `conn`, so one fresh token fixes all of them.
    let needReconnect = false;
    try {
      const byMarket = groupOpenByMarket(await openCandidates(n));
      const markets = withSol(registry.list(), solFallback);
      // A position on a market the list does not have yet (added with
      // `add-market` less than MARKETS_REFRESH_MS ago, or the registry has
      // not read the ER yet) is NOT ticked, so it cannot be liquidated by
      // this loop until the registry catches up — make that visible.
      const unticked = untickedMarkets(byMarket, markets).join(",");
      if (unticked !== lastUnticked) {
        if (unticked) console.warn(`tick n=${n}: open positions on markets not in the tick list (not cranked): ${unticked}`);
        lastUnticked = unticked;
      }
      const r = await runMarkets(markets, (m) => tickMarket(m, poolLive, byMarket.get(m.market.toBase58()) ?? [], n), onMarketError, looksLikeAuthOrTimeout);
      const now = Date.now();
      for (const sym of r.ticked) state.marketTicks[sym] = now;
      if (r.ticked.length > 0) state.tick = n;
      // F3: `lastTickAt` (and so `/healthz.ok` and the persisted meta) follows
      // SOL alone — a healthy BTC tick must not hide a stuck SOL, the only
      // market the shipped APK trades. Other markets are informational in
      // `/healthz.markets`.
      if (r.solTicked) state.lastTickAt = now;
      needReconnect = r.needsReconnect;
    } catch (e) {
      // Candidate discovery itself failed — no market is ticked this loop:
      // a tick without the candidates would advance the price sample with
      // nobody checked against it.
      console.error("tick failed", String(e));
      pushError(state, e);
      needReconnect = looksLikeAuthOrTimeout(e);
    }
    if (needReconnect) {
      try {
        await reconnect();
      } catch (re) {
        console.error("reconnect failed", String(re));
        pushError(state, re);
      }
    }

    // Root BEFORE commit, so `commit_aggregate` carries a freshly computed
    // `BalancesRoot`; the janitor last. Every step isolated (`runIsolated`),
    // so none of them ever kills this tick loop or skips the others.
    const now = Date.now();
    if (commitDue(lastCommitAttemptAt, now, COMMIT_INTERVAL_MS)) {
      lastCommitAttemptAt = now;
      const commitCtx = { conn, prog, crank: cfg.crank, feePayerConn, feePayerProg, feePayer: cfg.feePayer, pool, poolLive, balancesRoot, feeEscrow };
      const onStepError = (name: string, e: unknown): void => {
        console.error(`${name} cycle failed`, String(e));
        pushError(state, e);
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
            if (r.closed.length > 0 || r.errors.length > 0) console.log(`janitor: scanned=${r.scanned} closed=${r.closed.length} skipped=${r.skipped} errors=${r.errors.length}`);
          }],
        ],
        onStepError,
      );
      if (ok.includes("commit")) state.lastCommitAt = Date.now();
    }

    await sleep(Math.max(0, INTERVAL - (Date.now() - t0)));
  }
  console.log("crank stopped (requestStop)");
}
