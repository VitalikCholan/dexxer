// test/assets.test.ts — `/assets/:symbol`: the static JSON, the CoinGecko
// parsers, the cache (TTL, single flight, stale-on-failure) and the route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { circulatingRate, coinUrl, dominance, parseCoin, parseGlobal } from "../src/assets/coingecko.js";
import { assetsRouter } from "../src/assets/http.js";
import { createAssetService, RETRY_MS, type FetchFn } from "../src/assets/service.js";
import { loadStaticAssets, parseStaticAssets } from "../src/assets/staticAssets.js";

const COIN = {
  market_cap_rank: 5,
  market_data: {
    market_cap: { usd: 80_000_000_000 },
    fully_diluted_valuation: { usd: 90_000_000_000 },
    total_volume: { usd: 3_000_000_000 },
    circulating_supply: 500_000_000,
    max_supply: null,
    total_supply: 600_000_000,
    ath: { usd: 293.31 },
    ath_date: { usd: "2021-11-06T21:54:35.825Z" },
    atl: { usd: 0.5 },
    atl_date: { usd: "2020-05-11T19:35:23.449Z" },
  },
};
const GLOBAL = { data: { total_market_cap: { usd: 4_000_000_000_000 } } };

function fakeFetch(handlers: { coin?: () => unknown; global?: () => unknown; calls?: string[] } = {}): FetchFn {
  return async (url) => {
    handlers.calls?.push(url);
    const isGlobal = url.endsWith("/global");
    const make = isGlobal ? (handlers.global ?? (() => GLOBAL)) : (handlers.coin ?? (() => COIN));
    try {
      const body = make();
      return { ok: true, status: 200, json: async () => body };
    } catch {
      return { ok: false, status: 429, json: async () => ({}) };
    }
  };
}

