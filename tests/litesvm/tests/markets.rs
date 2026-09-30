// Spec §2.8: markets beyond SOL. (Per-market position tests were removed with
// the position instructions; they return on slots.) LiteSVM has no Delegation/Permission/Magic
// program, so delegation CPIs fail by design (asserted as "passed every
// constraint": no custom error) and ER CPIs are gated off by `executable`.
use anchor_lang::InstructionData;
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, custom_error_code, ixs, pk,
    setup::{sym, World},
    Harness,
};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

/// BTC-PERP: the SOL defaults with a dollar-equivalent minimum size (0.00002
/// BTC at 1e9 size scale ≈ $1.6) and a staleness bound that fits the ~9 s
/// devnet feed cadence. `max_position` is a notional (USD 1e6) cap, not a
/// size, so the SOL default already is the same dollar ceiling for BTC.
fn btc_params() -> MarketParams {
    MarketParams {
        min_size: 20_000,
        max_staleness_secs: 15,
        ..MarketParams::sol_perp_defaults()
    }
}

#[test]
fn init_market_stores_symbol_and_feed() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let m: Market = h.account(&btc.market);
    assert_eq!(m.symbol, sym("BTC"));
    assert_eq!(pk(m.feed), btc.feed);
    assert_eq!(m.min_size, 20_000);
}

#[test]
fn sol_market_pda_is_unchanged() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let legacy =
        Pubkey::find_program_address(&[b"market", b"SOL\0\0\0\0\0"], &pk(dexxer_core::ID)).0;
    assert_eq!(w.market, legacy);
    assert_eq!(h.account::<Market>(&w.market).symbol, SOL_SYMBOL);
}

#[test]
fn init_market_rejects_invalid_symbols() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let mut after_padding = sym("BTC");
    after_padding[4] = b'X';
    for bad in [sym("btc"), sym(""), sym("B-C"), after_padding] {
        let r = h.send(
            &[ixs::init_market(&w.admin.pubkey(), bad, btc_params(), "1")],
            &[&w.admin],
        );
        assert_custom_error(&r, 6000 + DexxerError::InvalidSymbol as u32);
    }
}

#[test]
fn init_market_rejects_a_duplicate_symbol_and_a_non_admin() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    w.add_market(&mut h, "BTC", "1", btc_params());
    let dup = h.send(
        &[ixs::init_market(
            &w.admin.pubkey(),
            sym("BTC"),
            btc_params(),
            "2",
        )],
        &[&w.admin],
    );
    assert!(dup.is_err(), "a second BTC market must not be created");
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::init_market(
            &stranger.pubkey(),
            sym("ETH"),
            btc_params(),
            "2",
        )],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

#[test]
fn delegate_market_passes_its_guards_for_any_symbol() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let r = h.send(
        &[ixs::delegate_market(&w.admin.pubkey(), &w, &btc)],
        &[&w.admin],
    );
    assert!(r.is_err(), "no delegation program is deployed on LiteSVM");
    assert_eq!(
        custom_error_code(&r),
        None,
        "must fail at the delegation CPI, not at a constraint"
    );
    let mut wrong = ixs::delegate_market(&w.admin.pubkey(), &w, &btc);
    wrong.data = dexxer_core::instruction::DelegateMarket { symbol: sym("ETH") }.data();
    let r = h.send(&[wrong], &[&w.admin]);
    assert_eq!(
        custom_error_code(&r),
        Some(2006),
        "ConstraintSeeds: the symbol must match the market account"
    );
}
