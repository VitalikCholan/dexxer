// app/src/lib/tickers.ts
//
// GET /tickers (services/relayer/src/indexer/http.ts): every market's 24h
// change in one answer — the same for every client, so it says nothing about
// which market this trader looks at. Polled once a minute, only while the
// markets screen is open.
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getJson } from './indexer'
import { IndexerShapeError, obj, str } from './indexerCodec'

export interface Ticker {
  symbol: string
  /** Last 1h close, 1e6 fixed point; `null` with no candles yet. */
  price: bigint | null
  /** Fraction (`0.0083` = +0.83 %); `null` with under 24h of history. */
  change24h: number | null
  high24h: bigint | null
  low24h: bigint | null
}

const DECIMAL = /^-?\d+$/

function nullableBig(o: Record<string, unknown>, k: string, where: string): bigint | null {
  const v = o[k]
  if (v === null) return null
  if (typeof v !== 'string' || !DECIMAL.test(v))
    throw new IndexerShapeError(where, `${k}: expected a decimal string or null`)
  return BigInt(v)
}

function nullableNum(o: Record<string, unknown>, k: string, where: string): number | null {
  const v = o[k]
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new IndexerShapeError(where, `${k}: expected a number or null`)
  return v
}

export function parseTickers(v: unknown): Ticker[] {
  if (!Array.isArray(v)) throw new IndexerShapeError('tickers', 'expected an array')
  return v.map((row, i) => {
    const w = `tickers[${i}]`
    const o = obj(row, w)
    return {
      symbol: str(o, 'symbol', w),
      price: nullableBig(o, 'price', w),
      change24h: nullableNum(o, 'change24h', w),
      high24h: nullableBig(o, 'high24h', w),
      low24h: nullableBig(o, 'low24h', w),
    }
  })
}

export const TICKERS_KEY = ['indexer', 'tickers'] as const

/** 24h tickers for every market; `enabled` only while the markets screen is mounted. */
export function useTickers(enabled: boolean): UseQueryResult<Ticker[]> {
  return useQuery({
    queryKey: TICKERS_KEY,
    queryFn: () => getJson('/tickers', parseTickers),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
  })
}
