use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, ixs,
    setup::{World, SEED_AMOUNT},
    Harness,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

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
