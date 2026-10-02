// services/relayer/src/indexer/backfill.ts
//
// Spec §2.10.3: history for the stored candle tiers from the Hyperliquid
// public info API (`POST https://api.hyperliquid.xyz/info`, JSON, no key).
// Why Hyperliquid: keyless and permanent, perp prices, all five of our
// markets, and `1d` history since 2023 (SOL/ZEC; HYPE from its launch). The
// other free sources were measured on 01–02.10.2026 and are keyed or gone
// (Pyth Pro: trial key only; Pyth Benchmarks/Hermes: 401/404); Binance was
// rejected (`HYPEUSDT` spot listed only on 24.09.2026).
//
// Limits: `1m` reaches back only ≈ 4 days, ≤ 5000 candles per response (our
// chunks stay below it: 1m 2 d, 1h 90 d, 1d 400 d), `endTime` is INCLUSIVE
// (chunk boundaries repeat one candle — deduped per run, and harmless anyway
// under ON CONFLICT DO NOTHING), and the in-progress candle is returned too —
// dropped here, the live bucket belongs to the oracle. The coin is the market
// symbol, verified against `meta.universe` (a symbol outside it is skipped,
// never guessed). Rate limit 1200 weight/min per IP → BACKFILL_REQUEST_GAP_MS.
//
// Rows are written with source 'hyperliquid' and ON CONFLICT DO NOTHING
// (store.ts `insertBackfillCandles`): an oracle candle always wins, and gaps
// from relayer downtime get patched. Anything that fails is logged per
// market×tier and retried on the next run — after BACKFILL_RETRY_MS (not the
// full interval) when a run had errors or saw no markets. Public data in,
// public data out — the indexer's privacy rule holds.
import type { DbPool } from "../db.js";
import { envNum } from "../env.js";
import { insertBackfillCandles, type CandleRow } from "./store.js";
import { TIER_TF, bucketStart, type StoredTier } from "./timeframes.js";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const TIER_INTERVAL: Record<StoredTier, "1m" | "1h" | "1d"> = { "1m": "1m", "1h": "1h", "1d": "1d" };
const D = 86_400_000;
/** Per-request time span: ~2 880 / ~2 160 / ≤ 400 candles (the API caps a response at 5000). */
export const TIER_CHUNK_MS: Record<StoredTier, number> = { "1m": 2 * D, "1h": 90 * D, "1d": 400 * D };

export interface BackfillEnv {
  enabled: boolean;
  intervalMs: number;
  /** Delay before the next run after one that had errors or saw no markets (a 429, a 5xx, a registry not read yet at boot). */
  retryMs: number;
  m1Days: number;
  h1Days: number;
  d1FromMs: number;
  requestGapMs: number;
}

export function backfillEnvFromProcess(): BackfillEnv {
  const from = Date.parse(process.env.BACKFILL_1D_FROM ?? "");
  return {
    enabled: (process.env.BACKFILL_ENABLED ?? "true") !== "false",
    intervalMs: envNum("BACKFILL_INTERVAL_MS", 86_400_000, 600_000),
    retryMs: envNum("BACKFILL_RETRY_MS", 600_000, 60_000),
    m1Days: envNum("BACKFILL_1M_DAYS", 4, 0), // Hyperliquid keeps ≈ 4 days of 1m
    h1Days: envNum("BACKFILL_1H_DAYS", 90, 0),
    d1FromMs: Number.isFinite(from) ? from : Date.UTC(2023, 0, 1), // Hyperliquid's 1d history starts in 2023 (SOL); a later-listed coin just returns from its launch
    requestGapMs: envNum("BACKFILL_REQUEST_GAP_MS", 500, 0),
  };
}

export interface BackfillWindow { tier: StoredTier; fromMs: number; toMs: number }

export function backfillWindows(now: number, env: BackfillEnv): BackfillWindow[] {
  const all: BackfillWindow[] = [
    { tier: "1m", fromMs: now - env.m1Days * D, toMs: now },
    { tier: "1h", fromMs: now - env.h1Days * D, toMs: now },
    { tier: "1d", fromMs: env.d1FromMs, toMs: now },
  ];
  return all.filter((w) => w.fromMs < w.toMs);
}

