// services/relayer/test/indexerDb.test.ts
//
// The indexer's SQL (pagination, filters, /stats aggregates, the `market`
// backfill) against a REAL Postgres — skipped unless TEST_DATABASE_URL points
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
import { disclosureStats, insertDisclosure, insertPoolSnapshot, listDisclosures, listPoolSnapshots, type DisclosureRow } from "../src/indexer/store.js";
import { indexerRouter } from "../src/indexer/http.js";
import { parseDisclosureQuery, parsePoolHistoryQuery, parseStatsQuery } from "../src/indexer/query.js";

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
  await pool.query("TRUNCATE disclosures, pool_snapshots");
});

const M1 = Keypair.generate().publicKey.toBase58();
const M2 = Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function row(o: Partial<DisclosureRow> = {}): DisclosureRow {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    market: M1,
    side: "long",
    size: 1_000_000_000n,
    entry: 100_000_000n,
    exit: 101_000_000n,
    pnl: 1_000_000n,
    fees: 100_000n,
    reason: "user",
    openedSlot: 1n,
    closedSlot: 10n,
    nonce: 0n,
    ts: NOW - HOUR,
    ...o,
  };
}

function q(query: Record<string, unknown>) {
  const r = parseDisclosureQuery(query);
  assert.ok(r.ok, "test query must parse");
  return r.value;
}

// --- store ---

dbTest("insertDisclosure: true on a new row, false on a re-seen one; market is stored", async () => {
  const r = row();
  assert.equal(await insertDisclosure(pool, r), true);
  assert.equal(await insertDisclosure(pool, r), false);
  const [only] = await listDisclosures(pool, q({}));
  assert.equal(only.market, M1);
});

dbTest("insertDisclosure: backfills market on a pre-migration row WITHOUT reporting it as new (no WS re-broadcast)", async () => {
  const r = row();
  await pool.query(
    "INSERT INTO disclosures (pubkey, side, size, entry, exit, pnl, fees, reason, opened_slot, closed_slot, nonce, ts) VALUES ($1, 'long', 1, 1, 1, 0, 0, 'user', 1, 10, 0, 1)",
    [r.pubkey],
  );
  assert.equal(await insertDisclosure(pool, r), false);
  const { rows } = await pool.query("SELECT market FROM disclosures WHERE pubkey = $1", [r.pubkey]);
  assert.equal(rows[0].market, M1);
});

dbTest("listDisclosures: newest closed_slot first; the cursor walks every row exactly once, ties on closed_slot included", async () => {
  const rows = [row({ closedSlot: 30n }), row({ closedSlot: 20n }), row({ closedSlot: 20n }), row({ closedSlot: 20n }), row({ closedSlot: 10n })];
  for (const r of rows) await insertDisclosure(pool, r);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const items = await listDisclosures(pool, q({ limit: "2", ...(cursor ? { cursor } : {}) }));
    if (items.length === 0) break;
    seen.push(...items.map((i) => String(i.pubkey)));
    const last = items[items.length - 1];
    cursor = `${String(last.closed_slot)}.${String(last.pubkey)}`;
  }
  assert.equal(seen.length, rows.length);
  assert.equal(new Set(seen).size, rows.length);
  const slots = (await listDisclosures(pool, q({}))).map((i) => Number(i.closed_slot));
  assert.deepEqual(slots, [...slots].sort((a, b) => b - a));
});

dbTest("listDisclosures: side / reason / market / from / to filters", async () => {
  await insertDisclosure(pool, row({ side: "long", reason: "user", market: M1, ts: 1000 }));
  await insertDisclosure(pool, row({ side: "short", reason: "liquidated", market: M1, ts: 2000 }));
  await insertDisclosure(pool, row({ side: "long", reason: "liquidated", market: M2, ts: 3000 }));
  const count = async (query: Record<string, unknown>) => (await listDisclosures(pool, q(query))).length;
  assert.equal(await count({ side: "long" }), 2);
  assert.equal(await count({ reason: "liquidated" }), 2);
  assert.equal(await count({ market: M2 }), 1);
  assert.equal(await count({ from: "2000" }), 2);
  assert.equal(await count({ to: "2000" }), 2);
  assert.equal(await count({ from: "1500", to: "2500" }), 1);
  assert.equal(await count({ side: "long", reason: "liquidated", market: M2 }), 1);
});

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

