// Spec §2.8: markets beyond SOL, an owner's position on every market, and the
// exit path across markets. LiteSVM has no Delegation/Permission/Magic
// program, so delegation CPIs fail by design (asserted as "passed every
// constraint": no custom error) and ER CPIs are gated off by `executable`.
use anchor_lang::InstructionData;
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, custom_error_code, ixs, pdas, pk,
    setup::{sym, Mkt, World},
    Harness,
};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

// Same clock base every other suite settled on.
const NOW: i64 = 2_000_000;
const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
const B80K: u64 = 80_000_000_000;
const B70K: u64 = 70_000_000_000;
const BTC_01: u64 = 10_000_000; // 0.01 BTC at 1e9 size scale → $800 notional at $80k
const M80: u64 = 80_000_000; // 10x

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

#[test]
fn init_position_creates_an_empty_prefunded_position() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let t = w.new_trader(&mut h, 0);
    let payer = Keypair::new();
    h.fund(&payer.pubkey(), 5_000_000_000);
    let before = h.svm.get_account(&payer.pubkey()).unwrap().lamports;
    h.send(
        &[ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc)],
        &[&t.kp, &payer],
    )
    .unwrap();
    let key = t.position_on(&btc);
    let p: Position = h.account(&key);
    assert_eq!(pk(p.owner), t.kp.pubkey());
    assert_eq!(pk(p.market), btc.market);
    assert_eq!(p.state, PositionState::Empty);
    let lamports = h.svm.get_account(&key).unwrap().lamports;
    assert_eq!(
        lamports,
        h.svm.get_account(&t.position).unwrap().lamports,
        "same rent + permission prefund as init_user's SOL position"
    );
    println!(
        "MEASURE init_position: position lamports {lamports}, payer spent {}",
        before - h.svm.get_account(&payer.pubkey()).unwrap().lamports
    );
}

#[test]
fn init_position_requires_an_onboarded_active_owner_and_an_existing_market() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 5_000_000_000);
    let r = h.send(
        &[ixs::init_position(
            &stranger.pubkey(),
            &stranger.pubkey(),
            &btc,
        )],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotOnboarded as u32);

    let t = w.new_trader(&mut h, 0);
    let eth = sym("ETH");
    let ghost = Mkt {
        symbol: eth,
        market: pdas::market_for(&eth),
        risk: Pubkey::default(),
        feed: Pubkey::default(),
    };
    let r = h.send(
        &[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &ghost)],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::MarketNotFound as u32);

    // LiteSVM: undelegate_user sets `exited` and skips the ER CPIs.
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    let r = h.send(
        &[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &btc)],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::UserExited as u32);
}

#[test]
fn init_position_needs_the_owner_signature_and_is_one_per_market() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let t = w.new_trader(&mut h, 0);
    let payer = Keypair::new();
    h.fund(&payer.pubkey(), 5_000_000_000);
    let mut unsigned = ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc);
    unsigned.accounts[0].is_signer = false;
    let r = h.send(&[unsigned], &[&payer]);
    assert_eq!(custom_error_code(&r), Some(3010), "AccountNotSigner");
    h.send(
        &[ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc)],
        &[&t.kp, &payer],
    )
    .unwrap();
    let again = h.send(
        &[ixs::init_position(&t.kp.pubkey(), &payer.pubkey(), &btc)],
        &[&t.kp, &payer],
    );
    assert!(again.is_err(), "one position per owner per market");
}

