// services/relayer/test/indexerDb.test.ts
//
// The indexer's SQL (pool-history pagination, per-market ticks) against a REAL Postgres — skipped unless TEST_DATABASE_URL points
// at a server this test may create/drop a scratch database on, e.g.
//   docker run -d --rm -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres npm test
// CI has no Postgres service, so there only indexerQuery.test.ts (the pure
// parsing half) runs.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import pg from "pg";
import { createPool, migrate, type DbPool } from "../src/db.js";
import {
  insertPoolSnapshot,
  insertTick,
  latestTick,
  listPoolSnapshots,
  listTicks,
} from "../src/indexer/store.js";
import { indexerRouter } from "../src/indexer/http.js";
import { parsePoolHistoryQuery } from "../src/indexer/query.js";
import { marketInfoFrom, type MarketInfo } from "../src/markets.js";
import { pdas, symbolBytes } from "../../../tests/er/lib/program.js";
import { BN } from "@coral-xyz/anchor";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : "TEST_DATABASE_URL not set (needs a real Postgres)";
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const DB_NAME = `dexxer_indexer_test_${process.pid}_${Date.now()}`;
let pool: DbPool;

before(async () => {
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  pool = createPool(url.toString()) as DbPool;
  await migrate(pool);
});

after(async () => {
  if (!ADMIN_URL) return;
  await pool.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});

beforeEach(async () => {
  if (!ADMIN_URL) return;
  await pool.query("TRUNCATE pool_snapshots, ticks");
});

const NOW = 1_800_000_000_000;

// --- store ---

dbTest("listPoolSnapshots: oldest-first within a page; the slot cursor pages backwards in time", async () => {
  for (const slot of [1, 2, 3, 4, 5]) {
    await insertPoolSnapshot(pool, { slot, ts: slot, capitalTotal: 1n, protocolLiquidity: 1n, lockedTotal: 0n, feesAccrued: 0n, insurance: 0n, badDebtTotal: 0n });
  }
  const page = async (query: Record<string, unknown>) => {
    const r = parsePoolHistoryQuery(query);
    assert.ok(r.ok);
    return (await listPoolSnapshots(pool, r.value)).map((s) => s.slot);
  };
  assert.deepEqual(await page({ limit: "2" }), [4, 5]);
  assert.deepEqual(await page({ limit: "2", cursor: "4" }), [2, 3]);
  assert.deepEqual(await page({ limit: "2", cursor: "2" }), [1]);
});

dbTest("ticks are per market; latestTick/listTicks never mix markets", async () => {
  await insertTick(pool, { market: "SOL", ts: NOW, price: 150_000_000n, slot: 1, publishTime: NOW });
  await insertTick(pool, { market: "BTC", ts: NOW, price: 80_000_000_000n, slot: 1, publishTime: NOW });
  assert.equal((await latestTick(pool, "SOL"))?.price, 150_000_000n);
  assert.equal((await latestTick(pool, "BTC"))?.price, 80_000_000_000n);
  assert.equal((await listTicks(pool, "BTC", NOW - 1)).length, 1);
  assert.equal(await latestTick(pool, "ETH"), null);
});

