// app/src/features/markets/marketList.ts
//
// The markets screen's view data (spec 2026-10-05 market selector, §4.4).
// Pure: no hooks, no I/O — MarketsScreen feeds it the registry, /tickers,
// the WS mark cache and the owner's Positions.
import { DEFAULT_SYMBOL, SOL_FALLBACK, type MarketInfo } from '@/src/lib/markets'
import type { Ticker } from '@/src/lib/tickers'
import { MAX_SLOTS, type DecodedPositions } from '@/src/lib/positions'
import { maxLeverage } from '../trade/headerStats'

export type MarketTab = 'all' | 'favorites' | 'positions'
export type MarketSort = 'az' | 'up' | 'down'

export interface MarketRow {
  symbol: string
  name: string | null
  /** Live WS mark if cached, else the /tickers close; 1e6. `null` = no data (shown as "—"). */
  price: bigint | null
  change24h: number | null
  maxLeverage: number | null
  paused: boolean
  hasPosition: boolean
  hasOrders: boolean
  favorite: boolean
  selected: boolean
}

export interface MarketRowsInput {
  markets: MarketInfo[]
  tickers: Ticker[]
  marks: Record<string, bigint | null>
  positions: DecodedPositions | null
  favorites: readonly string[]
  selected: string
}

export function marketRows({ markets, tickers, marks, positions, favorites, selected }: MarketRowsInput): MarketRow[] {
  const tickerOf = new Map(tickers.map((t) => [t.symbol, t]))
  const base =
    markets.length > 0
      ? markets.map((m) => ({ symbol: m.symbol, name: m.name, key: m.market, params: m.params }))
      : [{ symbol: DEFAULT_SYMBOL, name: SOL_FALLBACK.name, key: SOL_FALLBACK.market, params: null }]
  return base.map((m) => {
    const t = tickerOf.get(m.symbol)
    return {
      symbol: m.symbol,
      name: m.name,
      price: marks[m.symbol] ?? t?.price ?? null,
      change24h: t?.change24h ?? null,
      maxLeverage: m.params ? maxLeverage(m.params.maxLevBps, m.params.imrBps) : null,
      paused: m.params?.pausedOpen ?? false,
      hasPosition: positions?.slots.some((s) => s.market.equals(m.key)) ?? false,
      hasOrders: positions?.orders.some((o) => o.market.equals(m.key)) ?? false,
      favorite: favorites.includes(m.symbol),
      selected: m.symbol === selected,
    }
  })
}

export function filterRows(rows: MarketRow[], query: string, tab: MarketTab): MarketRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => {
    if (tab === 'favorites' && !r.favorite) return false
    if (tab === 'positions' && !r.hasPosition && !r.hasOrders) return false
    if (q === '') return true
    return r.symbol.toLowerCase().includes(q) || (r.name?.toLowerCase().includes(q) ?? false)
  })
}

export function sortRows(rows: MarketRow[], mode: MarketSort): MarketRow[] {
  const out = [...rows]
  if (mode === 'az') {
    return out.sort((a, b) =>
      a.symbol === DEFAULT_SYMBOL ? -1 : b.symbol === DEFAULT_SYMBOL ? 1 : a.symbol.localeCompare(b.symbol),
    )
  }
  const dir = mode === 'up' ? -1 : 1
  return out.sort((a, b) => {
    if (a.change24h === null && b.change24h === null) return a.symbol.localeCompare(b.symbol)
    if (a.change24h === null) return 1
    if (b.change24h === null) return -1
    return dir * (a.change24h - b.change24h)
  })
}

export function slotUsage(positions: DecodedPositions | null): { used: number; max: number } | null {
  return positions ? { used: positions.slots.length, max: MAX_SLOTS } : null
}

export function parseSort(raw: string | null): MarketSort {
  return raw === 'up' || raw === 'down' ? raw : 'az'
}

/** 24h change for a row: `+0.83%` / `−2.00%` (U+2212); `—` without enough history. */
export function formatChange(c: number | null): string {
  if (c === null) return '—'
  const pct = c * 100
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`
}
