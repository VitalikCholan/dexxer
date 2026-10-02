// services/relayer/test/candles.test.ts
//
// `candles.ts` is pure (no DB, no I/O) — see its header comment. Covers the
// brief's four cases: single tick, two ticks in the same bucket, a tick
// crossing a bucket boundary, and no empty buckets being synthesized
// between ticks that are far apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCandles, candlesForTf, newSeries, planPrices, pushTick, seriesCandles } from "../src/indexer/candles.js";

test("candles: one tick produces o=h=l=c", () => {
  const s = newSeries("1m");
  pushTick(s, 1_000, 100n);
  const cs = seriesCandles(s);
  assert.equal(cs.length, 1);
  const [c] = cs;
  assert.equal(c.t, 0);
  assert.equal(c.o, 100n);
  assert.equal(c.h, 100n);
  assert.equal(c.l, 100n);
  assert.equal(c.c, 100n);
});

test("candles: two ticks in the same bucket update h/l/c but keep o", () => {
  const s = newSeries("1m");
  pushTick(s, 1_000, 100n);
  pushTick(s, 2_000, 90n);
  const [c] = seriesCandles(s);
  assert.equal(c.o, 100n);
  assert.equal(c.c, 90n);
  assert.equal(c.l, 90n);
  assert.equal(c.h, 100n);
});

test("candles: a tick above h and below l inside the same bucket updates both", () => {
  const s = newSeries("1m");
  pushTick(s, 0, 100n);
  pushTick(s, 1_000, 120n); // new high
  pushTick(s, 2_000, 80n); // new low
  const [c] = seriesCandles(s);
  assert.equal(c.o, 100n);
  assert.equal(c.h, 120n);
  assert.equal(c.l, 80n);
  assert.equal(c.c, 80n);
});

test("candles: a tick across a bucket boundary starts a new candle", () => {
  const s = newSeries("1m");
  pushTick(s, 59_999, 100n);
  pushTick(s, 60_000, 200n);
  const cs = seriesCandles(s);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].t, 0);
  assert.equal(cs[0].c, 100n);
  assert.equal(cs[1].t, 60_000);
  assert.equal(cs[1].o, 200n);
});

test("candles: no empty buckets are created between distant ticks", () => {
  const s = newSeries("1m");
  pushTick(s, 0, 100n);
  pushTick(s, 600_000, 200n); // 10 buckets later
  const cs = seriesCandles(s);
  assert.equal(cs.length, 2); // not 11
});

test("candles: seriesCandles(limit) returns only the most recent buckets", () => {
  const s = newSeries("1m");
  for (let i = 0; i < 5; i++) pushTick(s, i * 60_000, BigInt(i));
  const cs = seriesCandles(s, 2);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].t, 3 * 60_000);
  assert.equal(cs[1].t, 4 * 60_000);
});

test("aggregateCandles buckets a flat tick list per tf and respects limit", () => {
  const ticks = [
    { ts: 0, price: 10n },
    { ts: 30_000, price: 12n },
    { ts: 60_000, price: 15n },
    { ts: 120_000, price: 20n },
  ];
  const cs = aggregateCandles(ticks, "1m", 2);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].t, 60_000);
  assert.equal(cs[1].t, 120_000);
  assert.equal(cs[1].c, 20n);
});

test("aggregateCandles: 1s buckets from ticks ~2 s apart leave gaps, never synthesize", () => {
  const cs = aggregateCandles([{ ts: 1_000, price: 1n }, { ts: 3_200, price: 2n }, { ts: 5_900, price: 3n }], "1s", 1000);
  assert.deepEqual(cs.map((c) => c.t), [1_000, 3_000, 5_000]);
});

test("planPrices: 1s reads ticks (limit+1 seconds back); other tfs read their tier from limit buckets back", () => {
  const now = Date.UTC(2026, 9, 1, 12, 34, 56, 789);
  assert.deepEqual(planPrices("1s", 300, now), { tier: "ticks", since: now - 301_000 });
  assert.deepEqual(planPrices("5m", 2, now), { tier: "1m", since: Date.UTC(2026, 9, 1, 12, 20) }); // bucket 12:30, 2 back = 12:20
  assert.deepEqual(planPrices("12h", 1, now), { tier: "1h", since: Date.UTC(2026, 9, 1, 0) });
  assert.deepEqual(planPrices("1M", 3, now), { tier: "1d", since: Date.UTC(2026, 6, 1) });
  assert.deepEqual(planPrices("1W", 1, Date.UTC(2026, 9, 5)), { tier: "1d", since: Date.UTC(2026, 8, 28) }); // Monday exactly
});

test("candlesForTf: merges tier rows into the tf and keeps only the newest `limit`", () => {
  const H = 3_600_000;
  const rows = Array.from({ length: 30 }, (_, i) => ({ t: i * H, o: BigInt(i), h: BigInt(i + 1), l: BigInt(i), c: BigInt(i + 1) }));
  const out = candlesForTf(rows, "12h", 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].t, 12 * H);
  assert.deepEqual(out[1], { t: 24 * H, o: 24n, h: 30n, l: 24n, c: 30n });
});

test("candlesForTf: a sparse table returns what exists (1M with three 1d rows → one or two candles, no padding)", () => {
  const D = 86_400_000;
  const rows = [Date.UTC(2026, 8, 29), Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1)].map((t, i) => ({ t, o: BigInt(i), h: BigInt(i), l: BigInt(i), c: BigInt(i) }));
  const out = candlesForTf(rows, "1M", 1000);
  assert.deepEqual(out.map((c) => c.t), [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)]);
  assert.equal(rows[1].t - rows[0].t, D);
});
