// services/relayer/test/candleSql.test.ts — the pure half of store.ts's
// candle writes (bucket params per tick). The SQL itself is exercised in
// indexerDb.test.ts against a real Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickBucketParams } from "../src/indexer/store.js";

test("tickBucketParams: 1m / 1h / 1d bucket starts of a tick's ts", () => {
  const ts = Date.UTC(2026, 9, 1, 13, 47, 12, 345);
  assert.deepEqual(tickBucketParams(ts), [Date.UTC(2026, 9, 1, 13, 47), Date.UTC(2026, 9, 1, 13), Date.UTC(2026, 9, 1)]);
});
