import { test } from "node:test";
import assert from "node:assert/strict";
import { symbolBytes, symbolString } from "../../../tests/er/lib/symbol.js";
import { SOL_SYMBOL, pdas } from "../../../tests/er/lib/program.js";

test("symbolBytes pads to 8 bytes and matches SOL_SYMBOL", () => {
  assert.deepEqual(symbolBytes("SOL"), SOL_SYMBOL);
  assert.equal(symbolBytes("HYPE").length, 8);
  assert.deepEqual([...symbolBytes("BTC")], [66, 84, 67, 0, 0, 0, 0, 0]);
});

test("symbolBytes rejects what validate_symbol rejects", () => {
  for (const bad of ["", "sol", "SOL-PERP", "ABCDEFGHI", "BT C"]) {
    assert.throws(() => symbolBytes(bad), /invalid symbol/);
  }
});

test("symbolString trims the zero padding", () => {
  assert.equal(symbolString([90, 69, 67, 0, 0, 0, 0, 0]), "ZEC");
  assert.equal(symbolString(symbolBytes("ABCDEFGH")), "ABCDEFGH");
});

test("pdas.marketFor('SOL') is the legacy SOL market PDA", () => {
  assert.ok(pdas.marketFor("SOL").equals(pdas.market()));
  assert.ok(!pdas.marketFor("BTC").equals(pdas.market()));
});