dbTest("disclosureStats: counts, win rate, ceil-rounded opening notional, pnl/fees — within the window and market", async () => {
  await insertDisclosure(pool, row({ side: "long", size: 2_000_000_000n, entry: 100_000_000n, pnl: 5_000_000n, fees: 1_000_000n, reason: "user", market: M1, ts: NOW - 1 * HOUR }));
  await insertDisclosure(pool, row({ side: "short", size: 1_000_000_000n, entry: 150_000_000n, pnl: -3_000_000n, fees: 1_000_000n, reason: "liquidated", market: M1, ts: NOW - 2 * HOUR }));
  // 3 · 1 / 1e9 rounds UP to 1 — same as math.rs::notional (div_ceil).
  await insertDisclosure(pool, row({ side: "long", size: 3n, entry: 1n, pnl: 0n, fees: 0n, reason: "user", market: M2, ts: NOW - 3 * HOUR }));
  await insertDisclosure(pool, row({ side: "long", size: 1_000_000_000n, entry: 100_000_000n, pnl: 1_000_000n, fees: 0n, market: M1, ts: NOW - 48 * HOUR }));

  const stats = async (query: Record<string, unknown>) => {
    const r = parseStatsQuery(query, NOW);
    assert.ok(r.ok);
    return disclosureStats(pool, r.value);
  };

  const day = await stats({});
  assert.deepEqual(
    { trades: day.trades, longs: day.longs, shorts: day.shorts, liquidations: day.liquidations, wins: day.wins },
    { trades: 3, longs: 2, shorts: 1, liquidations: 1, wins: 1 },
  );
  assert.equal(day.win_rate, 1 / 3);
  assert.equal(day.volume_quote, "350000001");
  assert.equal(day.pnl_total, "2000000");
  assert.equal(day.fees_total, "2000000");

  const m1 = await stats({ market: M1 });
  assert.equal(m1.trades, 2);
  assert.equal(m1.win_rate, 0.5);
  assert.equal(m1.volume_quote, "350000000");

  assert.equal((await stats({ window: "7d" })).trades, 4);
  assert.equal((await stats({ window: "all" })).trades, 4);

  const empty = await stats({ market: Keypair.generate().publicKey.toBase58() });
  assert.deepEqual(
    { trades: empty.trades, win_rate: empty.win_rate, volume_quote: empty.volume_quote, pnl_total: empty.pnl_total },
    { trades: 0, win_rate: null, volume_quote: "0", pnl_total: "0" },
  );
});

// --- HTTP ---

async function withIndexer(fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(indexerRouter(pool, { now: () => NOW }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

dbTest("GET /disclosures: still a plain array; X-Next-Cursor only on a full page, and following it reaches the rest", async () => {
  for (const s of [5n, 4n, 3n]) await insertDisclosure(pool, row({ closedSlot: s }));
  await withIndexer(async (url) => {
    const first = await fetch(`${url}/disclosures?limit=2`);
    assert.equal(first.status, 200);
    const a = (await first.json()) as { closed_slot: string }[];
    assert.ok(Array.isArray(a));
    assert.equal(a.length, 2);
    const next = first.headers.get("x-next-cursor");
    assert.ok(next);
    const second = await fetch(`${url}/disclosures?limit=2&cursor=${encodeURIComponent(next)}`);
    const b = (await second.json()) as { closed_slot: string }[];
    assert.deepEqual(b.map((d) => Number(d.closed_slot)), [3]);
    assert.equal(second.headers.get("x-next-cursor"), null);
  });
});

dbTest("GET /disclosures, /pool/history and /stats: 400 with a reason on a bad parameter", async () => {
  await withIndexer(async (url) => {
    for (const path of ["/disclosures?side=up", "/disclosures?cursor=nope", "/pool/history?cursor=x", "/stats?window=1y"]) {
      const res = await fetch(url + path);
      assert.equal(res.status, 400, path);
      assert.ok(((await res.json()) as { error: string }).error, path);
    }
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

dbTest("GET /stats: the window and market echo back with the aggregates", async () => {
  await insertDisclosure(pool, row({ market: M1, ts: NOW - HOUR }));
  await withIndexer(async (url) => {
    const res = await fetch(`${url}/stats?window=7d&market=${M1}`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as { window: string; market: string; from: number; to: number; trades: number };
    assert.deepEqual({ window: s.window, market: s.market, from: s.from, to: s.to, trades: s.trades }, {
      window: "7d",
      market: M1,
      from: NOW - 7 * 24 * HOUR,
      to: NOW,
      trades: 1,
    });
  });
});
