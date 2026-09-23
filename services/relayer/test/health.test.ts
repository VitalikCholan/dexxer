// services/relayer/test/health.test.ts
//
// `buildHealthPayload` is pure (no Express, no network — see health.ts's
// header comment), so it's exercised directly with fake `RelayerState`
// values: a fresh tick within STALE_MS reports ok=true/200-worthy, a tick
// older than STALE_MS (or no tick ever) reports ok=false/503-worthy.
//
// Task 7 adds `computeSchedulerActive` (also pure) and `crankEnabled`'s
// effect on `ok` — see below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULER_ACTIVE_WINDOW_MS, STALE_MS, buildHealthPayload, computeSchedulerActive } from "../src/health.js";
import type { RelayerState } from "../src/crank.js";

test("buildHealthPayload: ok=true when the last tick is fresh", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: now - 5_000, lastCommitAt: now - 60_000, tick: 42, errors: [] };
  const payload = buildHealthPayload(state, now, 1.5, 2.5, "ok");
  assert.equal(payload.ok, true);
  assert.equal(payload.tick, 42);
  assert.equal(payload.crankSol, 1.5);
  assert.equal(payload.feePayerSol, 2.5);
  // Task 7: `schedulerActive` defaults to null (not attributable) when
  // `crankEnabled` is omitted (defaults true) — see the dedicated
  // crankEnabled/schedulerActive tests below for the CRANK_ENABLED=false path.
  assert.equal(payload.schedulerActive, null);
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

test("buildHealthPayload: defaults crankEnabled=true and schedulerActive=null when omitted", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: now - 5_000, lastCommitAt: null, tick: 1, errors: [] };
  const payload = buildHealthPayload(state, now, null, null, "ok");
  assert.equal(payload.crankEnabled, true);
  assert.equal(payload.schedulerActive, null);
});

// --- Task 7: CRANK_ENABLED=false must not make `ok` depend on tick staleness ---

test("buildHealthPayload: ok=true when crankEnabled=false, even with no tick ever", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: null, lastCommitAt: null, tick: 0, errors: [] };
  const payload = buildHealthPayload(state, now, null, null, "ok", undefined, undefined, false, true);
  assert.equal(payload.ok, true);
  assert.equal(payload.crankEnabled, false);
  assert.equal(payload.schedulerActive, true);
});

test("buildHealthPayload: ok=true when crankEnabled=false, even with a very stale tick", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: now - (STALE_MS * 10), lastCommitAt: null, tick: 5, errors: [] };
  const payload = buildHealthPayload(state, now, null, null, "ok", undefined, undefined, false, null);
  assert.equal(payload.ok, true);
});

test("buildHealthPayload: crankEnabled=true (explicit) preserves the pre-Task-7 staleness behavior", () => {
  const now = 1_000_000;
  const state: RelayerState = { lastTickAt: now - (STALE_MS + 1), lastCommitAt: null, tick: 7, errors: [] };
  const payload = buildHealthPayload(state, now, null, null, "ok", undefined, undefined, true, null);
  assert.equal(payload.ok, false);
});

// --- Task 7: computeSchedulerActive ---

test("computeSchedulerActive: null (not attributable) while our own crank is enabled", () => {
  assert.equal(computeSchedulerActive(true, Date.now(), Date.now()), null);
  assert.equal(computeSchedulerActive(true, null, Date.now()), null);
});

test("computeSchedulerActive: false when crank is disabled and Market has never changed", () => {
  assert.equal(computeSchedulerActive(false, null, Date.now()), false);
});

test("computeSchedulerActive: true when crank is disabled and Market changed within the window", () => {
  const now = 1_000_000;
  assert.equal(computeSchedulerActive(false, now - (SCHEDULER_ACTIVE_WINDOW_MS - 1), now), true);
});

test("computeSchedulerActive: false when crank is disabled but Market's last change fell outside the window", () => {
  const now = 1_000_000;
  assert.equal(computeSchedulerActive(false, now - (SCHEDULER_ACTIVE_WINDOW_MS + 1), now), false);
});
