// services/relayer/src/indexer/backfill.ts
//
// Spec §2.10.3: history for the stored candle tiers from the Pyth Pro
// History API (TradingView UDF: GET /v1/{channel}/history?symbol=&resolution=
// &from=&to=, bearer key). Pyth Pro IS the Lazer feed our oracle republishes
// (MagicBlock's Pricing Oracle keeps no history), so the market → symbol
// resolution goes by Lazer feed id (`MARKET_CATALOG[symbol].lazerFeedId` ==
// `/v1/symbols[].pyth_lazer_id`, keyless), never by name.
//
// Rows are written with source 'pyth_pro' and ON CONFLICT DO NOTHING
// (store.ts `insertBackfillCandles`): an oracle candle always wins, and gaps
// from relayer downtime get patched. Enabled only by PYTH_PRO_API_KEY; the
// key is sent as a header only and never logged. A 401 disables the job
// until restart; anything else is logged per market×tier and retried on the
// next run — after BACKFILL_RETRY_MS (not the full interval) when a run had
// errors or saw no markets. Public data in, public data out — the indexer's privacy rule holds.
import type { DbPool } from "../db.js";
import { envNum } from "../env.js";
import { insertBackfillCandles, type CandleRow } from "./store.js";
import { TIER_TF, bucketStart, type StoredTier } from "./timeframes.js";

export const PYTH_PRO_BASE = "https://pyth.dourolabs.app/v1";
/** ≥ `min_channel` of every market we list (HYPE: real_time, ZEC: fixed_rate@200ms). */
export const PYTH_PRO_CHANNEL = "fixed_rate@200ms";
export const TIER_RESOLUTION: Record<StoredTier, string> = { "1m": "1", "1h": "60", "1d": "D" };
const D = 86_400_000;
/** Per-request time span: ~2 880 / ~2 160 / ≤ 400 rows. */
export const TIER_CHUNK_MS: Record<StoredTier, number> = { "1m": 2 * D, "1h": 90 * D, "1d": 400 * D };

export interface BackfillEnv {
  apiKey: string | null;
  intervalMs: number;
  m1Days: number;
  h1Days: number;
  d1FromMs: number;
  requestGapMs: number;
}

/** Delay before the next run after one that had errors or saw no markets (a 429, a 5xx, a registry not read yet at boot). */
export const BACKFILL_RETRY_MS = envNum("BACKFILL_RETRY_MS", 600_000, 60_000);

export function backfillEnvFromProcess(): BackfillEnv {
  const key = process.env.PYTH_PRO_API_KEY?.trim() || null;
  const from = Date.parse(process.env.BACKFILL_1D_FROM ?? "");
  return {
    apiKey: key,
    intervalMs: envNum("BACKFILL_INTERVAL_MS", 86_400_000, 600_000),
    m1Days: envNum("BACKFILL_1M_DAYS", 7, 0),
    h1Days: envNum("BACKFILL_1H_DAYS", 90, 0),
    d1FromMs: Number.isFinite(from) ? from : Date.UTC(2025, 3, 1), // Pyth Pro history starts April 2025
    requestGapMs: envNum("BACKFILL_REQUEST_GAP_MS", 500, 0),
  };
}

