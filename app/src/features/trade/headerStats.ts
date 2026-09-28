// app/src/features/trade/headerStats.ts
//
// Pure numbers behind the market header (C.6-A): the max-leverage badge,
// the High/Low row over the fetched candles, and a compact USD for the
// pool's (100-dUSDC-rounded) liquidity. Kept out of `TradeHeader.tsx` so it
// runs under `npm test`.
import type { Candle } from '@/src/lib/indexer'

/** Highest integer leverage `risk::check_open` accepts — the tighter of `max_lev_bps` and `imr_bps`. */
export function maxLeverage(maxLevBps: number, imrBps: number): number {
  const byLev = Math.floor(maxLevBps / 10_000)
  const byImr = imrBps > 0 ? Math.floor(10_000 / imrBps) : byLev
  return Math.max(1, Math.min(byLev, byImr))
}

export interface RangeStats {
  /** 1e6-scaled, like the candles themselves. */
  high: number
  low: number
  /** "24H" when the candles cover a day, else the hours they do cover (the relayer may hold less). */
  label: string
}

const HOUR_MS = 3_600_000
/** A day's worth of 15m buckets can start up to one bucket late; still call it 24H. */
const FULL_DAY_MS = 23 * HOUR_MS

export function rangeStats(candles: readonly Candle[] | undefined, nowMs: number): RangeStats | null {
  if (!candles || candles.length === 0) return null
  let high = -Infinity
  let low = Infinity
  for (const c of candles) {
    if (c.h > high) high = c.h
    if (c.l < low) low = c.l
  }
  const span = nowMs - candles[0].t
  const label = span >= FULL_DAY_MS ? '24H' : `${Math.max(1, Math.round(span / HOUR_MS))}H`
  return { high, low, label }
}

/** Raw 1e6 USD -> `$950`, `$12.3K`, `$4.56M`. */
export function formatCompactUsd(raw1e6: bigint): string {
  const n = Number(raw1e6) / 1e6
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

/** Basis points -> percent text: 6 -> `0.06%`, 500 -> `5%`, 100 -> `1%`. */
export function formatBps(bps: number): string {
  const pct = bps / 100
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, '')}%`
}
