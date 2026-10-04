// services/relayer/src/assets/staticAssets.ts
//
// The text half of `/assets/:symbol` (token information tab): names,
// descriptions and links live in `services/relayer/assets/assets.json`, in the
// repo, so the copy does not depend on any external API being up. Only the
// numbers (market cap, supply, all-time highs …) come from CoinGecko
// (`coingecko.ts`). Loaded and validated once at start-up: a malformed file
// fails loudly there, not on a request.
import { readFileSync } from "node:fs";

export interface AssetLinks {
  website: string | null;
  whitepaper: string | null;
  explorer: string | null;
  github: string | null;
}

export interface StaticAsset {
  symbol: string;
  name: string;
  ticker: string;
  coingeckoId: string;
  /** ISO date (YYYY-MM-DD). */
  launchDate: string;
  overview: string;
  utility: string;
  ecosystem: string;
  links: AssetLinks;
}

const LINK_KEYS = ["website", "whitepaper", "explorer", "github"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z0-9]{1,8}$/;

export const DEFAULT_ASSETS_PATH = new URL("../../assets/assets.json", import.meta.url);

function text(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`assets.json ${where}.${k}: expected a non-empty string`);
  return v;
}

/** Links are opened by the app as-is, so only absolute `https:` URLs (or `null`) are accepted. */
function link(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`assets.json ${where}: expected a string or null`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`assets.json ${where}: not a URL`);
  }
  if (u.protocol !== "https:") throw new Error(`assets.json ${where}: only https links are allowed`);
  return u.toString();
}

export function parseStaticAssets(raw: unknown): Map<string, StaticAsset> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("assets.json: expected an object keyed by symbol");
  const out = new Map<string, StaticAsset>();
  for (const [symbol, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SYMBOL.test(symbol)) throw new Error(`assets.json: bad symbol ${JSON.stringify(symbol)}`);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`assets.json ${symbol}: expected an object`);
    const o = v as Record<string, unknown>;
    const launchDate = text(o, "launchDate", symbol);
    if (!DATE.test(launchDate)) throw new Error(`assets.json ${symbol}.launchDate: expected YYYY-MM-DD`);
    const l = o.links;
    if (l === null || typeof l !== "object" || Array.isArray(l)) throw new Error(`assets.json ${symbol}.links: expected an object`);
    const lo = l as Record<string, unknown>;
    const links = Object.fromEntries(LINK_KEYS.map((k) => [k, link(lo[k], `${symbol}.links.${k}`)])) as unknown as AssetLinks;
    out.set(symbol, {
      symbol,
      name: text(o, "name", symbol),
      ticker: text(o, "ticker", symbol),
      coingeckoId: text(o, "coingeckoId", symbol),
      launchDate,
      overview: text(o, "overview", symbol),
      utility: text(o, "utility", symbol),
      ecosystem: text(o, "ecosystem", symbol),
      links,
    });
  }
  return out;
}

export function loadStaticAssets(path: URL | string = DEFAULT_ASSETS_PATH): Map<string, StaticAsset> {
  return parseStaticAssets(JSON.parse(readFileSync(path, "utf8")));
}