export function chunkRanges(fromMs: number, toMs: number, chunkMs: number): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  for (let a = fromMs; a < toMs; a += chunkMs) out.push({ fromMs: a, toMs: Math.min(a + chunkMs, toMs) });
  return out;
}

export function toScaled(x: number): bigint {
  return BigInt(Math.round(x * 1e6));
}

export class HlError extends Error {}

/** `meta` body → the set of coin names (`universe[].name`). */
export function parseUniverse(body: unknown): Set<string> {
  const u = body && typeof body === "object" ? (body as { universe?: unknown }).universe : undefined;
  if (!Array.isArray(u)) throw new HlError("meta: universe is not an array");
  const names = new Set<string>();
  for (const e of u) {
    const n = e && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
    if (typeof n !== "string") throw new HlError("meta: universe entry without a name");
    names.add(n);
  }
  return names;
}

/** JSON body of a `candleSnapshot` request (`endTime` is inclusive). */
export function candleSnapshotBody(coin: string, tier: StoredTier, fromMs: number, toMs: number): string {
  return JSON.stringify({ type: "candleSnapshot", req: { coin, interval: TIER_INTERVAL[tier], startTime: fromMs, endTime: toMs } });
}

const decimal = (v: unknown): number | null => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * `candleSnapshot` body → completed, aligned rows. A row whose bucket has not
 * ended (`T >= now`, the in-progress candle) or whose `t` is not a bucket start
 * of the tier is dropped and counted; the rest is 1e6-scaled. A body that is
 * not an array, or a row without numeric `t`/`T` and decimal-string o/h/l/c, is
 * an `HlError`.
 */
export function parseCandleSnapshot(body: unknown, tier: StoredTier, now: number): { rows: CandleRow[]; misaligned: number; incomplete: number } {
  if (!Array.isArray(body)) throw new HlError("candleSnapshot: body is not an array");
  const rows: CandleRow[] = [];
  let misaligned = 0;
  let incomplete = 0;
  body.forEach((r, i) => {
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : null;
    const px = o ? [decimal(o.o), decimal(o.h), decimal(o.l), decimal(o.c)] : [];
    if (!o || typeof o.t !== "number" || !Number.isFinite(o.t) || typeof o.T !== "number" || !Number.isFinite(o.T) || px.length !== 4 || px.some((x) => x === null)) {
      throw new HlError(`candleSnapshot: row ${i} is malformed`);
    }
    if (o.T >= now) {
      incomplete += 1;
      return;
    }
    if (bucketStart(TIER_TF[tier], o.t) !== o.t) {
      misaligned += 1;
      return;
    }
    const [op, hi, lo, cl] = px as number[];
    rows.push({ t: o.t, o: toScaled(op), h: toScaled(hi), l: toScaled(lo), c: toScaled(cl) });
  });
  return { rows, misaligned, incomplete };
}

export interface BackfillDeps {
  pool: DbPool;
  env: BackfillEnv;
  markets: () => { symbol: string }[];
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface BackfillResult {
  rows: number;
  perMarket: Record<string, number>;
  skipped: string[];
  errors: string[];
  /** Markets `deps.markets()` returned (0 also when the `meta` request failed first). */
  markets: number;
}

const postInfo = (deps: BackfillDeps, body: string) =>
  deps.fetch(HYPERLIQUID_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });

