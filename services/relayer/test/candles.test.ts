// services/relayer/test/candles.test.ts
//
// `candles.ts` is pure (no DB, no I/O) — see its header comment. Covers the
// brief's four cases: single tick, two ticks in the same bucket, a tick
// crossing a bucket boundary, and no empty buckets being synthesized
// between ticks that are far apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCandles, newSeries, pushTick, seriesCandles, tfMsOf } from "../src/indexer/candles.js";

test("candles: one tick produces o=h=l=c", () => {
  const s = newSeries(60_000);
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
  const s = newSeries(60_000);
  pushTick(s, 1_000, 100n);
  pushTick(s, 2_000, 90n);
  const [c] = seriesCandles(s);
  assert.equal(c.o, 100n);
  assert.equal(c.c, 90n);
  assert.equal(c.l, 90n);
  assert.equal(c.h, 100n);
});

test("candles: a tick above h and below l inside the same bucket updates both", () => {
  const s = newSeries(60_000);
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
  const s = newSeries(60_000);
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
  const s = newSeries(60_000);
  pushTick(s, 0, 100n);
  pushTick(s, 600_000, 200n); // 10 buckets later
  const cs = seriesCandles(s);
  assert.equal(cs.length, 2); // not 11
});

test("candles: seriesCandles(limit) returns only the most recent buckets", () => {
  const s = newSeries(60_000);
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

test("tfMsOf maps known timeframes and rejects unknown ones", () => {
  assert.equal(tfMsOf("1m"), 60_000);
  assert.equal(tfMsOf("5m"), 300_000);
  assert.equal(tfMsOf("15m"), 900_000);
  assert.throws(() => tfMsOf("1h"));
});
