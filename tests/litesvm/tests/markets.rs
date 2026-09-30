// Markets beyond SOL (spec §2.8) and the position slots that hold a trader's
// positions on all of them in one account (spec §2.9): per-market isolation,
// every instruction on a market where the trader has no slot, the 16-slot
// ceiling, the history ring, and the CU measurement of the slot instructions.
// LiteSVM has no Delegation/Permission/Magic program, so delegation CPIs fail
// by design (asserted as "passed every constraint": no custom error) and ER
// CPIs are gated off by `executable`.
use anchor_lang::InstructionData;
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, assert_invariant, assert_invariant_markets, custom_error_code, ixs, pk,
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
const BTC_01: u64 = 10_000_000; // 0.01 BTC at 1e9 size scale -> $800 notional at $80k
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

fn two_markets(h: &mut Harness) -> (World, Mkt, dexxer_litesvm::setup::Trader) {
    let w = World::bootstrap(h);
    let btc = w.add_market(h, "BTC", "1", btc_params());
    h.warp(9_101, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w.set_price_on(h, &btc, B80K, 5, NOW, 100);
    let t = w.new_trader(h, 1_000_000_000);
    (w, btc, t)
}

#[test]
fn one_trader_holds_isolated_positions_on_two_markets() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
            &o,
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
    let sol = h.slot(&t, &w.market).expect("SOL slot");
    let b = h.slot(&t, &btc.market).expect("BTC slot");
    assert_eq!((sol.margin, b.margin), (M150, M80));
    assert_eq!(b.side(), Side::Short);
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.locked_margin, M150 + M80);
    assert_eq!(h.positions(&t.positions).open_count(), 2);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn closing_one_market_leaves_the_other_untouched_and_a_wrong_market_is_refused() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
    // No BTC position: closing on BTC must not touch the SOL slot.
    let sol_before = slot_bytes(&h, &t, &w.market);
    let r = h.send(&[ixs::close_position_on(&o, &t, &w, &btc, B80K)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::PositionNotOpen as u32);
    assert_eq!(slot_bytes(&h, &t, &w.market), sol_before);
    h.warp(9_102, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    h.send(&[ixs::close_position(&o, &t, &w, P150)], &[&t.kp])
        .unwrap();
    assert!(h.slot(&t, &w.market).is_none());
    assert_eq!(h.positions(&t.positions).open_count(), 0);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

/// The raw 96 bytes of the trader's OPEN slot on `market` (panics if none).
fn slot_bytes(h: &Harness, t: &dexxer_litesvm::setup::Trader, market: &Pubkey) -> Vec<u8> {
    let s = h.slot(t, market).expect("open slot");
    anchor_lang::__private::bytemuck::bytes_of(&s).to_vec()
}

/// Review Focus 1 for the rest of the trading instructions: increase,
/// decrease and add_margin on a market where the trader has no slot are
/// refused with `PositionNotOpen`, and the slot on the other market does not
/// change by a byte.
#[test]
fn trading_on_a_market_without_a_slot_is_refused_and_leaves_the_other_slot() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
    let sol_before = slot_bytes(&h, &t, &w.market);
    let user_before = h.svm.get_account(&t.user).unwrap().data;
    let tries = [
        ixs::increase_position_on(&o, &t, &w, &btc, BTC_01, M80, u64::MAX),
        ixs::decrease_position_on(&o, &t, &w, &btc, BTC_01, 0),
        ixs::add_margin_on(&o, &t, &w, &btc, M80),
    ];
    for ix in tries {
        let r = h.send(&[ix], &[&t.kp]);
        assert_custom_error(&r, 6000 + DexxerError::PositionNotOpen as u32);
        assert_eq!(slot_bytes(&h, &t, &w.market), sol_before);
        assert_eq!(h.svm.get_account(&t.user).unwrap().data, user_before);
    }
    assert!(h.slot(&t, &btc.market).is_none());
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

/// Review Focus 1 for the liquidation paths: a crank tick and a scheduled
/// check on a market where the trader has no slot succeed as a no-op, even
/// with the trader's slot on the other market liquidatable at its own mark.
#[test]
fn crank_and_check_on_a_market_without_a_slot_are_no_ops() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
    // The SOL mark crashes to 142 (below the ~142.5 liq price) with no
    // candidate, so the SOL slot is liquidatable but untouched.
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    w.set_price(&mut h, 142_000_000, 5, NOW, 101);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let sol_before = slot_bytes(&h, &t, &w.market);
    let user_before = h.svm.get_account(&t.user).unwrap().data;
    // Two BTC prints, each seen by a BTC crank with the trader as candidate
    // and by a BTC liquidation_check on the trader.
    for i in 0..2u64 {
        h.warp(9_110 + i, NOW);
        w.set_price_on(&mut h, &btc, B70K, 5, NOW, 101 + i);
        h.send(
            &[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[&t])],
            &[&w.crank],
        )
        .unwrap();
        h.send(
            &[ixs::liquidation_check_on(&w.crank.pubkey(), &w, &btc, &t)],
            &[&w.crank],
        )
        .unwrap();
        assert_eq!(slot_bytes(&h, &t, &w.market), sol_before);
        assert_eq!(h.svm.get_account(&t.user).unwrap().data, user_before);
    }
    assert!(
        h.account::<Market>(&btc.market).sample_seq >= 2,
        "BTC ticked"
    );
    assert_eq!(h.positions(&t.positions).history_len, 0);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn a_btc_crash_liquidates_only_the_btc_position() {
    let mut h = Harness::new();
    let (w, btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
            &o,
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
    let sol_before = slot_bytes(&h, &t, &w.market);
    // One price sample per tick (risk #38): a new slot and post before each.
    for i in 0..btc_params().liq_hysteresis_ticks as u64 {
        h.warp(9_110 + i, NOW);
        w.set_price_on(&mut h, &btc, B70K, 5, NOW, 101 + i);
        h.send(
            &[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[&t])],
            &[&w.crank],
        )
        .unwrap();
    }
    assert!(h.slot(&t, &btc.market).is_none(), "BTC liquidated");
    assert_eq!(slot_bytes(&h, &t, &w.market), sol_before, "SOL untouched");
    // A SOL crank with the same trader as candidate: SOL is healthy at 150.
    w.set_price(&mut h, P150, 5, NOW, 102);
    h.send(
        &[ixs::crank_tick_on(&w.crank.pubkey(), &w, &w.sol(), &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(
        slot_bytes(&h, &t, &w.market),
        sol_before,
        "SOL survives its own crank"
    );
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 1);
    assert_eq!(p.history[0].reason, CloseReason::Liquidated.as_u8());
    assert_eq!(pk(p.history[0].market), btc.market);
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

// 16 opens by one trader: if a pool-utilisation or OI limit refuses one of them
// before the slot ceiling does, raise the test pool liquidity or the trader's
// deposit, never lower MAX_SLOTS or the number of markets in this test.
#[test]
fn the_seventeenth_market_has_no_free_slot_until_one_closes() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(9_101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    // SOL + 16 more markets (17 in all, one more than MAX_SLOTS), all priced
    // like SOL so SOL-sized trades fit.
    let mut mkts = vec![w.sol()];
    for i in 0..16 {
        let m = w.add_market(
            &mut h,
            &format!("M{}", i + 1),
            &format!("{}", 200 + i),
            MarketParams::sol_perp_defaults(),
        );
        w.set_price_on(&mut h, &m, P150, 5, NOW, 100);
        mkts.push(m);
    }
    let t = w.new_trader(&mut h, 5_000_000_000);
    let o = t.kp.pubkey();
    for m in &mkts[..16] {
        h.send(
            &[ixs::open_position_on(
                &o,
                &t,
                &w,
                m,
                Side::Long,
                SOL10,
                M150,
                P150,
            )],
            &[&t.kp],
        )
        .unwrap();
    }
    let before: UserAccount = h.account(&t.user);
    let r = h.send(
        &[ixs::open_position_on(
            &o,
            &t,
            &w,
            &mkts[16],
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::NoFreeSlot as u32);
    let after: UserAccount = h.account(&t.user);
    assert_eq!(
        before.free_margin, after.free_margin,
        "a refused open moves no money"
    );
    h.warp(9_102, NOW);
    for m in &mkts {
        w.set_price_on(&mut h, m, P150, 5, NOW, 100);
    }
    h.send(
        &[ixs::close_position_on(&o, &t, &w, &mkts[0], P150)],
        &[&t.kp],
    )
    .unwrap();
    h.send(
        &[ixs::open_position_on(
            &o,
            &t,
            &w,
            &mkts[16],
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    let keys: Vec<Pubkey> = mkts.iter().map(|m| m.market).collect();
    assert_invariant_markets(&h, &w, &[&t], &keys);
}

#[test]
fn a_second_open_on_the_same_market_is_refused() {
    let mut h = Harness::new();
    let (w, _btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
    h.warp(9_102, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let r = h.send(
        &[ixs::open_position(
            &o,
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::PositionNotEmpty as u32);
}

#[test]
fn the_seventeenth_close_overwrites_the_oldest_history_record() {
    let mut h = Harness::new();
    let (w, _btc, t) = two_markets(&mut h);
    let o = t.kp.pubkey();
    let mut first_closed = 0u64;
    for i in 0..17u64 {
        h.warp(9_200 + i * 2, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        h.send(
            &[ixs::open_position(
                &o,
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
        h.warp(9_201 + i * 2, NOW);
        w.set_price(&mut h, P150, 5, NOW, 100);
        h.send(&[ixs::close_position(&o, &t, &w, P150)], &[&t.kp])
            .unwrap();
        if i == 0 {
            first_closed = h.positions(&t.positions).history[0].closed_slot;
        }
    }
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 16);
    assert_eq!(p.history_head, 1);
    assert_ne!(
        p.history[0].closed_slot, first_closed,
        "record 17 replaced record 1"
    );
    assert_eq!(p.history[0].reason, CloseReason::User.as_u8());
    assert_invariant(&h, &w, &[&t]);
}

/// Not a regression gate on exact numbers — a measurement (`-- --nocapture`)
/// whose only asserts are that every measured instruction succeeded and did
/// what it should. Prints one `CU <name> = <n>` line per scenario (spec §2.9
/// "Реалізовано"). LiteSVM only: real ER/TEE CU is a devnet measurement.
#[test]
fn measure_slots() {
    use dexxer_litesvm::{pdas, setup::Trader, token_ix};
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(9_101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);

    // init_user (measured on a hand-built trader: `new_trader` hides it).
    let kp = Keypair::new();
    let o = kp.pubkey();
    h.fund(&o, 5_000_000_000);
    h.send(&[token_ix::create_ata(&o, &o, &w.mint)], &[&kp])
        .unwrap();
    h.send(&[ixs::faucet_init(&o, &w, 1_000_000_000)], &[&kp])
        .unwrap();
    let m = h
        .send(&[ixs::init_user(&o, &w, [0x5a; 32])], &[&kp])
        .unwrap();
    println!("CU init_user = {}", m.compute_units_consumed);
    let t = Trader {
        user: pdas::user(&o),
        positions: pdas::positions(&o),
        ata: token_ix::ata(&o, &w.mint),
        kp,
    };
    h.send(&[ixs::credit_deposit(&o, &t, &w, 1_000_000_000)], &[&t.kp])
        .unwrap();

    // Trading on one SOL slot.
    let m = h
        .send(
            &[ixs::open_position(
                &o,
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
    println!("CU open_position = {}", m.compute_units_consumed);
    assert!(h.slot(&t, &w.market).is_some());
    h.warp(9_102, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let m = h
        .send(
            &[ixs::increase_position(&o, &t, &w, SOL10, M150, P150)],
            &[&t.kp],
        )
        .unwrap();
    println!("CU increase_position = {}", m.compute_units_consumed);
    assert_eq!(h.slot(&t, &w.market).unwrap().size, 2 * SOL10);
    let m = h
        .send(&[ixs::close_position(&o, &t, &w, P150)], &[&t.kp])
        .unwrap();
    println!("CU close_position = {}", m.compute_units_consumed);
    assert!(h.slot(&t, &w.market).is_none());
    assert_eq!(h.positions(&t.positions).history_len, 1);

    // undelegate_user with 5 markets (SOL + 4) in remaining_accounts.
    let mut keys = vec![w.market];
    for (i, s) in ["BTC", "ETH", "HYPE", "ZEC"].iter().enumerate() {
        keys.push(
            w.add_market(&mut h, s, &format!("{}", 300 + i), btc_params())
                .market,
        );
    }
    let free = h.account::<UserAccount>(&t.user).free_margin;
    h.send(&[ixs::withdraw(&o, &t, &w, free)], &[&t.kp])
        .unwrap();
    let m = h
        .send(&[ixs::undelegate_user(&o, &t, &w, &keys)], &[&t.kp])
        .unwrap();
    println!(
        "CU undelegate_user (5 markets) = {}",
        m.compute_units_consumed
    );
    assert!(h.account::<UserAccount>(&t.user).exited);

    // liquidation_check: one trader, mark crashed by a candidate-less tick.
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::open_position(
            &o,
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
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    h.warp(101, NOW);
    w.set_price(&mut h, 142_000_000, 5, NOW, 101);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let m = h
        .send(
            &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
            &[&w.crank],
        )
        .unwrap();
    println!(
        "CU liquidation_check (counts tick 1, no liquidation) = {}",
        m.compute_units_consumed
    );
    assert_eq!(h.slot(&t, &w.market).unwrap().liq_ticks, 1);
    h.warp(102, NOW);
    w.set_price(&mut h, 142_000_000, 5, NOW, 102);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let m = h
        .send(
            &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
            &[&w.crank],
        )
        .unwrap();
    println!(
        "CU liquidation_check (liquidates) = {}",
        m.compute_units_consumed
    );
    assert!(h.slot(&t, &w.market).is_none());
    assert_invariant(&h, &w, &[&t]);

    // crank_tick with 16 candidates: healthy, then 16 liquidations.
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let traders: Vec<Trader> = (0..MAX_CANDIDATES)
        .map(|_| {
            let t = w.new_trader(&mut h, 1_000_000_000);
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
            t
        })
        .collect();
    let refs: Vec<&Trader> = traders.iter().collect();
    let big = ixs::set_compute_unit_limit(1_400_000);
    h.warp(101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 101);
    let m = h
        .send(
            &[big.clone(), ixs::crank_tick(&w.crank.pubkey(), &w, &refs)],
            &[&w.crank],
        )
        .unwrap();
    println!(
        "CU crank_tick (16 candidates, none liquidatable) = {}",
        m.compute_units_consumed
    );
    for t in &traders {
        let s = h.slot(t, &w.market).expect("nobody liquidated at 150");
        assert_eq!(s.liq_ticks, 0);
    }
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    // Two distinct prints below the liquidation price: tick 1, then 16 liquidations.
    for (i, last) in [(102u64, false), (103u64, true)] {
        h.warp(i, NOW);
        w.set_price(&mut h, 120_000_000, 5, NOW, i);
        let m = h
            .send(
                &[big.clone(), ixs::crank_tick(&w.crank.pubkey(), &w, &refs)],
                &[&w.crank],
            )
            .unwrap();
        if last {
            println!(
                "CU crank_tick (16 candidates, 16 liquidations) = {}",
                m.compute_units_consumed
            );
        } else {
            println!(
                "CU crank_tick (16 candidates, tick 1, none liquidated yet) = {}",
                m.compute_units_consumed
            );
        }
    }
    for t in &traders {
        assert!(h.slot(t, &w.market).is_none(), "every candidate liquidated");
    }
    assert_invariant(&h, &w, &refs);
}
