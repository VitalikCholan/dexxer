// services/relayer/test/tickers.test.ts — 24h ticker from the 1h candle tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, HOUR_MS, tickerFrom, tickerWindowStart } from "../src/indexer/tickers.js";
import type { CandleRow } from "../src/indexer/store.js";

const now = Date.UTC(2026, 9, 5, 12, 30); // 12:30 UTC
const start = tickerWindowStart(now); // 12:00 UTC the day before
const c = (hoursFromStart: number, o: number, h: number, l: number, cl: number): CandleRow => ({
  t: start + hoursFromStart * HOUR_MS, o: BigInt(o), h: BigInt(h), l: BigInt(l), c: BigInt(cl),
});

test("tickerWindowStart is the hour bucket that contains now − 24h", () => {
  assert.equal(start, Date.UTC(2026, 9, 4, 12, 0));
  assert.ok(start <= now - DAY_MS && now - DAY_MS < start + HOUR_MS);
});

test("full 24h: change from the first open, high/low over the window, price = last close", () => {
  const t = tickerFrom("ETH", [c(0, 100_000_000, 105_000_000, 99_000_000, 101_000_000), c(24, 101_000_000, 120_000_000, 98_000_000, 110_000_000)], now);
  assert.deepEqual(t, { symbol: "ETH", price: "110000000", change24h: 0.1, high24h: "120000000", low24h: "98000000" });
});

test("under 24h of history: change is null, high/low over what exists", () => {
  const t = tickerFrom("NEW", [c(5, 100, 130, 90, 120)], now);
  assert.deepEqual(t, { symbol: "NEW", price: "120", change24h: null, high24h: "130", low24h: "90" });
});

test("no candles: everything null", () => {
  assert.deepEqual(tickerFrom("NEW", [], now), { symbol: "NEW", price: null, change24h: null, high24h: null, low24h: null });
});

test("open 24h ago of 0 never divides by zero", () => {
  const t = tickerFrom("BAD", [c(0, 0, 10, 0, 5), c(24, 5, 6, 4, 6)], now);
  assert.equal(t.change24h, null);
});

test("candles older than the window are ignored", () => {
  const t = tickerFrom("ETH", [c(-3, 1, 999, 1, 1), c(0, 100, 100, 100, 100), c(24, 100, 150, 100, 150)], now);
  assert.deepEqual([t.change24h, t.high24h], [0.5, "150"]);
});