export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: BackfillResult = { rows: 0, perMarket: {}, skipped: [], errors: [], markets: 0 };
  if (!deps.env.enabled) {
    result.skipped.push("disabled: BACKFILL_ENABLED=false");
    return result;
  }
  let universe: Set<string>;
  try {
    const r = await postInfo(deps, JSON.stringify({ type: "meta" }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    universe = parseUniverse(await r.json());
  } catch (e) {
    result.errors.push(`meta: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const markets = deps.markets();
  result.markets = markets.length;
  for (const m of markets) {
    if (!universe.has(m.symbol)) {
      result.skipped.push(`${m.symbol}: not in Hyperliquid universe`);
      continue;
    }
    for (const w of backfillWindows(now, deps.env)) {
      let inserted = 0;
      const seen = new Set<number>();
      try {
        for (const ch of chunkRanges(w.fromMs, w.toMs, TIER_CHUNK_MS[w.tier])) {
          const r = await postInfo(deps, candleSnapshotBody(m.symbol, w.tier, ch.fromMs, ch.toMs));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const parsed = parseCandleSnapshot(await r.json(), w.tier, now);
          if (parsed.misaligned > 0) log(`backfill: ${m.symbol} ${w.tier} dropped ${parsed.misaligned} misaligned rows`);
          if (parsed.incomplete > 0) log(`backfill: ${m.symbol} ${w.tier} dropped ${parsed.incomplete} incomplete rows`);
          const fresh = parsed.rows.filter((row) => !seen.has(row.t));
          for (const row of fresh) seen.add(row.t);
          const n = await insertBackfillCandles(deps.pool, m.symbol, w.tier, fresh);
          inserted += n;
          result.rows += n;
          result.perMarket[m.symbol] = (result.perMarket[m.symbol] ?? 0) + n;
          if (deps.env.requestGapMs > 0) await sleep(deps.env.requestGapMs);
        }
        log(`backfill: ${m.symbol} ${w.tier} inserted=${inserted}`);
      } catch (e) {
        result.errors.push(`${m.symbol} ${w.tier}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return result;
}

export interface BackfillSnapshot {
  enabled: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Rows inserted by the last run. */
  rows: number;
  source: "hyperliquid";
}

/**
 * When the next run starts after one that ended with `r`: `env.retryMs` after a
 * run with errors or no markets (a bad first run must not wait a whole
 * interval); otherwise `env.intervalMs`. A run that threw is `r === null`.
 */
export function nextBackfillDelay(r: BackfillResult | null, env: Pick<BackfillEnv, "intervalMs" | "retryMs">): number {
  if (r === null || r.errors.length > 0 || r.markets === 0) return env.retryMs;
  return env.intervalMs;
}

/** Runs once now, then after `env.intervalMs` (or `env.retryMs` after a bad run, `nextBackfillDelay`). */
export function startBackfill(
  deps: BackfillDeps,
  timers: { setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } = {},
): { snapshot: () => BackfillSnapshot; stop: () => void } {
  const st = timers.setTimeout ?? setTimeout;
  const ct = timers.clearTimeout ?? clearTimeout;
  const snap: BackfillSnapshot = { enabled: deps.env.enabled, lastRunAt: null, lastOkAt: null, lastError: null, rows: 0, source: "hyperliquid" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const scheduleNext = (delay: number): void => {
    if (stopped) return;
    timer = st(() => { timer = null; void run(); }, delay);
    (timer as { unref?: () => void }).unref?.();
  };
  const run = async (): Promise<void> => {
    const at = deps.now?.() ?? Date.now();
    snap.lastRunAt = at;
    let result: BackfillResult | null = null;
    try {
      const r = await runBackfill(deps);
      result = r;
      snap.rows = r.rows;
      for (const s of r.skipped) (deps.log ?? console.log)(`backfill: skipped ${s}`);
      if (r.errors.length === 0) {
        snap.lastOkAt = at;
        snap.lastError = null;
      } else {
        snap.lastError = r.errors.join("; ");
        for (const e of r.errors) console.error(`backfill: ${e}`);
      }
      if (r.markets === 0 && r.errors.length === 0) (deps.log ?? console.log)("backfill: no markets yet — retrying soon");
    } catch (e) {
      snap.lastError = e instanceof Error ? e.message : String(e);
      console.error("backfill: run failed", snap.lastError);
    }
    scheduleNext(nextBackfillDelay(result, deps.env));
  };
  if (snap.enabled) {
    void run();
  } else {
    console.log("backfill: BACKFILL_ENABLED=false — candle history accrues from oracle ticks only");
  }
  return {
    snapshot: () => ({ ...snap }),
    stop: () => {
      stopped = true;
      if (timer) ct(timer);
      timer = null;
    },
  };
}
