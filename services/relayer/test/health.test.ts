// services/relayer/test/health.test.ts
//
// `buildHealthPayload` is pure (no Express, no network — see health.ts's
// header comment), so it's exercised directly with fake `RelayerState`
// values: a fresh tick within STALE_MS reports ok=true/200-worthy, a tick
// older than STALE_MS (or no tick ever) reports ok=false/503-worthy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_MS, buildHealthPayload } from "../src/health.js";
import type { RelayerState } from "../src/crank.js";

test("buildHealthPayload: ok=true when the last tick is fresh", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: now - 5_000, lastCommitAt: now - 60_000, tick: 42, errors: [] };
  const payload = buildHealthPayload(state, now, 1.5, 2.5, "ok");
  assert.equal(payload.ok, true);
  assert.equal(payload.tick, 42);
  assert.equal(payload.crankSol, 1.5);
  assert.equal(payload.feePayerSol, 2.5);
  assert.equal(payload.schedulerActive, false);
  assert.equal(payload.db, "ok");
});

test("buildHealthPayload: ok=false (503-worthy) when the last tick is older than STALE_MS", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: now - (STALE_MS + 1), lastCommitAt: null, tick: 7, errors: [] };
  const payload = buildHealthPayload(state, now, null, null, "ok");
  assert.equal(payload.ok, false);
});

test("buildHealthPayload: ok=false when there has never been a tick (lastTickAt=null)", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: null, lastCommitAt: null, tick: 0, errors: [] };
  const payload = buildHealthPayload(state, now, null, null, "error");
  assert.equal(payload.ok, false);
  assert.equal(payload.db, "error");
});