export function resolveProSymbol(symbols: unknown, lazerFeedId: string): string | null {
  if (!Array.isArray(symbols)) return null;
  for (const s of symbols) {
    if (!s || typeof s !== "object") continue;
    const o = s as { pyth_lazer_id?: unknown; symbol?: unknown };
    if (String(o.pyth_lazer_id) === lazerFeedId && typeof o.symbol === "string") return o.symbol;
  }
  return null;
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

export class UdfError extends Error {}
export class AuthError extends Error {}

/** TradingView UDF history body → tier rows. Rows whose `t` is not a bucket start of the tier are dropped (counted), the rest is 1e6-scaled. */
export function parseUdfHistory(body: unknown, tier: StoredTier): { rows: CandleRow[]; misaligned: number } {
  if (!body || typeof body !== "object") throw new UdfError("history: body is not an object");
  const o = body as Record<string, unknown>;
  if (o.s === "no_data") return { rows: [], misaligned: 0 };
  if (o.s !== "ok") throw new UdfError(`history: status ${String(o.s)}${typeof o.errmsg === "string" ? ` (${o.errmsg})` : ""}`);
  const cols = [o.t, o.o, o.h, o.l, o.c];
  if (!cols.every(Array.isArray)) throw new UdfError("history: t/o/h/l/c must be arrays");
  const [t, op, hi, lo, cl] = cols as unknown[][];
  const n = t.length;
  if (![op, hi, lo, cl].every((a) => a.length === n)) throw new UdfError("history: t/o/h/l/c lengths differ");
  const rows: CandleRow[] = [];
  let misaligned = 0;
  for (let i = 0; i < n; i++) {
    const vals = [t[i], op[i], hi[i], lo[i], cl[i]];
    if (!vals.every((v) => typeof v === "number" && Number.isFinite(v))) throw new UdfError(`history: row ${i} is not numeric`);
    const tMs = (t[i] as number) * 1000;
    if (bucketStart(TIER_TF[tier], tMs) !== tMs) {
      misaligned += 1;
      continue;
    }
    rows.push({ t: tMs, o: toScaled(op[i] as number), h: toScaled(hi[i] as number), l: toScaled(lo[i] as number), c: toScaled(cl[i] as number) });
  }
  return { rows, misaligned };
}

export interface BackfillDeps {
  pool: DbPool;
  env: BackfillEnv;
  markets: () => { symbol: string }[];
  catalog: Record<string, { lazerFeedId: string }>;
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
  /** Markets `deps.markets()` returned (0 also when the symbols request failed first). */
  markets: number;
  /** 401 from Pyth Pro — the key is wrong or expired; the caller stops scheduling. */
  authFailed: boolean;
}

export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: BackfillResult = { rows: 0, perMarket: {}, skipped: [], errors: [], markets: 0, authFailed: false };
  if (!deps.env.apiKey) {
    result.skipped.push("disabled: PYTH_PRO_API_KEY not set");
    return result;
  }
  let symbols: unknown;
  try {
    const r = await deps.fetch(`${PYTH_PRO_BASE}/symbols?asset_type=crypto`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    symbols = await r.json();
  } catch (e) {
    result.errors.push(`symbols: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const markets = deps.markets();
  result.markets = markets.length;
  for (const m of markets) {
    const entry = deps.catalog[m.symbol];
    if (!entry) {
      result.skipped.push(`${m.symbol}: not in MARKET_CATALOG`);
      continue;
    }
    const pro = resolveProSymbol(symbols, entry.lazerFeedId);
    if (!pro) {
      result.skipped.push(`${m.symbol}: no Pyth Pro symbol with pyth_lazer_id ${entry.lazerFeedId}`);
      continue;
    }
    for (const w of backfillWindows(now, deps.env)) {
      try {
        let inserted = 0;
        for (const ch of chunkRanges(w.fromMs, w.toMs, TIER_CHUNK_MS[w.tier])) {
          const url =
            `${PYTH_PRO_BASE}/${PYTH_PRO_CHANNEL}/history?symbol=${encodeURIComponent(pro)}` +
            `&resolution=${TIER_RESOLUTION[w.tier]}&from=${Math.floor(ch.fromMs / 1000)}&to=${Math.floor(ch.toMs / 1000)}`;
          const r = await deps.fetch(url, { headers: { Authorization: `Bearer ${deps.env.apiKey}` } });
          if (r.status === 401) throw new AuthError("HTTP 401 — PYTH_PRO_API_KEY rejected");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const parsed = parseUdfHistory(await r.json(), w.tier);
          if (parsed.misaligned > 0) log(`backfill: ${m.symbol} ${w.tier} dropped ${parsed.misaligned} misaligned rows`);
          inserted += await insertBackfillCandles(deps.pool, m.symbol, w.tier, parsed.rows);
          if (deps.env.requestGapMs > 0) await sleep(deps.env.requestGapMs);
        }
        result.rows += inserted;
        result.perMarket[m.symbol] = (result.perMarket[m.symbol] ?? 0) + inserted;
        log(`backfill: ${m.symbol} ${w.tier} inserted=${inserted}`);
      } catch (e) {
        result.errors.push(`${m.symbol} ${w.tier}: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof AuthError) {
          result.authFailed = true;
          return result;
        }
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
}

/**
 * When the next run starts after one that ended with `r`: `null` = never (a
 * 401 — the key is rejected until restart); `retryMs` after a run with errors
 * or no markets (a bad first run must not wait a whole interval); otherwise
 * `intervalMs`. A run that threw is `r === null`.
 */
export function nextBackfillDelay(r: BackfillResult | null, intervalMs: number, retryMs: number): number | null {
  if (r?.authFailed) return null;
  if (r === null || r.errors.length > 0 || r.markets === 0) return retryMs;
  return intervalMs;
}

/** Runs once now, then after `env.intervalMs` (or `BACKFILL_RETRY_MS` after a bad run, `nextBackfillDelay`); a 401 disables further runs until restart. */
export function startBackfill(
  deps: BackfillDeps,
  timers: { setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } = {},
  retryMs = BACKFILL_RETRY_MS,
): { snapshot: () => BackfillSnapshot; stop: () => void } {
  const st = timers.setTimeout ?? setTimeout;
  const ct = timers.clearTimeout ?? clearTimeout;
  const snap: BackfillSnapshot = { enabled: deps.env.apiKey !== null, lastRunAt: null, lastOkAt: null, lastError: null, rows: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const scheduleNext = (delay: number | null): void => {
    if (stopped || delay === null) return;
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
      if (r.authFailed) snap.enabled = false;
    } catch (e) {
      snap.lastError = e instanceof Error ? e.message : String(e);
      console.error("backfill: run failed", snap.lastError);
    }
    scheduleNext(nextBackfillDelay(result, deps.env.intervalMs, retryMs));
  };
  if (snap.enabled) {
    void run();
  } else {
    console.log("backfill: PYTH_PRO_API_KEY not set — candle history accrues from oracle ticks only");
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
