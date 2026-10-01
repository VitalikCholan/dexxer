// services/relayer/test/wsFilter.test.ts
//
// The `/ws?markets=` filter (plan 2, Task 8). Pure — no socket. The binding
// compat rule: a client that never sends `?markets=` (every APK built before
// plan 2) must receive SOL `mark` frames only, because it reads any `mark`
// frame as SOL's price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wsFilterFrom, wsWants } from "../src/indexer/http.js";

test("old clients (no ?markets=) get only SOL marks — Review Focus 1", () => {
  const f = wsFilterFrom("/ws");
  assert.equal(wsWants(f, { type: "mark", market: "SOL" }), true);
  assert.equal(wsWants(f, { type: "mark", market: "BTC" }), false);
  assert.equal(wsWants(f, { type: "pool" }), true);
});

test("?markets=* and ?markets=SOL,BTC", () => {
  assert.equal(wsWants(wsFilterFrom("/ws?markets=*"), { type: "mark", market: "ZEC" }), true);
  const f = wsFilterFrom("/ws?markets=SOL,BTC");
  assert.equal(wsWants(f, { type: "mark", market: "BTC" }), true);
  assert.equal(wsWants(f, { type: "mark", market: "ETH" }), false);
});

test("wsFilterFrom normalises symbols and falls back to SOL when all are invalid", () => {
  const f = wsFilterFrom("/ws?markets=sol, btc");
  assert.equal(wsWants(f, { type: "mark", market: "SOL" }), true);
  assert.equal(wsWants(f, { type: "mark", market: "BTC" }), true);
  assert.equal(wsWants(f, { type: "mark", market: "ETH" }), false);
  const bad = wsFilterFrom("/ws?markets=bad-sym");
  assert.equal(wsWants(bad, { type: "mark", market: "SOL" }), true);
  assert.equal(wsWants(bad, { type: "mark", market: "BTC" }), false);
});
