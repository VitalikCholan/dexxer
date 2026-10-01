// Final review C1: the pool bootstrap order both `bootstrap()` and
// `bootstrapDevnet()` (tests/er/lib/admin.ts) follow. `seed_pool` takes
// `Pool` AND `PoolLive` as program-owned `Account<…>`s, so it must land while
// neither is delegated yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolBootstrapPlan } from "../../../tests/er/lib/poolBootstrap.js";

const fresh = { poolExists: false, poolSeeded: false, poolDelegated: false, poolLiveExists: false, poolLiveDelegated: false };

test("clean start: init_pool -> init_pool_live -> seed_pool -> delegate_pool_live -> delegate_pool", () => {
  assert.deepEqual(poolBootstrapPlan(fresh), ["init_pool", "init_pool_live", "seed_pool", "delegate_pool_live", "delegate_pool"]);
});

test("a half-finished run resumes where it stopped", () => {
  assert.deepEqual(poolBootstrapPlan({ ...fresh, poolExists: true }), ["init_pool_live", "seed_pool", "delegate_pool_live", "delegate_pool"]);
  assert.deepEqual(poolBootstrapPlan({ ...fresh, poolExists: true, poolLiveExists: true }), ["seed_pool", "delegate_pool_live", "delegate_pool"]);
  assert.deepEqual(poolBootstrapPlan({ ...fresh, poolExists: true, poolLiveExists: true, poolSeeded: true }), ["delegate_pool_live", "delegate_pool"]);
  assert.deepEqual(
    poolBootstrapPlan({ poolExists: true, poolLiveExists: true, poolSeeded: true, poolLiveDelegated: true, poolDelegated: false }),
    ["delegate_pool"],
  );
});

test("everything done: nothing to send", () => {
  assert.deepEqual(poolBootstrapPlan({ poolExists: true, poolSeeded: true, poolDelegated: true, poolLiveExists: true, poolLiveDelegated: true }), []);
});

test("PoolLive delegated before Pool was seeded: a clear error, never a seed_pool that fails with 3007", () => {
  const r = poolBootstrapPlan({ poolExists: true, poolSeeded: false, poolDelegated: false, poolLiveExists: true, poolLiveDelegated: true });
  assert.ok(!Array.isArray(r));
  assert.match(r.error, /PoolLive is already delegated but Pool is not seeded/);
  assert.match(r.error, /seed_pool/);
});

test("Pool delegated but never seeded (PoolLive still on L1): an error too — seed_pool cannot run any more", () => {
  const r = poolBootstrapPlan({ poolExists: true, poolSeeded: false, poolDelegated: true, poolLiveExists: true, poolLiveDelegated: false });
  assert.ok(!Array.isArray(r));
  assert.match(r.error, /Pool is already delegated but not seeded/);
});

test("pre-PoolLive deployment (Pool seeded and delegated, no PoolLive): init_pool_live then delegate_pool_live", () => {
  assert.deepEqual(
    poolBootstrapPlan({ poolExists: true, poolSeeded: true, poolDelegated: true, poolLiveExists: false, poolLiveDelegated: false }),
    ["init_pool_live", "delegate_pool_live"],
  );
});

test("both delegated is done even when the L1 Pool snapshot reads 0 (commit_aggregate floors it to SNAPSHOT_STEP): a re-run must not fail", () => {
  assert.deepEqual(poolBootstrapPlan({ poolExists: true, poolSeeded: false, poolDelegated: true, poolLiveExists: true, poolLiveDelegated: true }), []);
});
