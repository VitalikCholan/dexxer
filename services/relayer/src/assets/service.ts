// services/relayer/src/assets/service.ts
//
// `/assets/:symbol` data: the repo's static text merged with CoinGecko numbers,
// cached in memory. Public market data only — nothing here touches a
// trader's account.
//   * One upstream fetch per asset per TTL (`ASSETS_CACHE_MS`, default 10 min),
//     shared by concurrent requests (single flight), plus one `global` fetch.
//   * A failed refresh keeps serving the last good numbers, marked `stale`;
//     with nothing cached yet the static text is still served and `market` is
//     null — the tab never errors because CoinGecko is down or rate-limiting.
//   * A failure is remembered for `RETRY_MS` so a dead upstream is not hit on
//     every request.
import { circulatingRate, coinUrl, dominance, GLOBAL_URL, parseCoin, parseGlobal, type CoinStats, type PricePoint } from "./coingecko.js";
import type { AssetLinks, StaticAsset } from "./staticAssets.js";

export const RETRY_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface MarketData extends CoinStats {
  /** Percent of the total crypto market cap. */
  dominance: number | null;
  /** Circulating / total supply, percent. */
  circulatingRate: number | null;
}

export interface AssetInfo {
  symbol: string;
  name: string;
  ticker: string;
  launchDate: string;
  overview: string;
  utility: string;
  ecosystem: string;
  links: AssetLinks;
  market: MarketData | null;
  source: "CoinGecko";
  /** When `market` was fetched (ms epoch), null with no data. */
  updatedAt: number | null;
  /** `market` is older than the TTL because the last refresh failed. */
  stale: boolean;
}

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AssetServiceOpts {
  assets: Map<string, StaticAsset>;
  fetch?: FetchFn;
  ttlMs: number;
  now?: () => number;
  apiKey?: string;
}

interface Cached<T> {
  value: T;
  at: number;
}

export interface AssetService {
  /** `null` = unknown symbol. Never throws for upstream problems. */
  get(symbol: string): Promise<AssetInfo | null>;
  symbols(): string[];
}

export function createAssetService(opts: AssetServiceOpts): AssetService {
  const now = opts.now ?? Date.now;
  const doFetch: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers["x-cg-demo-api-key"] = opts.apiKey;

  async function getJson(url: string): Promise<unknown> {
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`coingecko: HTTP ${res.status}`);
    return res.json();
  }

  // One cache slot per key, with single-flight refresh and failure backoff.
  function cache<T>(load: () => Promise<T>) {
    let hit: Cached<T> | null = null;
    let inflight: Promise<void> | null = null;
    let failedAt = -Infinity;
    return async (): Promise<{ value: T; at: number; stale: boolean } | null> => {
      const t = now();
      const fresh = hit !== null && t - hit.at < opts.ttlMs;
      if (!fresh && inflight === null && t - failedAt >= RETRY_MS) {
        inflight = load().then(
          (value) => {
            hit = { value, at: now() };
          },
          (e) => {
            failedAt = now();
            console.warn("assets: refresh failed", String(e));
          },
        ).finally(() => {
          inflight = null;
        });
      }
      if (!fresh && inflight !== null) await inflight;
      if (hit === null) return null;
      return { value: hit.value, at: hit.at, stale: now() - hit.at >= opts.ttlMs };
    };
  }

  const globalTotal = cache(async () => parseGlobal(await getJson(GLOBAL_URL)));
  const perAsset = new Map<string, ReturnType<typeof cache<CoinStats>>>();
  for (const a of opts.assets.values()) perAsset.set(a.symbol, cache(async () => parseCoin(await getJson(coinUrl(a.coingeckoId)))));

  return {
    symbols: () => [...opts.assets.keys()],
    async get(symbol) {
      const a = opts.assets.get(symbol);
      if (!a) return null;
      const [coin, total] = await Promise.all([perAsset.get(symbol)!(), globalTotal()]);
      const market: MarketData | null = coin
        ? {
            ...coin.value,
            dominance: dominance(coin.value.marketCap, total?.value ?? null),
            circulatingRate: circulatingRate(coin.value.circulatingSupply, coin.value.totalSupply),
          }
        : null;
      return {
        symbol: a.symbol,
        name: a.name,
        ticker: a.ticker,
        launchDate: a.launchDate,
        overview: a.overview,
        utility: a.utility,
        ecosystem: a.ecosystem,
        links: a.links,
        market,
        source: "CoinGecko",
        updatedAt: coin?.at ?? null,
        stale: coin?.stale ?? false,
      };
    },
  };
}

export type { PricePoint };
