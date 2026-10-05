// app/src/lib/markets.ts
//
// The market registry (position slots, spec §2.9): the relayer's public
// `GET /markets` — every listed market's PDA, oracle feed and public `Market`
// params — and the globally selected market. A market is a symbol; the
// trader's position on it is the slot of `Positions` whose `market` equals the
// market PDA (`positions.ts`'s `slotFor`), so switching markets only changes
// which slot the screens read.
//
// The selection lives in a React context filled by `SelectedMarketProvider`
// (`marketStore.tsx`, which owns the AsyncStorage persistence) — kept out of
// this file so `parseMarkets` stays importable from Node tests.
import { createContext, useContext } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getJson } from './indexer'
import { IndexerShapeError, big, bool, num, obj, str } from './indexerCodec'
import { pdas } from './pdas'

export interface MarketInfo {
  symbol: string
  /** Display name from the relayer's asset table (`"Ethereum"`); `null` when unknown or from an older relayer. */
  name: string | null
  market: PublicKey
  feed: PublicKey
  params: {
    maxLevBps: number
    imrBps: number
    mmrBps: number
    openFeeBps: number
    closeFeeBps: number
    liqFeeBps: number
    oiCap: bigint
    maxPosition: bigint
    minSize: bigint
    maxStalenessSecs: bigint
    pausedOpen: boolean
  }
}

export const DEFAULT_SYMBOL = 'SOL'
/** Used until `/markets` answers (or when it fails): SOL's PDA is derived locally, its feed comes from the live `Market`. */
export const SOL_FALLBACK: Pick<MarketInfo, 'symbol' | 'market' | 'name'> = {
  symbol: DEFAULT_SYMBOL,
  market: pdas.market(),
  name: 'Solana',
}
export const MARKETS_KEY = ['indexer', 'markets'] as const

function pubkey(o: Record<string, unknown>, k: string, where: string): PublicKey {
  const v = str(o, k, where)
  try {
    return new PublicKey(v)
  } catch {
    throw new IndexerShapeError(where, `${k}: not a public key`)
  }
}

/** SOL first, the rest by symbol. */
export function sortMarkets(ms: MarketInfo[]): MarketInfo[] {
  return [...ms].sort((a, b) =>
    a.symbol === DEFAULT_SYMBOL ? -1 : b.symbol === DEFAULT_SYMBOL ? 1 : a.symbol.localeCompare(b.symbol),
  )
}

function optionalName(o: Record<string, unknown>, where: string): string | null {
  const v = o.name
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new IndexerShapeError(where, `name: expected a string or null`)
  return v
}

/** `GET /markets` (services/relayer/src/indexer/http.ts): u64 params as decimal strings. Throws `IndexerShapeError` naming the field. */
export function parseMarkets(v: unknown): MarketInfo[] {
  if (!Array.isArray(v)) throw new IndexerShapeError('markets', 'expected an array')
  return sortMarkets(
    v.map((row, i) => {
      const w = `markets[${i}]`
      const o = obj(row, w)
      const pw = `${w}.params`
      const p = obj(o.params, pw)
      return {
        symbol: str(o, 'symbol', w),
        name: optionalName(o, w),
        market: pubkey(o, 'market', w),
        feed: pubkey(o, 'feed', w),
        params: {
          maxLevBps: num(p, 'maxLevBps', pw),
          imrBps: num(p, 'imrBps', pw),
          mmrBps: num(p, 'mmrBps', pw),
          openFeeBps: num(p, 'openFeeBps', pw),
          closeFeeBps: num(p, 'closeFeeBps', pw),
          liqFeeBps: num(p, 'liqFeeBps', pw),
          oiCap: big(p, 'oiCap', pw),
          maxPosition: big(p, 'maxPosition', pw),
          minSize: big(p, 'minSize', pw),
          maxStalenessSecs: big(p, 'maxStalenessSecs', pw),
          pausedOpen: bool(p, 'pausedOpen', pw),
        },
      }
    }),
  )
}

/** The market registry, SOL first. Refreshed at most once a minute (the relayer re-reads its registry every `MARKETS_REFRESH_MS`). */
export function useMarkets(): UseQueryResult<MarketInfo[]> {
  return useQuery({ queryKey: MARKETS_KEY, queryFn: () => getJson('/markets', parseMarkets), staleTime: 60_000 })
}

/**
 * The symbol the screens trade: the stored one, unless the registry has
 * loaded and does not list it (a delisted market, or garbage in storage) —
 * then SOL. Before the registry answers the stored symbol is kept, so a BTC
 * trader does not flash SOL on every cold start.
 */
export function resolveSymbol(stored: string | null, markets: MarketInfo[] | undefined): string {
  if (!stored || !/^[A-Z0-9]{1,8}$/.test(stored)) return DEFAULT_SYMBOL
  if (markets && !markets.some((m) => m.symbol === stored)) return DEFAULT_SYMBOL
  return stored
}

export interface SelectedMarket {
  symbol: string
  setSymbol: (s: string) => void
}

export const SelectedMarketContext = createContext<SelectedMarket>({ symbol: DEFAULT_SYMBOL, setSymbol: () => {} })

/** The globally selected market (persisted under `dexxer.market`, see `marketStore.tsx`); `'SOL'` by default. */
export function useSelectedMarket(): SelectedMarket {
  return useContext(SelectedMarketContext)
}
