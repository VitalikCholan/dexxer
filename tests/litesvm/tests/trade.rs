use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, assert_invariant, ixs,
    setup::{World, SEED_AMOUNT},
    Harness,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;

// Bootstrap's own faucet-funding loop already warps the clock to slot 9001 /
// ts 1_777_609 (nine daily faucet_mint calls). Pick a later slot/ts here so
// this doesn't warp backwards, and use NOW consistently as the base for every
// set_price/set_session value below so the relative assertions (expiry >
// now, staleness in seconds) keep the meaning the task-7 brief intended.
const NOW: i64 = 2_000_000;

fn world_with_price(h: &mut Harness) -> World {
    let w = World::bootstrap(h);
    h.warp(9_101, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w
}

#[test]
fn open_long_10x_locks_margin_and_fee() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
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
    let p = h.slot(&t, &w.market).expect("open slot");
    assert!(p.is_open());
    assert_eq!(p.entry, P150);
    assert_eq!(p.margin, M150);
    assert_eq!(p.liq_price, 142_500_000);
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.free_margin, 1_000_000_000 - M150 - 900_000); // open fee 6 bps of 1500 $ = 0.9 $
    assert_eq!(u.locked_margin, M150);
    let pool: PoolLive = h.account(&w.pool_live);
    assert_eq!(pool.locked_total, M150);
    assert_eq!(pool.fees_accrued, 900_000);
    let r: MarketRisk = h.account(&w.risk);
    assert_eq!(r.oi_long, 1_500_000_000);
    assert_eq!(r.open_positions, 1);
    assert_eq!(
        h.account::<Market>(&w.market).mark,
        P150,
        "first tick seeds mark = index"
    );
}

