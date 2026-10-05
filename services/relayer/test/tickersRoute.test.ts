// services/relayer/test/tickersRoute.test.ts — GET /tickers: shape, cache, failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { indexerRouter, type IndexerRouterOpts } from "../src/indexer/http.js";
import type { DbPool } from "../src/db.js";
import { HOUR_MS, tickerWindowStart } from "../src/indexer/tickers.js";

const NOW = Date.UTC(2026, 9, 5, 12, 30);
const start = tickerWindowStart(NOW);

/** Fake pool: answers the 1h candle query with one full-window pair per market; counts calls; can be made to fail. */
function fakePool(state: { calls: number; fail: boolean }): DbPool {
  return {
    query: async (sql: string, params: unknown[]) => {
      state.calls++;
      if (state.fail) throw new Error("db down");
      assert.match(sql, /FROM candles/);
      assert.equal(params[1], "1h");
      return { rows: [
        { t: String(start), o: "100", h: "110", l: "90", c: "100" },
        { t: String(start + 24 * HOUR_MS), o: "100", h: "130", l: "95", c: "120" },
      ], rowCount: 2 };
    },
  } as unknown as DbPool;
}

async function withRouter(pool: DbPool, opts: Partial<IndexerRouterOpts>, fn: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(indexerRouter(pool, { markets: () => [], now: () => NOW, ...opts }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /tickers: one ticker per known market (SOL even with an empty registry)", async () => {
  const state = { calls: 0, fail: false };
  await withRouter(fakePool(state), {}, async (url) => {
    const res = await fetch(`${url}/tickers`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ symbol: "SOL", price: "120", change24h: 0.2, high24h: "130", low24h: "90" }]);
  });
});

test("GET /tickers: served from the cache inside the window, one DB round per refresh", async () => {
  const state = { calls: 0, fail: false };
  await withRouter(fakePool(state), { tickersCacheMs: 30_000 }, async (url) => {
    await fetch(`${url}/tickers`);
    await fetch(`${url}/tickers`);
    assert.equal(state.calls, 1);
  });
});

test("GET /tickers: DB failure with no cache → 503", async () => {
  const state = { calls: 0, fail: true };
  await withRouter(fakePool(state), {}, async (url) => {
    const res = await fetch(`${url}/tickers`);
    assert.equal(res.status, 503);
  });
});

test("GET /tickers: DB failure after a good answer → the last cached answer", async () => {
  const state = { calls: 0, fail: false };
  let now = NOW;
  await withRouter(fakePool(state), { tickersCacheMs: 5_000, now: () => now }, async (url) => {
    const good = await (await fetch(`${url}/tickers`)).json();
    state.fail = true;
    now += 60_000; // cache expired
    const res = await fetch(`${url}/tickers`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), good);
  });
});
