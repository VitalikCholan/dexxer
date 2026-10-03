// services/relayer/src/indexer/candles.ts
//
// Pure candle aggregation — no DB, no network I/O (unit-tested directly in
// test/candles.test.ts). `pushTick` buckets a price tick into `tf` windows
// keyed by `bucketStart(tf, ts)` (timeframes.ts); a `Map` preserves
// insertion order in JS, so buckets come back ordered by first-seen time
// with no gaps ever synthesized for quiet periods (no empty buckets).
//
// Spec §2.10.4: `/prices` reads raw ticks only for `1s` (`aggregateCandles`);
// every other tf reads its stored tier (1m/1h/1d, store.ts `listCandles`)
// and merges it with `candlesForTf`. `planPrices` decides which, and how far
// back to read.
import { bucketStart, mergeCandles, nthPrevBucket, tierOf, type StoredTier, type Tf } from "./timeframes.js";
import type { CandleRow } from "./store.js";

export interface Candle {
  /** Bucket start, unix ms. */
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
}

export interface CandleSeries {
  tf: Tf;
  buckets: Map<number, Candle>;
}

export function newSeries(tf: Tf): CandleSeries {
  return { tf, buckets: new Map() };
}

export function pushTick(series: CandleSeries, ts: number, price: bigint | number): void {
  const p = typeof price === "bigint" ? price : BigInt(Math.trunc(price));
  const t = bucketStart(series.tf, ts);
  const existing = series.buckets.get(t);
  if (!existing) {
    series.buckets.set(t, { t, o: p, h: p, l: p, c: p });
    return;
  }
  existing.c = p;
  if (p > existing.h) existing.h = p;
  if (p < existing.l) existing.l = p;
}

/** Buckets in insertion (chronological) order; `limit` keeps only the most recent ones. */
export function seriesCandles(series: CandleSeries, limit?: number): Candle[] {
  const all = Array.from(series.buckets.values());
  return limit !== undefined ? all.slice(-limit) : all;
}

/** Aggregates a flat, ascending-by-ts tick list (as `store.ts::listTicks` returns) into up to `limit` candles for `tf`. */
export function aggregateCandles(ticks: { ts: number; price: bigint | number }[], tf: Tf, limit: number): Candle[] {
  const series = newSeries(tf);
  for (const tick of ticks) pushTick(series, tick.ts, tick.price);
  return seriesCandles(series, limit);
}

export type PricesPlan = { tier: "ticks"; since: number } | { tier: StoredTier; since: number };

/**
 * Where `/prices` reads from and since when. `1s`: raw ticks, `limit + 1`
 * seconds back (one bucket of margin). Others: the stored tier, from the
 * bucket `limit` tf-buckets before the current one — calendar-aware for
 * 1W/1M via `nthPrevBucket`.
 */
export function planPrices(tf: Tf, limit: number, now: number): PricesPlan {
  const tier = tierOf(tf);
  if (tier === "ticks") return { tier, since: now - (limit + 1) * 1000 };
  return { tier, since: nthPrevBucket(tf, bucketStart(tf, now), limit) };
}

/** Tier rows (ascending) → tf candles, newest `limit`. Returns whatever exists — never pads. */
export function candlesForTf(rows: readonly CandleRow[], tf: Tf, limit: number): Candle[] {
  return mergeCandles(rows, tf).slice(-limit);
}