#[test]
fn delegate_position_passes_its_guards_and_refuses_an_exited_owner() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    let t = w.new_trader(&mut h, 0);
    h.send(
        &[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &btc)],
        &[&t.kp],
    )
    .unwrap();
    let r = h.send(
        &[ixs::delegate_position(
            &t.kp.pubkey(),
            &t.kp.pubkey(),
            &w,
            &btc,
        )],
        &[&t.kp],
    );
    assert!(r.is_err(), "no delegation program is deployed on LiteSVM");
    assert_eq!(
        custom_error_code(&r),
        None,
        "must fail at the delegation CPI, not at a constraint"
    );
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    let r = h.send(
        &[ixs::delegate_position(
            &t.kp.pubkey(),
            &t.kp.pubkey(),
            &w,
            &btc,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::UserExited as u32);
}

/// SOL at $150 and BTC at $80k, one trader with 1,000 dUSDC and a BTC position slot.
fn two_markets(h: &mut Harness) -> (World, Mkt, dexxer_litesvm::setup::Trader) {
    let w = World::bootstrap(h);
    let btc = w.add_market(h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w.set_price_on(h, &btc, B80K, 5, NOW, 100);
    let t = w.new_trader(h, 1_000_000_000);
    h.send(
        &[ixs::init_position(&t.kp.pubkey(), &t.kp.pubkey(), &btc)],
        &[&t.kp],
    )
    .unwrap();
    (w, btc, t)
}

#[test]
fn one_trader_holds_isolated_positions_on_two_markets() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    h.send(
        &[ixs::open_position_on(
            &t.kp.pubkey(),
            &t,
            &w,
            &btc,
            Side::Short,
            BTC_01,
            M80,
            B80K,
        )],
        &[&t.kp],
    )
    .unwrap();
    let u: UserAccount = h.account(&t.user);
    let sol: Position = h.account(&t.position);
    let b: Position = h.account(&t.position_on(&btc));
    assert_eq!(
        (sol.state, b.state),
        (PositionState::Open, PositionState::Open)
    );
    assert_eq!(u.locked_margin, sol.margin + b.margin);
    dexxer_litesvm::assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn a_btc_crash_liquidates_only_the_btc_position() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    h.send(
        &[ixs::open_position_on(
            &t.kp.pubkey(),
            &t,
            &w,
            &btc,
            Side::Long,
            BTC_01,
            M80,
            B80K,
        )],
        &[&t.kp],
    )
    .unwrap();
    // Hard EMA + wide deviation guard: the BTC mark lands on $70k in one tick.
    let mut p = btc_params();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(
            &w.admin.pubkey(),
            &w.config,
            &btc.market,
            p,
        )],
        &[&w.admin],
    )
    .unwrap();
    w.set_price_on(&mut h, &btc, B70K, 5, NOW, 101);
    for _ in 0..btc_params().liq_hysteresis_ticks {
        h.send(
            &[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[&t])],
            &[&w.crank],
        )
        .unwrap();
    }
    assert_eq!(
        h.account::<Position>(&t.position_on(&btc)).state,
        PositionState::Empty,
        "BTC liquidated"
    );
    let sol: Position = h.account(&t.position);
    assert_eq!(
        sol.state,
        PositionState::Open,
        "SOL untouched by the BTC crank"
    );
    assert_eq!(h.account::<UserAccount>(&t.user).locked_margin, sol.margin);
    dexxer_litesvm::assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn an_open_btc_position_blocks_the_exit_until_closed() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    h.send(
        &[ixs::open_position_on(
            &t.kp.pubkey(),
            &t,
            &w,
            &btc,
            Side::Long,
            BTC_01,
            M80,
            B80K,
        )],
        &[&t.kp],
    )
    .unwrap();
    // The SOL position is Empty — only the margin gate can stop this exit.
    let r = h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::BalanceNotZero as u32);
    h.send(
        &[ixs::close_position_on(&t.kp.pubkey(), &t, &w, &btc, B80K)],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(
        h.account::<Position>(&t.position_on(&btc)).state,
        PositionState::Empty
    );
    assert_eq!(h.account::<UserAccount>(&t.user).locked_margin, 0);
    dexxer_litesvm::assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn init_position_permission_accepts_the_owner_or_a_live_session_only() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    let t = w.new_trader(&mut h, 0);
    let o = t.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&t.kp])
        .unwrap();
    h.send(&[ixs::init_position_permission(&o, &w, &o, &btc)], &[&t.kp])
        .unwrap();

    let stranger = Keypair::new();
    let r = h.send(
        &[ixs::init_position_permission(
            &stranger.pubkey(),
            &w,
            &o,
            &btc,
        )],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let session = Keypair::new();
    h.send(
        &[ixs::set_session(&o, &t, &session.pubkey(), NOW + 3_600, 10)],
        &[&t.kp],
    )
    .unwrap();
    h.send(
        &[ixs::init_position_permission(
            &session.pubkey(),
            &w,
            &o,
            &btc,
        )],
        &[&session],
    )
    .unwrap();

    h.warp(200, NOW + 7_200);
    let r = h.send(
        &[ixs::init_position_permission(
            &session.pubkey(),
            &w,
            &o,
            &btc,
        )],
        &[&session],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

#[test]
fn set_session_updates_the_owners_other_positions_and_rejects_foreign_or_mismatched_pairs() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    let t = w.new_trader(&mut h, 0);
    let u = w.new_trader(&mut h, 0);
    for x in [&t, &u] {
        h.send(
            &[ixs::init_position(&x.kp.pubkey(), &x.kp.pubkey(), &btc)],
            &[&x.kp],
        )
        .unwrap();
    }
    let o = t.kp.pubkey();
    let session = Keypair::new().pubkey();

    h.send(
        &[ixs::set_session_with(
            &o,
            &t,
            &session,
            NOW + 3_600,
            10,
            &[t.position_on(&btc)],
        )],
        &[&t.kp],
    )
    .unwrap();

    let r = h.send(
        &[ixs::set_session_with(
            &o,
            &t,
            &session,
            NOW + 3_601,
            10,
            &[u.position_on(&btc)],
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let mut wrong_perm =
        ixs::set_session_with(&o, &t, &session, NOW + 3_602, 10, &[t.position_on(&btc)]);
    let last = wrong_perm.accounts.len() - 1;
    wrong_perm.accounts[last].pubkey = pdas::permission(&t.user);
    let r = h.send(&[wrong_perm], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidInput as u32);

    let mut odd = ixs::set_session_with(&o, &t, &session, NOW + 3_603, 10, &[t.position_on(&btc)]);
    odd.accounts.pop();
    let r = h.send(&[odd], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidInput as u32);

    let not_a_position = ixs::set_session_with(&o, &t, &session, NOW + 3_604, 10, &[t.user]);
    let r = h.send(&[not_a_position], &[&t.kp]);
    assert_eq!(
        custom_error_code(&r),
        Some(3002),
        "AccountDiscriminatorMismatch"
    );
}

#[test]
fn undelegate_position_owner_anytime_crank_only_after_exit_never_while_open() {
    let mut h = Harness::new();
    let (w, btc, a) = two_markets(&mut h);
    h.send(
        &[ixs::open_position_on(
            &a.kp.pubkey(),
            &a,
            &w,
            &btc,
            Side::Long,
            BTC_01,
            M80,
            B80K,
        )],
        &[&a.kp],
    )
    .unwrap();
    let r = h.send(
        &[ixs::undelegate_position(
            &a.kp.pubkey(),
            &w,
            &a.kp.pubkey(),
            &btc,
        )],
        &[&a.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::HasOpenPosition as u32);

    let b = w.new_trader(&mut h, 0);
    let o = b.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&b.kp])
        .unwrap();
    let stranger = Keypair::new();
    let r = h.send(
        &[ixs::undelegate_position(&stranger.pubkey(), &w, &o, &btc)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    let r = h.send(
        &[ixs::undelegate_position(&w.crank.pubkey(), &w, &o, &btc)],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    h.send(&[ixs::undelegate_position(&o, &w, &o, &btc)], &[&b.kp])
        .unwrap();

    h.send(&[ixs::undelegate_user(&o, &b, &w)], &[&b.kp])
        .unwrap();
    h.send(
        &[ixs::undelegate_position(&w.crank.pubkey(), &w, &o, &btc)],
        &[&w.crank],
    )
    .unwrap();
}

#[test]
fn close_exited_position_only_for_empty_positions_of_owners_who_left() {
    let mut h = Harness::new();
    let (w, btc, a) = two_markets(&mut h);
    // Active owner with an open BTC position: the Empty constraint fires first.
    h.send(
        &[ixs::open_position_on(
            &a.kp.pubkey(),
            &a,
            &w,
            &btc,
            Side::Long,
            BTC_01,
            M80,
            B80K,
        )],
        &[&a.kp],
    )
    .unwrap();
    let r = h.send(
        &[ixs::close_exited_position(
            &w.fee_payer.pubkey(),
            &w,
            &a.kp.pubkey(),
            &btc,
        )],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::HasOpenPosition as u32);

    let b = w.new_trader(&mut h, 0);
    let o = b.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&b.kp])
        .unwrap();
    let r = h.send(
        &[ixs::close_exited_position(
            &w.fee_payer.pubkey(),
            &w,
            &o,
            &btc,
        )],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);
    // A UserAccount still delegated on L1 (owned by the Delegation Program) is
    // an ACTIVE owner, not a departed one (Review Focus 4). LiteSVM has no
    // delegation program, so the ownership is set by hand.
    let mut ua = h.svm.get_account(&b.user).unwrap();
    let program_owner = ua.owner;
    ua.owner = ixs::dlp();
    h.svm.set_account(b.user, ua.clone()).unwrap();
    let r = h.send(
        &[ixs::close_exited_position(
            &w.fee_payer.pubkey(),
            &w,
            &o,
            &btc,
        )],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);
    ua.owner = program_owner;
    h.svm.set_account(b.user, ua).unwrap();
    h.send(&[ixs::undelegate_user(&o, &b, &w)], &[&b.kp])
        .unwrap();
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::close_exited_position(&stranger.pubkey(), &w, &o, &btc)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    h.send(
        &[ixs::close_exited_position(
            &w.fee_payer.pubkey(),
            &w,
            &o,
            &btc,
        )],
        &[&w.fee_payer],
    )
    .unwrap();
    assert!(
        h.svm
            .get_account(&b.position_on(&btc))
            .is_none_or(|x| x.lamports == 0),
        "closed"
    );

    // Owner fully gone (close_exited_user already reclaimed UserAccount/SOL position).
    let c = w.new_trader(&mut h, 0);
    let oc = c.kp.pubkey();
    h.send(&[ixs::init_position(&oc, &oc, &btc)], &[&c.kp])
        .unwrap();
    h.send(&[ixs::undelegate_user(&oc, &c, &w)], &[&c.kp])
        .unwrap();
    h.send(
        &[ixs::close_exited_user(&w.fee_payer.pubkey(), &c, &w)],
        &[&w.fee_payer],
    )
    .unwrap();
    h.send(
        &[ixs::close_exited_position(
            &w.fee_payer.pubkey(),
            &w,
            &oc,
            &btc,
        )],
        &[&w.fee_payer],
    )
    .unwrap();
}

/// Legacy-transaction wire length: signatures + header + keys + blockhash +
/// compiled instructions (compact-u16 lengths throughout).
fn wire_len(msg: &solana_message::Message) -> usize {
    fn cu16(n: usize) -> usize {
        if n < 0x80 {
            1
        } else if n < 0x4000 {
            2
        } else {
            3
        }
    }
    let sigs = msg.header.num_required_signatures as usize;
    let ixs: usize = msg
        .instructions
        .iter()
        .map(|i| 1 + cu16(i.accounts.len()) + i.accounts.len() + cu16(i.data.len()) + i.data.len())
        .sum();
    cu16(sigs)
        + 64 * sigs
        + 3
        + cu16(msg.account_keys.len())
        + 32 * msg.account_keys.len()
        + 32
        + cu16(msg.instructions.len())
        + ixs
}

/// Spec §2.8 measurements: CU of every new instruction on its LiteSVM path
/// (ER CPIs skipped here — devnet numbers come with plan 2), and the size of
/// the sponsored L1 leg that enables N markets for one owner.
#[test]
fn measure_new_instructions() {
    use solana_instruction::{AccountMeta, Instruction};
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    type Tx =
        Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>;
    let cu = |r: &Tx| {
        r.as_ref().map_or_else(
            |e| e.meta.compute_units_consumed,
            |m| m.compute_units_consumed,
        )
    };

    let r = h.send(
        &[ixs::init_market(
            &w.admin.pubkey(),
            sym("ETH"),
            btc_params(),
            "2",
        )],
        &[&w.admin],
    );
    println!("MEASURE cu init_market {}", cu(&r));
    let eth = Mkt {
        symbol: sym("ETH"),
        market: pdas::market_for(&sym("ETH")),
        risk: pdas::risk(&pdas::market_for(&sym("ETH"))),
        feed: pdas::feed_for(&w.oracle_program, "2"),
    };
    let r = h.send(&[ixs::init_position(&o, &o, &eth)], &[&t.kp]);
    println!("MEASURE cu init_position {}", cu(&r));
    let r = h.send(&[ixs::init_position_permission(&o, &w, &o, &btc)], &[&t.kp]);
    println!("MEASURE cu init_position_permission (auth only) {}", cu(&r));
    let session = Keypair::new().pubkey();
    let r = h.send(
        &[ixs::set_session(&o, &t, &session, NOW + 3_600, 10)],
        &[&t.kp],
    );
    println!("MEASURE cu set_session 0 pairs {}", cu(&r));
    let r = h.send(
        &[ixs::set_session_with(
            &o,
            &t,
            &session,
            NOW + 3_601,
            10,
            &[t.position_on(&btc), t.position_on(&eth)],
        )],
        &[&t.kp],
    );
    assert!(r.is_ok());
    println!("MEASURE cu set_session 2 pairs {}", cu(&r));
    let r = h.send(&[ixs::undelegate_position(&o, &w, &o, &eth)], &[&t.kp]);
    println!("MEASURE cu undelegate_position (no ER CPIs) {}", cu(&r));
    // `t` still holds a deposit, so its exit is (rightly) blocked — a fresh,
    // empty owner walks the close path.
    let z = w.new_trader(&mut h, 0);
    let oz = z.kp.pubkey();
    h.send(&[ixs::init_position(&oz, &oz, &btc)], &[&z.kp])
        .unwrap();
    h.send(&[ixs::undelegate_user(&oz, &z, &w)], &[&z.kp])
        .unwrap();
    let r = h.send(
        &[ixs::close_exited_position(
            &w.fee_payer.pubkey(),
            &w,
            &oz,
            &btc,
        )],
        &[&w.fee_payer],
    );
    assert!(r.is_ok());
    println!("MEASURE cu close_exited_position {}", cu(&r));

    // The sponsored onboarding shape (week 5, wallets 5 and 7): fee_payer pays,
    // owner signs, `AdvanceNonceAccount` first, then two ComputeBudget ixs.
    let fee_payer = w.fee_payer.pubkey();
    let nonce = Keypair::new().pubkey();
    let recent_blockhashes: Pubkey = "SysvarRecentB1ockHashes11111111111111111111"
        .parse()
        .unwrap();
    let cb: Pubkey = "ComputeBudget111111111111111111111111111111"
        .parse()
        .unwrap();
    let advance = Instruction {
        program_id: Pubkey::default(),
        accounts: vec![
            AccountMeta::new(nonce, false),
            AccountMeta::new_readonly(recent_blockhashes, false),
            AccountMeta::new_readonly(o, true),
        ],
        data: 4u32.to_le_bytes().to_vec(),
    };
    let mut limit = vec![2u8];
    limit.extend(400_000u32.to_le_bytes());
    let mut price = vec![3u8];
    price.extend(1_000u64.to_le_bytes());
    let markets: Vec<Mkt> = ["BTC", "ETH", "HYPE"]
        .iter()
        .map(|s| {
            let m = pdas::market_for(&sym(s));
            Mkt {
                symbol: sym(s),
                market: m,
                risk: pdas::risk(&m),
                feed: Pubkey::default(),
            }
        })
        .collect();
    for n in 1..=markets.len() {
        let mut ixs_ = vec![
            advance.clone(),
            Instruction {
                program_id: cb,
                accounts: vec![],
                data: limit.clone(),
            },
            Instruction {
                program_id: cb,
                accounts: vec![],
                data: price.clone(),
            },
        ];
        for m in &markets[..n] {
            ixs_.push(ixs::init_position(&o, &fee_payer, m));
            ixs_.push(ixs::delegate_position(&o, &fee_payer, &w, m));
        }
        let msg = solana_message::Message::new(&ixs_, Some(&fee_payer));
        println!(
            "MEASURE tx bytes nonce+2cb+[init_position,delegate_position]x{n}: {} (limit 1232)",
            wire_len(&msg)
        );
    }
    // Session renewal with every extra market (BTC/ETH/HYPE/ZEC), owner-paid.
    let extra: Vec<Pubkey> = ["BTC", "ETH", "HYPE", "ZEC"]
        .iter()
        .map(|s| pdas::position(&o, &pdas::market_for(&sym(s))))
        .collect();
    let ix = ixs::set_session_with(&o, &t, &session, NOW + 3_602, 10, &extra);
    let msg = solana_message::Message::new(&[ix], Some(&o));
    println!(
        "MEASURE tx bytes set_session + 4 pairs: {} (limit 1232)",
        wire_len(&msg)
    );
}

/// `init_user` pins the SOL position to the `UserAccount`, so its whole
/// lifecycle must stay with it: the user exits only with the SOL position, and
/// the per-market exits never take it. Either mix-up strands an account.
#[test]
fn the_sol_position_moves_only_with_the_user_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let btc = w.add_market(&mut h, "BTC", "1", btc_params());
    h.warp(100, NOW);
    let t = w.new_trader(&mut h, 0);
    let o = t.kp.pubkey();
    h.send(&[ixs::init_position(&o, &o, &btc)], &[&t.kp])
        .unwrap();
    let mismatch = 6000 + DexxerError::PrimaryPositionMismatch as u32;

    // Mid-onboarding, a SOL `delegate_position` would pre-empt `delegate_user`.
    let r = h.send(&[ixs::delegate_position(&o, &o, &w, &w.sol())], &[&t.kp]);
    assert_custom_error(&r, mismatch);
    let r = h.send(&[ixs::undelegate_position(&o, &w, &o, &w.sol())], &[&t.kp]);
    assert_custom_error(&r, mismatch);
    let btc_pos = t.position_on(&btc);
    let mut wrong = ixs::undelegate_user(&o, &t, &w);
    wrong.accounts[3].pubkey = btc_pos;
    wrong.accounts[5].pubkey = pdas::permission(&btc_pos);
    let r = h.send(&[wrong], &[&t.kp]);
    assert_custom_error(&r, mismatch);
    h.send(&[ixs::undelegate_user(&o, &t, &w)], &[&t.kp])
        .unwrap();

    let fp = w.fee_payer.pubkey();
    let r = h.send(
        &[ixs::close_exited_position(&fp, &w, &o, &w.sol())],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, mismatch);
    let mut wrong = ixs::close_exited_user(&fp, &t, &w);
    wrong.accounts[3].pubkey = btc_pos;
    let r = h.send(&[wrong], &[&w.fee_payer]);
    assert_custom_error(&r, mismatch);
    h.send(&[ixs::close_exited_user(&fp, &t, &w)], &[&w.fee_payer])
        .unwrap();
    h.send(
        &[ixs::close_exited_position(&fp, &w, &o, &btc)],
        &[&w.fee_payer],
    )
    .unwrap();
}
