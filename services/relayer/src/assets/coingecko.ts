// services/relayer/src/assets/coingecko.ts
//
// The numeric half of `/assets/:symbol`: one CoinGecko `coins/{id}` call per
// asset plus one shared `global` call (for market dominance). CoinGecko's free
// API needs no key; `COINGECKO_API_KEY` (a demo key) only raises the rate
// limit. Parsing is strict about shape and lenient about gaps: any field the
// API leaves out or sets to null becomes `null`, never 0.
export interface PricePoint {
  /** USD. */
  price: number;
  /** ISO timestamp. */
  date: string;
}

export interface CoinStats {
  rank: number | null;
  marketCap: number | null;
  fullyDilutedMarketCap: number | null;
  /** 24h SPOT volume across all venues (not this protocol's). */
  volume24h: number | null;
  circulatingSupply: number | null;
  maxSupply: number | null;
  totalSupply: number | null;
  ath: PricePoint | null;
  atl: PricePoint | null;
}

const BASE = "https://api.coingecko.com/api/v3";

export function coinUrl(id: string): string {
  return `${BASE}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
}
export const GLOBAL_URL = `${BASE}/global`;

function obj(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`coingecko ${where}: expected an object`);
  return v as Record<string, unknown>;
}

/** A finite, non-negative number, else `null`. */
function amount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function usd(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  return v !== null && typeof v === "object" ? amount((v as Record<string, unknown>).usd) : null;
}

function point(m: Record<string, unknown>, priceKey: string, dateKey: string): PricePoint | null {
  const price = usd(m, priceKey);
  const d = m[dateKey];
  const date = d !== null && typeof d === "object" ? (d as Record<string, unknown>).usd : null;
  if (price === null || typeof date !== "string" || Number.isNaN(Date.parse(date))) return null;
  return { price, date };
}

export function parseCoin(body: unknown): CoinStats {
  const o = obj(body, "coin");
  const m = obj(o.market_data, "coin.market_data");
  const rank = o.market_cap_rank;
  return {
    rank: typeof rank === "number" && Number.isInteger(rank) && rank > 0 ? rank : null,
    marketCap: usd(m, "market_cap"),
    fullyDilutedMarketCap: usd(m, "fully_diluted_valuation"),
    volume24h: usd(m, "total_volume"),
    circulatingSupply: amount(m.circulating_supply),
    maxSupply: amount(m.max_supply),
    totalSupply: amount(m.total_supply),
    ath: point(m, "ath", "ath_date"),
    atl: point(m, "atl", "atl_date"),
  };
}

/** Total crypto market cap in USD (the denominator of market dominance). */
export function parseGlobal(body: unknown): number {
  const d = obj(obj(body, "global").data, "global.data");
  const total = usd(d, "total_market_cap");
  if (total === null || total === 0) throw new Error("coingecko global: no total market cap");
  return total;
}

/** Share of the whole crypto market, in percent. */
export function dominance(marketCap: number | null, total: number | null): number | null {
  if (marketCap === null || total === null || total <= 0) return null;
  return (marketCap / total) * 100;
}

/** Circulating / total supply, in percent (capped at 100). */
export function circulatingRate(circulating: number | null, total: number | null): number | null {
  if (circulating === null || total === null || total <= 0) return null;
  return Math.min(100, (circulating / total) * 100);
}