dbTest("migration 008: ticks' primary key is (market, ts) and a pre-008 row reads as SOL", async () => {
  // A row inserted without `market` is what a pre-008 row looks like after the migration's DEFAULT.
  await pool.query("INSERT INTO ticks (ts, price, slot, publish_time) VALUES ($1, 1, 1, $1)", [NOW - 5]);
  assert.equal((await latestTick(pool, "SOL"))?.ts, NOW - 5);
  const { rows } = await pool.query<{ col: string }>(
    `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'ticks'::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
  );
  assert.deepEqual(rows.map((r) => r.col), ["market", "ts"]);
});

// --- HTTP ---

function marketInfo(sym: string): MarketInfo {
  return marketInfoFrom(pdas.marketFor(sym), {
    symbol: Array.from(symbolBytes(sym)), feed: Keypair.generate().publicKey,
    maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500, openFeeBps: 6, closeFeeBps: 6, liqFeeBps: 100,
    oiCap: new BN(0), maxPosition: new BN("100000000000"), minSize: new BN(20_000), maxStalenessSecs: new BN(15),
    pausedOpen: false,
  });
}
const SOL_BTC = [marketInfo("SOL"), marketInfo("BTC")];

async function withIndexer(fn: (url: string) => Promise<void>, markets: () => MarketInfo[] = () => SOL_BTC) {
  const app = express();
  app.use(indexerRouter(pool, { markets }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

dbTest("GET /pool/history: 400 with a reason on a bad parameter", async () => {
  await withIndexer(async (url) => {
    const res = await fetch(`${url}/pool/history?cursor=x`);
    assert.equal(res.status, 400);
    assert.ok(((await res.json()) as { error: string }).error);
  });
});

dbTest("GET /pool/history: X-Next-Cursor is the oldest slot of a full page", async () => {
  for (const slot of [1, 2, 3]) {
    await insertPoolSnapshot(pool, { slot, ts: 1, capitalTotal: 1n, protocolLiquidity: 1n, lockedTotal: 0n, feesAccrued: 0n, insurance: 0n, badDebtTotal: 0n });
  }
  await withIndexer(async (url) => {
    const res = await fetch(`${url}/pool/history?limit=2`);
    assert.deepEqual(((await res.json()) as { slot: number }[]).map((s) => s.slot), [2, 3]);
    assert.equal(res.headers.get("x-next-cursor"), "2");
  });
});

dbTest("GET /mark and /prices: ?market= picks the market (default SOL), 400 on bad format, 404 on unknown", async () => {
  const t = Date.now();
  await insertTick(pool, { market: "SOL", ts: t, price: 150_000_000n, slot: 1, publishTime: t });
  await insertTick(pool, { market: "BTC", ts: t, price: 80_000_000_000n, slot: 2, publishTime: t });
  await withIndexer(async (url) => {
    const btc = await fetch(`${url}/mark?market=BTC`);
    assert.equal(btc.status, 200);
    const b = (await btc.json()) as { market: string; price: string; stale: boolean };
    assert.deepEqual({ market: b.market, price: b.price, stale: b.stale }, { market: "BTC", price: "80000000000", stale: false });
    const sol = (await (await fetch(`${url}/mark`)).json()) as { market: string; price: string };
    assert.deepEqual({ market: sol.market, price: sol.price }, { market: "SOL", price: "150000000" });

    assert.equal((await fetch(`${url}/mark?market=DOGE`)).status, 404);
    const bad = await fetch(`${url}/mark?market=btc`);
    assert.equal(bad.status, 400);
    assert.ok(((await bad.json()) as { error: string }).error);

    const prices = (await (await fetch(`${url}/prices?market=BTC&tf=1m`)).json()) as { market: string; tf: string; candles: { c: number }[] };
    assert.equal(prices.market, "BTC");
    assert.deepEqual(prices.candles.map((c) => c.c), [80_000_000_000]);
    assert.equal((await fetch(`${url}/prices?market=DOGE`)).status, 404);
    assert.equal((await fetch(`${url}/prices?market=b-t`)).status, 400);

    const list = (await (await fetch(`${url}/markets`)).json()) as { symbol: string }[];
    assert.deepEqual(list.map((m) => m.symbol), ["SOL", "BTC"]);
  });
});

dbTest("GET /mark: SOL stays queryable before the registry has loaded (empty list)", async () => {
  const t = Date.now();
  await insertTick(pool, { market: "SOL", ts: t, price: 150_000_000n, slot: 1, publishTime: t });
  await withIndexer(async (url) => {
    const res = await fetch(`${url}/mark`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { price: string }).price, "150000000");
    assert.equal((await fetch(`${url}/mark?market=BTC`)).status, 404);
  }, () => []);
});

// Needs no database: the removed routes never reach the pool, so a stub will do.
test("the disclosure endpoints are gone", async () => {
  const app = express();
  app.use(indexerRouter({} as DbPool, { markets: () => SOL_BTC }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/disclosures", "/stats"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
