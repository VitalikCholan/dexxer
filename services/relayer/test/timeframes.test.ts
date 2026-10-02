// services/relayer/test/timeframes.test.ts
//
// The bucketing logic exists twice (relayer + app). This file and
// app/test/timeframes.test.ts both read tests/fixtures/timeframes.golden.json,
// so the two copies cannot drift apart silently (same pattern as hashes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TIMEFRAMES, TIERS, TIER_TF, bucketStart, isTf, mergeCandles, nthPrevBucket, prevBucket, tierOf, type Tf } from "../src/indexer/timeframes.js";

interface Golden { tf: Tf; iso: string; ms: number; bucketStart: number; prevBucket: number }
const golden = JSON.parse(readFileSync(new URL("../../../tests/fixtures/timeframes.golden.json", import.meta.url), "utf8")) as Golden[];

test("timeframes: exactly the 16 TradingView tfs, in display order", () => {
  assert.deepEqual([...TIMEFRAMES], ["1s", "1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "24h", "2D", "5D", "1W", "1M"]);
  assert.ok(isTf("1W"));
  assert.ok(!isTf("1D"));
  assert.ok(!isTf(60));
});

test("timeframes: golden vectors (year boundary, leap February, Sunday→Monday, 2D/5D from the epoch)", () => {
  assert.ok(golden.length >= 14);
  for (const g of golden) {
    assert.equal(bucketStart(g.tf, g.ms), g.bucketStart, `${g.tf} bucketStart ${g.iso}`);
    assert.equal(prevBucket(g.tf, g.bucketStart), g.prevBucket, `${g.tf} prevBucket ${g.iso}`);
    assert.equal(bucketStart(g.tf, g.bucketStart), g.bucketStart, `${g.tf} bucketStart is idempotent`);
  }
});

test("timeframes: 1W buckets start on Monday 00:00 UTC, 1M on the 1st", () => {
  const monday = Date.UTC(2026, 9, 5); // 2026-10-05 is a Monday
  assert.equal(new Date(bucketStart("1W", monday + 3 * 86_400_000)).getUTCDay(), 1);
  assert.equal(bucketStart("1W", monday), monday);
  assert.equal(bucketStart("1M", Date.UTC(2026, 1, 15)), Date.UTC(2026, 1, 1));
  assert.equal(prevBucket("1M", Date.UTC(2026, 0, 1)), Date.UTC(2025, 11, 1));
});

test("timeframes: nthPrevBucket walks back n buckets (calendar-aware)", () => {
  assert.equal(nthPrevBucket("1M", Date.UTC(2026, 2, 1), 3), Date.UTC(2025, 11, 1));
  assert.equal(nthPrevBucket("1h", 10 * 3_600_000, 4), 6 * 3_600_000);
  assert.equal(nthPrevBucket("1s", 5_000, 0), 5_000);
});

test("timeframes: tierOf picks the nearest lower stored tier", () => {
  assert.equal(tierOf("1s"), "ticks");
  for (const tf of ["1m", "5m", "15m", "30m"] as const) assert.equal(tierOf(tf), "1m");
  for (const tf of ["1h", "2h", "4h", "6h", "8h", "12h"] as const) assert.equal(tierOf(tf), "1h");
  for (const tf of ["24h", "2D", "5D", "1W", "1M"] as const) assert.equal(tierOf(tf), "1d");
  assert.deepEqual([...TIERS], ["1m", "1h", "1d"]);
  assert.deepEqual(TIER_TF, { "1m": "1m", "1h": "1h", "1d": "24h" });
});

test("mergeCandles: o of the first, max h, min l, c of the last; groups by the target bucket", () => {
  const H = 3_600_000;
  const rows = [
    { t: 0, o: 10n, h: 12n, l: 9n, c: 11n },
    { t: H, o: 11n, h: 15n, l: 11n, c: 14n },
    { t: 2 * H, o: 14n, h: 14n, l: 8n, c: 9n }, // next 2h bucket
  ];
  assert.deepEqual(mergeCandles(rows, "2h"), [
    { t: 0, o: 10n, h: 15n, l: 9n, c: 14n },
    { t: 2 * H, o: 14n, h: 14n, l: 8n, c: 9n },
  ]);
  // plain numbers work the same way (the app's copy uses numbers)
  assert.deepEqual(mergeCandles([{ t: 0, o: 1, h: 3, l: 1, c: 2 }, { t: 60_000, o: 2, h: 2, l: 0, c: 1 }], "5m"), [{ t: 0, o: 1, h: 3, l: 0, c: 1 }]);
});

test("mergeCandles: 1d rows across a month boundary land in two 1M buckets", () => {
  const D = 86_400_000;
  const jan31 = Date.UTC(2026, 0, 31);
  const rows = [
    { t: jan31, o: 1n, h: 2n, l: 1n, c: 2n },
    { t: jan31 + D, o: 2n, h: 3n, l: 2n, c: 3n },
  ];
  const out = mergeCandles(rows, "1M");
  assert.equal(out.length, 2);
  assert.equal(out[0].t, Date.UTC(2026, 0, 1));
  assert.equal(out[1].t, Date.UTC(2026, 1, 1));
});
