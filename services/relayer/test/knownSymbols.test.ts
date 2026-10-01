// Final review: `?market=SOL` must work whenever the crank ticks SOL — the
// same `withSol` view, also while the registry has other markets but not SOL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { knownSymbols } from "../src/indexer/http.js";

test("knownSymbols: SOL is always queryable — empty registry, registry without SOL, registry with SOL", () => {
  assert.deepEqual(knownSymbols([]), ["SOL"]);
  assert.deepEqual(knownSymbols([{ symbol: "BTC" }]), ["SOL", "BTC"]);
  assert.deepEqual(knownSymbols([{ symbol: "SOL" }, { symbol: "BTC" }]), ["SOL", "BTC"]);
});
