use dexxer_core::{errors::DexxerError, math::floor_step, state::*};
use dexxer_litesvm::{
    assert_custom_error, assert_invariant, ixs,
    setup::{World, SEED_AMOUNT},
    Harness,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SIZE: u64 = 1_000_000_000;
const MARGIN: u64 = 20_000_000; // 20 dUSDC — ceils to 100 dUSDC (SNAPSHOT_STEP) in the public Pool
const NOW: i64 = 2_000_000;

/// Same clock/price bootstrap as trade.rs's `world_with_price`: bootstrap's own
/// faucet loop already warps past slot/ts 9101/1_777_609, so warp forward from there.
fn world_with_price(h: &mut Harness) -> World {
    let w = World::bootstrap(h);
    h.warp(9_101, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w
}

#[test]
fn init_pool_live_copies_seeded_pool() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let pool: Pool = h.account(&w.pool);
    let live: PoolLive = h.account(&w.pool_live);
    assert_eq!(live.mint, pool.mint);
    assert_eq!(live.capital_total, pool.capital_total);
    assert_eq!(live.protocol_liquidity, pool.protocol_liquidity);
    assert_eq!(live.capital_total, SEED_AMOUNT);
}

#[test]
fn init_pool_live_admin_only() {
    let mut h = Harness::new();
    let w = World::bootstrap_without_pool_live(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::init_pool_live(&stranger.pubkey(), &w.mint)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

// week-4 Task 1 (RED first): trading instructions must write PoolLive, never
// the public Pool — Pool only moves on init_pool/seed_pool/commit_aggregate.
#[test]
fn trades_write_pool_live_and_leave_pool_snapshot_untouched() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let pool_before: Pool = h.account(&w.pool);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SIZE,
            MARGIN,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    let live: PoolLive = h.account(&w.pool_live);
    let pool_after: Pool = h.account(&w.pool);
    assert_eq!(live.locked_total, MARGIN, "live counters move on open");
    assert_eq!(
        pool_after.locked_total, pool_before.locked_total,
        "public Pool must not change between commits"
    );
    assert_eq!(pool_after.last_commit_slot, pool_before.last_commit_slot);
    assert_invariant(&h, &w, &[&t]);
}

// week-4 Task 1 (RED first): commit_aggregate publishes a step-rounded Pool
// snapshot of PoolLive — assets floor to SNAPSHOT_STEP, liabilities ceil.
#[test]
fn commit_aggregate_snapshots_rounded_values() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SIZE,
            MARGIN,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    h.send(
        &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &[])],
        &[&w.fee_payer],
    )
    .unwrap();
    let live: PoolLive = h.account(&w.pool_live);
    let pool: Pool = h.account(&w.pool);
    assert_eq!(
        pool.locked_total, 100_000_000,
        "20 dUSDC locked ceils to 100"
    );
    assert_eq!(
        pool.capital_total,
        floor_step(live.capital_total, SNAPSHOT_STEP).unwrap()
    );
    assert_eq!(
        pool.protocol_liquidity,
        floor_step(live.protocol_liquidity, SNAPSHOT_STEP).unwrap()
    );
    assert!(pool.last_commit_slot > 0);
}