test("assets.json loads and every symbol is complete", () => {
  const a = loadStaticAssets();
  assert.deepEqual([...a.keys()].sort(), ["BTC", "ETH", "HYPE", "SOL", "ZEC"]);
  for (const x of a.values()) {
    assert.ok(x.overview.length > 40 && x.utility.length > 40 && x.ecosystem.length > 40, x.symbol);
    assert.match(x.launchDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(a.get("HYPE")!.links.whitepaper, null);
});

test("static assets: only https links, valid dates and symbols", () => {
  const ok = {
    SOL: { name: "S", ticker: "SOL", coingeckoId: "solana", launchDate: "2020-03-16", overview: "o", utility: "u", ecosystem: "e", links: { website: "https://a.io", whitepaper: null, explorer: "https://b.io", github: "https://c.io" } },
  };
  assert.equal(parseStaticAssets(ok).get("SOL")!.links.website, "https://a.io/");
  const withLink = (website: unknown) => ({ SOL: { ...ok.SOL, links: { ...ok.SOL.links, website } } });
  assert.throws(() => parseStaticAssets(withLink("http://a.io")), /https/);
  assert.throws(() => parseStaticAssets(withLink("javascript:alert(1)")), /https/);
  assert.throws(() => parseStaticAssets(withLink("nope")), /not a URL/);
  assert.throws(() => parseStaticAssets({ SOL: { ...ok.SOL, launchDate: "16/03/2020" } }), /YYYY-MM-DD/);
  assert.throws(() => parseStaticAssets({ "sol!": ok.SOL }), /bad symbol/);
  assert.throws(() => parseStaticAssets({ SOL: { ...ok.SOL, name: "" } }), /non-empty/);
  assert.throws(() => parseStaticAssets([]), /object/);
});

test("parseCoin: reads rank, caps, supply, ATH/ATL; gaps become null, never 0", () => {
  const c = parseCoin(COIN);
  assert.equal(c.rank, 5);
  assert.equal(c.marketCap, 80_000_000_000);
  assert.equal(c.fullyDilutedMarketCap, 90_000_000_000);
  assert.equal(c.volume24h, 3_000_000_000);
  assert.equal(c.maxSupply, null);
  assert.deepEqual(c.ath, { price: 293.31, date: "2021-11-06T21:54:35.825Z" });
  const sparse = parseCoin({ market_cap_rank: null, market_data: { market_cap: { usd: null }, circulating_supply: -1, ath: { usd: 1 } } });
  assert.equal(sparse.rank, null);
  assert.equal(sparse.marketCap, null);
  assert.equal(sparse.circulatingSupply, null);
  assert.equal(sparse.ath, null, "a price without a date is not a point");
  assert.throws(() => parseCoin({}), /market_data/);
  assert.throws(() => parseCoin(null), /object/);
});

test("parseGlobal / dominance / circulatingRate", () => {
  assert.equal(parseGlobal(GLOBAL), 4_000_000_000_000);
  assert.throws(() => parseGlobal({ data: {} }), /total market cap/);
  assert.equal(dominance(80, 4000), 2);
  assert.equal(dominance(null, 4000), null);
  assert.equal(dominance(80, 0), null);
  assert.equal(circulatingRate(500, 600)?.toFixed(2), "83.33");
  assert.equal(circulatingRate(700, 600), 100);
  assert.equal(circulatingRate(1, null), null);
});

test("coinUrl encodes the id and asks for market data only", () => {
  const u = coinUrl("a/b");
  assert.ok(u.includes("/coins/a%2Fb?"));
  assert.ok(u.includes("tickers=false") && u.includes("community_data=false"));
});

test("service: merges static text with market data and computes derived fields", async () => {
  const svc = createAssetService({ assets: loadStaticAssets(), fetch: fakeFetch(), ttlMs: 600_000 });
  const a = await svc.get("SOL");
  assert.ok(a);
  assert.equal(a.name, "Solana");
  assert.equal(a.market?.rank, 5);
  assert.equal(a.market?.dominance, 2);
  assert.equal(a.market?.circulatingRate?.toFixed(2), "83.33");
  assert.equal(a.source, "CoinGecko");
  assert.equal(a.stale, false);
  assert.equal(await svc.get("DOGE"), null);
});

test("service: caches for the TTL, one upstream fetch per asset, shared by concurrent calls", async () => {
  const calls: string[] = [];
  let t = 1_000_000;
  const svc = createAssetService({ assets: loadStaticAssets(), fetch: fakeFetch({ calls }), ttlMs: 600_000, now: () => t });
  await Promise.all([svc.get("SOL"), svc.get("SOL"), svc.get("SOL")]);
  assert.equal(calls.filter((u) => u.includes("/coins/solana")).length, 1);
  assert.equal(calls.filter((u) => u.endsWith("/global")).length, 1);
  t += 599_000;
  await svc.get("SOL");
  assert.equal(calls.length, 2, "still fresh");
  await svc.get("BTC");
  assert.equal(calls.filter((u) => u.includes("/coins/bitcoin")).length, 1);
  assert.equal(calls.filter((u) => u.endsWith("/global")).length, 1, "global is shared across assets");
  t += 2_000;
  await svc.get("SOL");
  assert.equal(calls.filter((u) => u.includes("/coins/solana")).length, 2, "refreshed after the TTL");
});

test("service: upstream down with nothing cached still serves the text (market null)", async () => {
  const svc = createAssetService({
    assets: loadStaticAssets(),
    fetch: fakeFetch({
      coin: () => {
        throw new Error("429");
      },
    }),
    ttlMs: 600_000,
  });
  const a = await svc.get("ETH");
  assert.ok(a);
  assert.equal(a.market, null);
  assert.equal(a.updatedAt, null);
  assert.equal(a.stale, false);
  assert.ok(a.overview.length > 0);
});

test("service: a failed refresh keeps the last good numbers, marked stale, and backs off", async () => {
  const calls: string[] = [];
  let fail = false;
  let t = 5_000_000;
  const svc = createAssetService({
    assets: loadStaticAssets(),
    fetch: fakeFetch({
      calls,
      coin: () => {
        if (fail) throw new Error("down");
        return COIN;
      },
    }),
    ttlMs: 600_000,
    now: () => t,
  });
  const first = await svc.get("SOL");
  assert.equal(first?.stale, false);
  const fetchedAt = first?.updatedAt;
  fail = true;
  t += 700_000;
  const second = await svc.get("SOL");
  assert.equal(second?.stale, true);
  assert.equal(second?.updatedAt, fetchedAt);
  assert.equal(second?.market?.marketCap, 80_000_000_000);
  const before = calls.length;
  await svc.get("SOL");
  assert.equal(calls.length, before, "no new upstream call inside the retry backoff");
  t += RETRY_MS;
  fail = false;
  const third = await svc.get("SOL");
  assert.equal(third?.stale, false);
  assert.ok((third?.updatedAt ?? 0) > (fetchedAt ?? 0));
});

test("service: a malformed upstream body is a failure, not a crash", async () => {
  const svc = createAssetService({ assets: loadStaticAssets(), fetch: fakeFetch({ coin: () => ({ nope: 1 }) }), ttlMs: 600_000 });
  assert.equal((await svc.get("SOL"))?.market, null);
});

test("service: the demo key is sent as a header when configured", async () => {
  const seen: Record<string, string>[] = [];
  const f: FetchFn = async (url, init) => {
    seen.push(init?.headers ?? {});
    return { ok: true, status: 200, json: async () => (url.endsWith("/global") ? GLOBAL : COIN) };
  };
  await createAssetService({ assets: loadStaticAssets(), fetch: f, ttlMs: 60_000, apiKey: "k" }).get("SOL");
  assert.ok(seen.length > 0 && seen.every((h) => h["x-cg-demo-api-key"] === "k"));
  seen.length = 0;
  await createAssetService({ assets: loadStaticAssets(), fetch: f, ttlMs: 60_000 }).get("SOL");
  assert.ok(seen.every((h) => !("x-cg-demo-api-key" in h)));
});

test("GET /assets/:symbol: 200 with caching header, case-insensitive, 404 for unknown", async () => {
  const app = express();
  app.use(assetsRouter(createAssetService({ assets: loadStaticAssets(), fetch: fakeFetch(), ttlMs: 600_000 })));
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/assets/sol`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "public, max-age=60");
    const body = (await ok.json()) as { symbol: string; market: { rank: number }; links: { website: string } };
    assert.equal(body.symbol, "SOL");
    assert.equal(body.market.rank, 5);
    assert.match(body.links.website, /^https:/);
    const missing = await fetch(`${base}/assets/DOGE`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
