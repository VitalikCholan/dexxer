// services/relayer/src/indexer/tickers.ts
//
// One market's 24h ticker from the stored 1h candle tier (spec 2026-10-05
// market selector, §3.2). Pure: the route reads the candles, this does the
// arithmetic. Prices are 1e6 fixed point, served as decimal strings like the
// rest of the indexer; `change24h` is a plain fraction.
import type { CandleRow } from "./store.js";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Start of the hour bucket that contains `now − 24h` — the first candle of a full window. */
export function tickerWindowStart(now: number): number {
  return Math.floor((now - DAY_MS) / HOUR_MS) * HOUR_MS;
}

export interface Ticker {
  symbol: string;
  price: string | null;
  /** `(last close − open 24h ago) / open 24h ago`; `null` with under 24h of history or a zero open. */
  change24h: number | null;
  high24h: string | null;
  low24h: string | null;
}

export function tickerFrom(symbol: string, candles: readonly CandleRow[], now: number): Ticker {
  const start = tickerWindowStart(now);
  const w = candles.filter((x) => x.t >= start).sort((a, b) => a.t - b.t);
  if (w.length === 0) return { symbol, price: null, change24h: null, high24h: null, low24h: null };
  const first = w[0];
  const last = w[w.length - 1];
  let high = first.h;
  let low = first.l;
  for (const x of w) {
    if (x.h > high) high = x.h;
    if (x.l < low) low = x.l;
  }
  const full = first.t === start;
  const change24h = full && first.o > 0n ? Number(last.c - first.o) / Number(first.o) : null;
  return { symbol, price: last.c.toString(), change24h, high24h: high.toString(), low24h: low.toString() };
}
