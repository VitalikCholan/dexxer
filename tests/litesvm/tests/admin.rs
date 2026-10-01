use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    apk, assert_custom_error, ixs,
    setup::{World, SEED_AMOUNT},
    Harness,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn bootstrap_creates_config_market_pool_and_seeds_liquidity() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let cfg: Config = h.account(&w.config);
    assert_eq!(cfg.admin, apk(w.admin.pubkey()));
    assert_eq!(cfg.dusdc_mint, apk(w.mint));
    let m: Market = h.account(&w.market);
    assert_eq!(m.symbol, SOL_SYMBOL);
    assert_eq!(
        m.feed,
        dexxer_core::oracle::feed_pda(&apk(w.oracle_program), "6")
    );
    assert_eq!(m.mark, 0);
    let p: Pool = h.account(&w.pool);
    assert_eq!(p.capital_total, SEED_AMOUNT);
    assert_eq!(p.protocol_liquidity, SEED_AMOUNT);
    assert_eq!(
        dexxer_litesvm::token_ix::token_balance(&h.svm, &w.pool_ata),
        SEED_AMOUNT
    );
}

#[test]
fn only_admin_can_set_params_or_pause() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(&[ixs::pause(&stranger.pubkey(), &w.config)], &[&stranger]);
    assert!(r.is_err(), "stranger must not pause"); // Anchor has_one -> ConstraintHasOne (2001), not our code
    h.send(&[ixs::pause(&w.admin.pubkey(), &w.config)], &[&w.admin])
        .unwrap();
    assert!(h.account::<Config>(&w.config).paused);
    h.send(&[ixs::unpause(&w.admin.pubkey(), &w.config)], &[&w.admin])
        .unwrap();
    let mut bad = MarketParams::sol_perp_defaults();
    bad.mmr_bps = bad.imr_bps; // invalid: mmr must be < imr
    let r = h.send(
        &[ixs::set_params(
            &w.admin.pubkey(),
            &w.config,
            &w.market,
            bad,
        )],
        &[&w.admin],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidParams as u32);
}

// Task-6 fix round 3: set_scheduler_signer is a plain base-layer admin ix,
// same AdminConfig-gated pattern as pause/unpause.
#[test]
fn only_admin_can_set_scheduler_signer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let new_signer = Keypair::new().pubkey();
    let r = h.send(
        &[ixs::set_scheduler_signer(
            &stranger.pubkey(),
            &w.config,
            new_signer,
        )],
        &[&stranger],
    );
    assert!(r.is_err(), "stranger must not set scheduler_signer"); // ConstraintHasOne
    h.send(
        &[ixs::set_scheduler_signer(
            &w.admin.pubkey(),
            &w.config,
            new_signer,
        )],
        &[&w.admin],
    )
    .unwrap();
    assert_eq!(
        h.account::<Config>(&w.config).scheduler_signer,
        apk(new_signer)
    );
}

#[test]
fn seed_pool_requires_admin_and_nonzero() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.send(
        &[dexxer_litesvm::token_ix::create_ata(
            &w.admin.pubkey(),
            &w.admin.pubkey(),
            &w.mint,
        )],
        &[&w.admin],
    )
    .unwrap();
    let r = h.send(&[ixs::seed_pool(&w.admin.pubkey(), &w, 0)], &[&w.admin]);
    assert_custom_error(&r, 6000 + DexxerError::AmountZero as u32);

    // Non-admin case: a stranger with their own funded-ATA setup cannot seed
    // the pool. `SeedPool`'s `config` account carries
    // `has_one = admin @ DexxerError::Unauthorized`, and Anchor validates
    // accounts in struct-field order (admin signer, then config), so this
    // fails that has_one check before the amount or any token balance is
    // even considered. The `@` override means the on-chain error is our own
    // `Unauthorized` (6019), not Anchor's generic ConstraintHasOne (2001) —
    // named here since that's what the review ruling anchored on.
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    h.send(
        &[dexxer_litesvm::token_ix::create_ata(
            &stranger.pubkey(),
            &stranger.pubkey(),
            &w.mint,
        )],
        &[&stranger],
    )
    .unwrap();
    let r = h.send(&[ixs::seed_pool(&stranger.pubkey(), &w, 1)], &[&stranger]);
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}
