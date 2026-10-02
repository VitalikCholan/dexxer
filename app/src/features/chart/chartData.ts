// app/src/features/chart/chartData.ts
//
// Pure data side of the TradingView-style chart (C.5): the 12 chart types
// as renderings of the same OHLC candles, Heikin Ashi, EMA, folding the
// mark stream into the newest buckets, and when a mark may go to the page as
// a tick. Everything the WebView draws is computed
// here, so it runs under `npm test`; the 16 timeframes and their bucket
// arithmetic come from `timeframes.ts`; `chartHtml.ts` only maps a `kind` onto
// a lightweight-charts series.
//
// Prices leave this file in dollars and times in UTC seconds — what
// lightweight-charts takes. Candles arrive 1e6-scaled with ms bucket starts
// (`indexer.ts`'s `Candle`). There is no volume: trade volume is private and
// the oracle has none, so no volume pane and no VWAP.
import type { Candle } from '@/src/lib/indexer'
import { TIMEFRAMES, bucketStart, type Tf } from './timeframes'

export { TIMEFRAMES }
export type { Tf }

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
  | { kind: 'ohlc'; data: (OhlcPoint | Whitespace)[] }
  | { kind: 'value'; data: (ValuePoint | Whitespace)[] }
  | { kind: 'hlc'; data: (HlcPoint | Whitespace)[] }

/** A lightweight-charts whitespace item: a slot on the time axis with nothing drawn. */
export interface Whitespace {
  time: number
}

/** Longest gap (in steps) that gets filled; wider gaps stay gaps so a lone old candle cannot create thousands of slots. */
export const WHITESPACE_MAX_GAP = 1000

export function isWhitespace(p: { time: number; value?: unknown; close?: unknown; high?: unknown }): p is Whitespace {
  return p.value === undefined && p.close === undefined && p.high === undefined
}

/**
 * `1s` (spec §2.10.5): the oracle prints every ~2 s, so about every other
 * second has no candle. Whitespace keeps the time axis uniform without
 * inventing prices — the relayer never synthesizes buckets, the client
 * only marks where they are missing.
 */
export function fillWhitespace<P extends { time: number }>(
  points: readonly P[],
  stepSec: number,
  maxGap = WHITESPACE_MAX_GAP,
): (P | Whitespace)[] {
  const out: (P | Whitespace)[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i > 0) {
      const prev = points[i - 1].time
      const gap = Math.round((p.time - prev) / stepSec)
      if (gap > 1 && gap <= maxGap) for (let k = 1; k < gap; k++) out.push({ time: prev + k * stepSec })
    }
    out.push(p)
  }
  return out
}

/** One live mark from the indexer (`useMark`/WS), price raw 1e6 as a number. */
export interface MarkPoint {
  ts: number
  price: number
}

/** Upper bound on marks kept between two `/prices` fetches (1 s cadence → ~33 min). */
export const MARK_TAIL_MAX = 2000

/** A tail tagged with the `symbol|fetchStamp` key it was collected under. */
export interface KeyedTail {
  key: string
  marks: readonly MarkPoint[]
}

const EMPTY: readonly MarkPoint[] = []

/**
 * The tail valid for `key`: a tail collected under another market or fetch is
 * empty, in the same render — one shared empty array, so memos and effects
 * keyed on the tail do not re-fire for it.
 */
export function tailForKey(state: KeyedTail, key: string): readonly MarkPoint[] {
  return state.key === key ? state.marks : EMPTY
}

/** How a live mark reaches the WebView page. */
export type LiveUpdate = 'tick' | 'render' | 'none'

/**
 * A `tick` only moves the last bar of the series already on the page, so it
 * is sent only when the page holds this `symbol|tf` (`renderedFor`, null
 * before the first render). Otherwise — a market or timeframe switch whose
 * first mark beats the candle fetch — the page needs a full `render`, or the
 * new market's price would be drawn onto the old series. Nothing to draw → `none`.
 */
export function liveUpdateKind(renderedFor: string | null, current: string, hasData: boolean): LiveUpdate {
  if (!hasData) return 'none'
  return renderedFor === current ? 'tick' : 'render'
}

/**
 * Append the latest mark to the tail: nothing for a null/absent mark, a mark of
 * another market than `symbol`, or an exact repeat of the last one; oldest dropped past `max`.
 */
export function appendMark(
  tail: readonly MarkPoint[],
  mark: { ts: number | null; price: bigint | null; market: string } | undefined,
  symbol: string,
  max = MARK_TAIL_MAX,
): readonly MarkPoint[] {
  if (!mark || mark.market !== symbol || mark.ts === null || mark.price === null) return tail
  const price = Number(mark.price)
  const last = tail[tail.length - 1]
  if (last && last.ts === mark.ts && last.price === price) return tail
  return [...tail, { ts: mark.ts, price }].slice(-max)
}

/**
 * Fold live marks into the candles (spec §2.10.5): a mark in the newest
 * bucket becomes its close and stretches high/low; a mark in a later bucket
 * opens a new candle at the previous close; a mark older than the newest
 * candle is ignored — the fetch that produced the candles already saw it.
 * With no candles the marks alone build the series (a fresh `1s` chart).
 */
export function foldMarks(candles: readonly Candle[], marks: readonly MarkPoint[], tf: Tf): Candle[] {
  const out = [...candles]
  for (const m of marks) {
    const t = bucketStart(tf, m.ts)
    const last = out[out.length - 1]
    if (last && t < last.t) continue
    if (last && t === last.t) {
      out[out.length - 1] = { ...last, c: m.price, h: Math.max(last.h, m.price), l: Math.min(last.l, m.price) }
      continue
    }
    const open = last ? last.c : m.price
    out.push({ t, o: open, h: Math.max(open, m.price), l: Math.min(open, m.price), c: m.price })
  }
  return out
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
