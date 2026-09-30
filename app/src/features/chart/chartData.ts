// app/src/features/chart/chartData.ts
//
// Pure data side of the TradingView-style chart (C.5): the 12 chart types
// as renderings of the same OHLC candles, Heikin Ashi, EMA, and folding the
// live mark into the last candle. Everything the WebView draws is computed
// here, so it runs under `npm test`; `chartHtml.ts` only maps a `kind` onto
// a lightweight-charts series.
//
// Prices leave this file in dollars and times in UTC seconds — what
// lightweight-charts takes. Candles arrive 1e6-scaled with ms bucket starts
// (`indexer.ts`'s `Candle`). There is no volume: trade volume is private and
// the oracle has none, so no volume pane and no VWAP.
import type { Candle } from '@/src/lib/indexer'

export const CHART_TYPES = [
  { id: 'bars', label: 'Bars' },
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'line', label: 'Line' },
  { id: 'lineMarkers', label: 'Line with markers' },
  { id: 'step', label: 'Step line' },
  { id: 'area', label: 'Area' },
  { id: 'hlcArea', label: 'HLC area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'columns', label: 'Columns' },
  { id: 'highLow', label: 'High-low' },
  { id: 'heikinAshi', label: 'Heikin Ashi' },
] as const

export type ChartType = (typeof CHART_TYPES)[number]['id']

export const DEFAULT_FAVORITES: ChartType[] = ['candles', 'line']

export function isChartType(v: unknown): v is ChartType {
  return typeof v === 'string' && CHART_TYPES.some((t) => t.id === v)
}

export const TF_MS = { '1m': 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000 } as const
export type Tf = keyof typeof TF_MS

const SCALE = 1e6

export interface OhlcPoint {
  time: number
  open: number
  high: number
  low: number
  close: number
}
export interface ValuePoint {
  time: number
  value: number
}
export interface HlcPoint {
  time: number
  high: number
  low: number
  close: number
}

/** What the WebView draws: which series family, and its points. */
export type SeriesData =
  { kind: 'ohlc'; data: OhlcPoint[] } | { kind: 'value'; data: ValuePoint[] } | { kind: 'hlc'; data: HlcPoint[] }

/**
 * Fold the live mark (raw 1e6) into the candles: same bucket -> it becomes
 * the close and stretches high/low; a later bucket -> a new flat candle.
 * The indexer's candles refresh every 30 s, the mark every second.
 */
export function withLiveMark(candles: readonly Candle[], mark: bigint | null, tf: Tf, nowMs: number): Candle[] {
  if (mark === null || candles.length === 0) return [...candles]
  const p = Number(mark)
  const bucket = Math.floor(nowMs / TF_MS[tf]) * TF_MS[tf]
  const last = candles[candles.length - 1]
  if (bucket < last.t) return [...candles]
  if (bucket === last.t) {
    return [...candles.slice(0, -1), { ...last, c: p, h: Math.max(last.h, p), l: Math.min(last.l, p) }]
  }
  return [...candles, { t: bucket, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p }]
}

function ohlc(candles: readonly Candle[]): OhlcPoint[] {
  return candles.map((c) => ({
    time: Math.floor(c.t / 1000),
    open: c.o / SCALE,
    high: c.h / SCALE,
    low: c.l / SCALE,
    close: c.c / SCALE,
  }))
}

/** Heikin Ashi: close = OHLC mean, open = mean of the previous HA open/close, high/low widened to include both. */
export function heikinAshi(points: readonly OhlcPoint[]): OhlcPoint[] {
  const out: OhlcPoint[] = []
  for (const p of points) {
    const close = (p.open + p.high + p.low + p.close) / 4
    const prev = out[out.length - 1]
    const open = prev ? (prev.open + prev.close) / 2 : (p.open + p.close) / 2
    out.push({ time: p.time, open, close, high: Math.max(p.high, open, close), low: Math.min(p.low, open, close) })
  }
  return out
}

/** Exponential moving average of the closes, seeded with the first close; `k = 2 / (period + 1)`. */
export function ema(points: readonly { time: number; close: number }[], period: number): ValuePoint[] {
  const k = 2 / (period + 1)
  const out: ValuePoint[] = []
  let prev: number | null = null
  for (const p of points) {
    prev = prev === null ? p.close : p.close * k + prev * (1 - k)
    out.push({ time: p.time, value: prev })
  }
  return out
}

/** The series the chosen chart type draws, from the same candles. */
export function seriesFor(type: ChartType, candles: readonly Candle[]): SeriesData {
  const pts = ohlc(candles)
  switch (type) {
    case 'bars':
    case 'candles':
    case 'hollow':
      return { kind: 'ohlc', data: pts }
    case 'heikinAshi':
      return { kind: 'ohlc', data: heikinAshi(pts) }
    case 'highLow':
      // A box from low to high per bucket: open/close pinned to the range.
      return { kind: 'ohlc', data: pts.map((p) => ({ ...p, open: p.low, close: p.high })) }
    case 'hlcArea':
      return { kind: 'hlc', data: pts.map((p) => ({ time: p.time, high: p.high, low: p.low, close: p.close })) }
    default:
      return { kind: 'value', data: pts.map((p) => ({ time: p.time, value: p.close })) }
  }
}
