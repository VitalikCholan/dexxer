// services/relayer/test/pricesRoute.test.ts — `/prices` on all 16 tfs with a
// fake pg pool (records the SQL and returns no rows). The real SQL runs in
// indexerDb.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { indexerRouter } from "../src/indexer/http.js";
import type { DbPool } from "../src/db.js";
import { TIMEFRAMES } from "../src/indexer/timeframes.js";

function fakePool(calls: { sql: string; params: unknown[] }[]): DbPool {
  return { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } } as unknown as DbPool;
}

async function withRouter(calls: { sql: string; params: unknown[] }[], fn: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(indexerRouter(fakePool(calls), { markets: () => [] }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /prices: every one of the 16 tfs answers 200 with the unchanged shape", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  await withRouter(calls, async (url) => {
    for (const tf of TIMEFRAMES) {
      const res = await fetch(`${url}/prices?tf=${tf}&limit=5`);
      assert.equal(res.status, 200, tf);
      assert.deepEqual(await res.json(), { market: "SOL", tf, candles: [] });
    }
  });
  const ticks = calls.filter((c) => /FROM ticks/.test(c.sql));
  const candles = calls.filter((c) => /FROM candles/.test(c.sql));
  assert.equal(ticks.length, 1); // 1s only
  assert.equal(candles.length, 15);
  assert.deepEqual(candles.map((c) => c.params[1]), ["1m", "1m", "1m", "1m", "1h", "1h", "1h", "1h", "1h", "1h", "1d", "1d", "1d", "1d", "1d"]);
});

test("GET /prices: unknown tf → 400 listing every accepted tf; default tf is 1m", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  await withRouter(calls, async (url) => {
    const bad = await fetch(`${url}/prices?tf=7m`);
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: string };
    for (const tf of TIMEFRAMES) assert.ok(body.error.includes(tf), tf);
    const def = await fetch(`${url}/prices`);
    assert.equal(((await def.json()) as { tf: string }).tf, "1m");
  });
});
