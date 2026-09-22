// services/relayer/src/indexer/candles.ts
//
// Pure candle aggregation — no DB, no network I/O (unit-tested directly in
// test/candles.test.ts). `pushTick` buckets a price tick into `tfMs`-wide
// windows keyed by `Math.floor(ts / tfMs) * tfMs`; a `Map` preserves
// insertion order in JS, so buckets come back ordered by first-seen time
// with no gaps ever synthesized for quiet periods (no empty buckets).
//
// REST (`http.ts`'s `/prices`) reads raw ticks from Postgres (`store.ts`)
// and calls `aggregateCandles` on the fly for the requested timeframe —
// there is no materialised per-timeframe candle table, per the brief
// ("keep it simple").

export interface Candle {
  /** Bucket start, unix ms. */
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
}

export interface CandleSeries {
  tfMs: number;
  buckets: Map<number, Candle>;
}

export function newSeries(tfMs: number): CandleSeries {
  return { tfMs, buckets: new Map() };
}

export function pushTick(series: CandleSeries, ts: number, price: bigint | number): void {
  const p = typeof price === "bigint" ? price : BigInt(Math.trunc(price));
  const t = Math.floor(ts / series.tfMs) * series.tfMs;
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

/** Timeframe string ("1m"/"5m"/"15m") → bucket width in ms. */
export function tfMsOf(tf: string): number {
  switch (tf) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    default:
      throw new Error(`unknown timeframe: ${tf}`);
  }
}

/**
 * Aggregates a flat, ascending-by-ts tick list (as `store.ts::listTicks`
 * returns) into up to `limit` candles for timeframe `tf`. Pure — the only
 * thing `http.ts`'s `/prices` handler does with the rows it reads from the
 * DB.
 */
export function aggregateCandles(ticks: { ts: number; price: bigint | number }[], tf: string, limit: number): Candle[] {
  const series = newSeries(tfMsOf(tf));
  for (const tick of ticks) pushTick(series, tick.ts, tick.price);
  return seriesCandles(series, limit);
}
