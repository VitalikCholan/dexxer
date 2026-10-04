// app/src/lib/assets.ts
//
// Token information (C.7 «Token information» tab): the relayer's public
// `GET /assets/:symbol` (services/relayer/src/assets) — static text and links
// from the repo plus CoinGecko numbers. Public market data; nothing private.
// `parseAsset` validates the shape (naming the bad field, like `indexerCodec`)
// and only lets https links through, since the tab opens them in the browser.
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getJson } from './indexer'
import { IndexerShapeError, obj, str } from './indexerCodec'

export interface PricePoint {
  /** USD. */
  price: number
  /** ISO timestamp. */
  date: string
}

export interface AssetMarket {
  rank: number | null
  marketCap: number | null
  fullyDilutedMarketCap: number | null
  /** 24h SPOT volume across venues — not this protocol's. */
  volume24h: number | null
  /** Percent of the total crypto market cap. */
  dominance: number | null
  circulatingSupply: number | null
  maxSupply: number | null
  totalSupply: number | null
  /** Circulating / total supply, percent. */
  circulatingRate: number | null
  ath: PricePoint | null
  atl: PricePoint | null
}

export type AssetLinkKey = 'website' | 'whitepaper' | 'explorer' | 'github'
export const ASSET_LINK_KEYS: readonly AssetLinkKey[] = ['website', 'whitepaper', 'explorer', 'github']

export interface AssetInfo {
  symbol: string
  name: string
  ticker: string
  /** ISO date, YYYY-MM-DD. */
  launchDate: string
  overview: string
  utility: string
  ecosystem: string
  links: Record<AssetLinkKey, string | null>
  /** `null` while the market-data source has never answered. */
  market: AssetMarket | null
  /** Epoch ms the numbers were fetched, `null` without any. */
  updatedAt: number | null
  /** The numbers are older than the relayer's cache TTL (its last refresh failed). */
  stale: boolean
}

function nullableNum(o: Record<string, unknown>, k: string, where: string): number | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new IndexerShapeError(where, `${k}: expected a number or null`)
  return v
}

function point(v: unknown, where: string): PricePoint | null {
  if (v === null || v === undefined) return null
  const o = obj(v, where)
  const price = nullableNum(o, 'price', where)
  if (price === null) throw new IndexerShapeError(where, 'price: expected a number')
  return { price, date: str(o, 'date', where) }
}

/** Only absolute https URLs are kept; anything else is a shape error (never opened). */
function link(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || !/^https:\/\/[^\s]+$/i.test(v))
    throw new IndexerShapeError(where, 'expected an https URL or null')
  return v
}

function parseMarket(v: unknown): AssetMarket {
  const w = 'asset.market'
  const o = obj(v, w)
  return {
    rank: nullableNum(o, 'rank', w),
    marketCap: nullableNum(o, 'marketCap', w),
    fullyDilutedMarketCap: nullableNum(o, 'fullyDilutedMarketCap', w),
    volume24h: nullableNum(o, 'volume24h', w),
    dominance: nullableNum(o, 'dominance', w),
    circulatingSupply: nullableNum(o, 'circulatingSupply', w),
    maxSupply: nullableNum(o, 'maxSupply', w),
    totalSupply: nullableNum(o, 'totalSupply', w),
    circulatingRate: nullableNum(o, 'circulatingRate', w),
    ath: point(o.ath, `${w}.ath`),
    atl: point(o.atl, `${w}.atl`),
  }
}

export function parseAsset(v: unknown): AssetInfo {
  const w = 'asset'
  const o = obj(v, w)
  const l = obj(o.links, `${w}.links`)
  const updatedAt = nullableNum(o, 'updatedAt', w)
  return {
    symbol: str(o, 'symbol', w),
    name: str(o, 'name', w),
    ticker: str(o, 'ticker', w),
    launchDate: str(o, 'launchDate', w),
    overview: str(o, 'overview', w),
    utility: str(o, 'utility', w),
    ecosystem: str(o, 'ecosystem', w),
    links: Object.fromEntries(ASSET_LINK_KEYS.map((k) => [k, link(l[k], `${w}.links.${k}`)])) as AssetInfo['links'],
    market: o.market === null || o.market === undefined ? null : parseMarket(o.market),
    updatedAt,
    stale: o.stale === true,
  }
}

export const assetKey = (symbol: string) => ['asset', symbol] as const

/** `GET /assets/:symbol`. The relayer caches for minutes, so the app refetches rarely; an unknown symbol (404) is an error the tab shows as "not available". */
export function useAsset(symbol: string, enabled = true): UseQueryResult<AssetInfo> {
  return useQuery({
    queryKey: assetKey(symbol),
    queryFn: () => getJson(`/assets/${encodeURIComponent(symbol)}`, parseAsset),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}
