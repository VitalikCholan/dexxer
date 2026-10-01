import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKET_CATALOG, marketTaskId } from "../../../tests/er/lib/markets.js";
import { pdas } from "../../../tests/er/lib/program.js";

// Spec §2.8.1: the same ~$1-2 floor on every market, a notional (USD 1e6)
// ceiling shared with SOL, 10x on SOL/BTC/ETH and 5x on HYPE/ZEC.
test("catalog carries the spec §2.8.1 bounds", () => {
  const n = (x: { toString(): string }) => BigInt(x.toString());
  assert.equal(MARKET_CATALOG.BTC.lazerFeedId, "1");
  assert.equal(MARKET_CATALOG.ETH.lazerFeedId, "2");
  assert.equal(MARKET_CATALOG.ZEC.lazerFeedId, "66");
  assert.equal(MARKET_CATALOG.HYPE.lazerFeedId, "110");
  assert.equal(n(MARKET_CATALOG.BTC.params.minSize), 20_000n);
  assert.equal(n(MARKET_CATALOG.ETH.params.minSize), 500_000n);
  assert.equal(n(MARKET_CATALOG.HYPE.params.minSize), 15_000_000n);
  assert.equal(n(MARKET_CATALOG.ZEC.params.minSize), 800_000n);
  for (const s of ["BTC", "ETH", "HYPE", "ZEC"]) {
    assert.equal(n(MARKET_CATALOG[s].params.maxPosition), n(MARKET_CATALOG.SOL.params.maxPosition), `${s} max_position is a USD notional`);
    assert.equal(n(MARKET_CATALOG[s].params.maxStalenessSecs), 15n);
    assert.equal(MARKET_CATALOG[s].params.maxConfBps, 0, "devnet Lazer conf == 0");
  }
  assert.deepEqual([MARKET_CATALOG.HYPE.params.maxLevBps, MARKET_CATALOG.HYPE.params.imrBps, MARKET_CATALOG.HYPE.params.mmrBps], [50_000, 2_000, 1_000]);
  assert.deepEqual([MARKET_CATALOG.BTC.params.maxLevBps, MARKET_CATALOG.BTC.params.imrBps, MARKET_CATALOG.BTC.params.mmrBps], [100_000, 1_000, 500]);
});

test("marketTaskId differs per market and is stable", () => {
  const a = marketTaskId(pdas.marketFor("BTC"));
  assert.equal(a, marketTaskId(pdas.marketFor("BTC")));
  assert.notEqual(a, marketTaskId(pdas.marketFor("ETH")));
});
