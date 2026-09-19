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
}