#[test]
fn open_guards() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let o = t.kp.pubkey();
    let r = h.send(
        &[ixs::open_position(
            &o,
            &t,
            &w,
            Side::Long,
            SOL10,
            136_000_000,
            P150,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::InsufficientMargin as u32);
    let r = h.send(
        &[ixs::open_position(
            &o,
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            149_000_000,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::SlippageExceeded as u32);
    let r = h.send(
        &[ixs::open_position(
            &o,
            &t,
            &w,
            Side::Long,
            SOL10,
            1_000_000_000,
            P150,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::InsufficientMargin as u32); // margin <= notional (1.5x) but free_margin < margin + fee
    w.set_price(&mut h, P150, 0, NOW, 100);
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
    assert_custom_error(&r, 6000 + DexxerError::OracleConfidence as u32);
    w.set_price(&mut h, P150, 5, NOW - 10, 100);
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
    assert_custom_error(&r, 6000 + DexxerError::StaleOracle as u32);
    w.set_price(&mut h, P150, 5, NOW, 0);
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
    assert_custom_error(&r, 6000 + DexxerError::StaleOracle as u32);
    h.send(&[ixs::pause(&w.admin.pubkey(), &w.config)], &[&w.admin])
        .unwrap();
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
    assert_custom_error(&r, 6000 + DexxerError::Paused as u32);
}

#[test]
fn wrong_feed_account_rejected() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let mut ix = ixs::open_position(&t.kp.pubkey(), &t, &w, Side::Long, SOL10, M150, P150);
    // `feed` is index 7 of `Trader::trade_accounts` — no longer the last account
    // (fee_escrow / task_context / magic_program / liq_crank_signer follow it).
    ix.accounts[7].pubkey = w.market; // any other account in place of the feed
    let r = h.send(&[ix], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::WrongFeed as u32);
}

#[test]
fn session_key_can_trade_within_limits_stranger_cannot() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let session = Keypair::new();
    h.fund(&session.pubkey(), 1_000_000_000);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::open_position(
            &stranger.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    h.send(
        &[ixs::set_session(
            &t.kp.pubkey(),
            &t,
            &session.pubkey(),
            NOW + 1_000_000,
            1,
        )],
        &[&t.kp],
    )
    .unwrap();
    h.send(
        &[ixs::open_position(
            &session.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&session],
    )
    .unwrap();
    let r = h.send(
        &[ixs::add_margin(&session.pubkey(), &t, &w, 1_000_000)],
        &[&session],
    );
    assert_custom_error(&r, 6000 + DexxerError::NoActionsLeft as u32);
    h.send(
        &[ixs::set_session(
            &t.kp.pubkey(),
            &t,
            &session.pubkey(),
            500_000,
            5,
        )],
        &[&t.kp],
    )
    .unwrap(); // already expired (now = NOW = 2_000_000)
    let r = h.send(
        &[ixs::add_margin(&session.pubkey(), &t, &w, 1_000_000)],
        &[&session],
    );
    assert_custom_error(&r, 6000 + DexxerError::SessionExpired as u32);
}

#[test]
fn close_with_profit_pays_from_protocol_liquidity() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
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
    w.set_price(&mut h, 165_000_000, 5, NOW, 101);
    h.send(
        &[ixs::close_position(&t.kp.pubkey(), &t, &w, 165_000_000)],
        &[&t.kp],
    )
    .unwrap();
    // pnl +150 $, close fee 6 bps of 1650 $ = 0.99 $ -> to_user = 150 + 150 - 0.99
    let u: UserAccount = h.account(&t.user);
    assert_eq!(
        u.free_margin,
        1_000_000_000 - M150 - 900_000 + (M150 + 150_000_000 - 990_000)
    );
    assert_eq!(u.locked_margin, 0);
    assert!(h.slot(&t, &w.market).is_none());
    // The only slot this trader ever used is the first one; a cleared slot is
    // all-zero, `market` included.
    let p = h.positions(&t.positions).slots[0];
    assert!(!p.is_open());
    assert_eq!(p.market, Default::default());
    assert_eq!(
        (
            p.size,
            p.entry,
            p.margin,
            p.liq_price,
            p.oi_notional,
            p.liq_ticks,
            p.opened_slot
        ),
        (0, 0, 0, 0, 0, 0, 0),
        "every trade field is reset, nothing left behind for the next open"
    );
    let pool: PoolLive = h.account(&w.pool_live);
    assert_eq!(pool.protocol_liquidity, SEED_AMOUNT - 150_000_000);
    assert_eq!(pool.fees_accrued, 900_000 + 990_000);
    assert_eq!(pool.locked_total, 0);
    assert_eq!(h.account::<MarketRisk>(&w.risk).oi_long, 0);
    // Closing again is a no-op error: the position is `Empty` now. Reopening
    // straight away is covered by `nine_closes_in_a_row_all_succeed`.
    let r = h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::PositionNotOpen as u32);
}

#[test]
fn close_short_with_loss_keeps_pool_whole() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Short,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    w.set_price(&mut h, 160_000_000, 5, NOW, 101);
    h.send(
        &[ixs::close_position(&t.kp.pubkey(), &t, &w, 160_000_000)],
        &[&t.kp],
    )
    .unwrap();
    // pnl -100 $, fee 6 bps of 1600 $ = 0.96 $ -> to_user 49.04 $
    assert_eq!(
        h.account::<UserAccount>(&t.user).free_margin,
        1_000_000_000 - M150 - 900_000 + 49_040_000
    );
    let pool: PoolLive = h.account(&w.pool_live);
    assert_eq!(pool.protocol_liquidity, SEED_AMOUNT + 100_000_000);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn deviation_guard_blocks_open_not_close() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    // Seed the mark via one crank tick before anyone has a position.
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    assert_eq!(h.account::<Market>(&w.market).mark, P150);

    // Open while index == mark: no deviation, succeeds.
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

    // Index jumps to 160 (+6.67 %, over the 2 % max_deviation_bps default)
    // with no crank tick in between to move the mark: mark is still 150.
    w.set_price(&mut h, 160_000_000, 5, NOW, 101);
    let t2 = w.new_trader(&mut h, 1_000_000_000);
    let r = h.send(
        &[ixs::open_position(
            &t2.kp.pubkey(),
            &t2,
            &w,
            Side::Long,
            SOL10,
            M150,
            u64::MAX,
        )],
        &[&t2.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::OracleDeviation as u32);

    // An existing position can still close under the same deviated index —
    // close_position never calls check_deviation (spec §3.4: exit must
    // always be available).
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert!(h.slot(&t, &w.market).is_none());
    assert_invariant(&h, &w, &[&t, &t2]);
}

#[test]
fn nine_closes_in_a_row_all_succeed() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let o = t.kp.pubkey();
    for i in 0..9u64 {
        // Distinct slots keep each transaction's bytes unique.
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
            .unwrap_or_else(|e| panic!("close #{i} failed: {e:?}"));
        assert_invariant(&h, &w, &[&t]);
    }
    assert!(h.slot(&t, &w.market).is_none());
}
