import { test } from "node:test";
import assert from "node:assert/strict";
import { envNum } from "../src/env.js";

test("envNum: unset, unparseable, non-finite or below min -> default; valid -> parsed (F1)", () => {
  const k = "DEXXER_TEST_ENVNUM";
  delete process.env[k];
  assert.equal(envNum(k, 60_000, 5_000), 60_000, "unset");
  process.env[k] = "abc";
  assert.equal(envNum(k, 60_000, 5_000), 60_000, "NaN");
  process.env[k] = "Infinity";
  assert.equal(envNum(k, 60_000, 5_000), 60_000, "non-finite");
  process.env[k] = "0";
  assert.equal(envNum(k, 60_000, 5_000), 60_000, "below min");
  process.env[k] = "10000";
  assert.equal(envNum(k, 60_000, 5_000), 10_000, "valid");
  process.env[k] = "0.01";
  assert.equal(envNum(k, 0.05, 0), 0.01, "fractional kept, no min issue");
  process.env[k] = "-5";
  assert.equal(envNum(k, 7), -5, "no min -> any finite value");
  delete process.env[k];
});
