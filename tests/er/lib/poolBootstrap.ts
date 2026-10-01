// tests/er/lib/poolBootstrap.ts
//
// The pool part of `bootstrap()`/`bootstrapDevnet()` (admin.ts) as a pure
// plan, so the order is pinned by a unit test
// (services/relayer/test/poolBootstrap.test.ts) instead of being found on a
// live network. No imports on purpose.
//
// Why this order (programs/dexxer_core/src/instructions/{admin,pool_live}.rs):
// - `init_pool_live` reads `Pool` as an `UncheckedAccount` (owner-unchecked,
//   discriminator-checked) and `init`s `PoolLive` — it needs `Pool` to exist,
//   delegated or not.
// - `seed_pool` takes `pool: Account<Pool>` and `pool_live: Account<PoolLive>`,
//   both `mut`: Anchor checks that each is owned by dexxer_core, so it must
//   run while NEITHER is delegated (a delegated account is owned by the
//   Delegation Program on L1 -> Anchor 3007).
// - `delegate_pool_live` / `delegate_pool` hand the accounts to the
//   Delegation Program; `delegate_pool` also moves the pool ATA's whole
//   balance into the eSPL vault, so it comes after the seed.
// A run that finds an account delegated before `Pool` was seeded cannot be
// finished by any instruction order — it fails with a message instead.

export type PoolStep = "init_pool" | "init_pool_live" | "seed_pool" | "delegate_pool_live" | "delegate_pool";

export interface PoolBootstrapState {
  poolExists: boolean;
  /** `Pool.capital_total > 0`, read from the L1 bytes (a delegated `Pool`'s L1 copy keeps its data — the last committed, floored snapshot). */
  poolSeeded: boolean;
  /** `Pool`'s L1 owner is the Delegation Program. */
  poolDelegated: boolean;
  poolLiveExists: boolean;
  poolLiveDelegated: boolean;
}

export function poolBootstrapPlan(s: PoolBootstrapState): PoolStep[] | { error: string } {
  const steps: PoolStep[] = [];
  if (!s.poolExists) steps.push("init_pool");
  if (!s.poolLiveExists) steps.push("init_pool_live");
  // Both delegated = done: the L1 `Pool` is then a `commit_aggregate`
  // snapshot floored to SNAPSHOT_STEP and may legitimately read 0.
  if (!s.poolSeeded && !(s.poolDelegated && s.poolLiveDelegated)) {
    if (s.poolLiveDelegated) {
      return {
        error:
          "PoolLive is already delegated but Pool is not seeded: seed_pool needs PoolLive (and Pool) owned by dexxer_core on L1 " +
          "and would fail with Anchor 3007. Undelegate PoolLive first or start over on a fresh program id.",
      };
    }
    if (s.poolDelegated) {
      return {
        error:
          "Pool is already delegated but not seeded: seed_pool needs Pool owned by dexxer_core on L1 and would fail with Anchor 3007. " +
          "Undelegate Pool first or start over on a fresh program id.",
      };
    }
    steps.push("seed_pool");
  }
  if (!s.poolLiveDelegated) steps.push("delegate_pool_live");
  if (!s.poolDelegated) steps.push("delegate_pool");
  return steps;
}
