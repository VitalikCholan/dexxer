// services/relayer/test/indexerQuery.test.ts
//
// Pure query-string parsing for the indexer's paginated/filtered endpoints —
// no Postgres, runs in CI. The SQL those parsed filters drive is covered
// against a real Postgres in indexerDb.test.ts (skipped without
// TEST_DATABASE_URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePoolHistoryQuery,
  parseMarketParam,
} from "../src/indexer/query.js";

test("parsePoolHistoryQuery: default limit 100, optional numeric slot cursor", () => {
  assert.deepEqual(parsePoolHistoryQuery({}), { ok: true, value: { limit: 100, cursor: null } });
  assert.deepEqual(parsePoolHistoryQuery({ limit: "10", cursor: "555" }), { ok: true, value: { limit: 10, cursor: 555n } });
  const bad = parsePoolHistoryQuery({ cursor: "5.5" });
  assert.equal(bad.ok, false);
});

test("parseMarketParam: default SOL, format 400, unknown 404", () => {
  const known = ["SOL", "BTC"];
  assert.deepEqual(parseMarketParam(undefined, known), { ok: true, value: "SOL" });
  assert.deepEqual(parseMarketParam("BTC", known), { ok: true, value: "BTC" });
  const bad = parseMarketParam("btc-perp", known);
  assert.equal(bad.ok, false);
  assert.equal("status" in bad ? bad.status : 400, 400);
  const unknown = parseMarketParam("DOGE", known);
  assert.equal(unknown.ok, false);
  assert.equal("status" in unknown ? unknown.status : 400, 404);
});
