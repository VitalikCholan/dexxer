// Conditional orders (Limit / Stop / TP / SL / Trailing). Orders live in the
// optional order tail of `Positions` (`state/order.rs`) and are executed by the per-position scheduled task, i.e.
// by `liquidation_check` — every test here drives that very instruction.
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, assert_invariant, assert_invariant_markets, ixs,
    setup::{Trader, World},
    Harness,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const NOW: i64 = 2_000_000;
const P: u64 = 1_000_000; // $1 in 1e6
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
const M10: u64 = 10_000_000;
const M200: u64 = 200_000_000;

fn err(c: DexxerError) -> u32 {
    6000 + c as u32
}

/// World whose mark follows the oracle exactly (hard EMA, wide deviation).
fn world(h: &mut Harness) -> (World, Trader) {
    let w = World::bootstrap(h);
    h.warp(100, NOW);
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    let t = w.new_trader(h, 1_000_000_000);
    mark(h, &w, 150);
    (w, t)
}

/// Move the market mark to `$price` with a candidate-less crank tick.
fn mark(h: &mut Harness, w: &World, price: u64) {
    let slot = h.account::<Market>(&w.market).mark_slot + 1;
    w.set_price(h, price * P, 5, NOW, slot.max(100));
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), w, &[])], &[&w.crank])
        .unwrap();
    assert_eq!(h.account::<Market>(&w.market).mark, price * P);
}

fn tick(h: &mut Harness, w: &World, t: &Trader) {
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), w, t)],
        &[&w.crank],
    )
    .unwrap();
}

fn open_long(h: &mut Harness, w: &World, t: &Trader) {
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            t,
            w,
            Side::Long,
            SOL10,
            M150,
            150 * P,
        )],
        &[&t.kp],
    )
    .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn place(
    h: &mut Harness,
    w: &World,
    t: &Trader,
    kind: OrderKind,
    side: Side,
    size: u64,
    margin: u64,
    trigger: u64,
    trail_bps: u16,
    tp: u64,
    sl: u64,
) -> Result<(), ()> {
    h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            t,
            w,
            kind,
            side,
            size,
            margin,
            trigger,
            trail_bps,
            tp,
            sl,
        )],
        &[&t.kp],
    )
    .map(|_| ())
    .map_err(|_| ())
}

fn exit_tp_sl(h: &mut Harness, w: &World, t: &Trader, kind: OrderKind, trigger: u64) {
    place(h, w, t, kind, Side::Long, 0, 0, trigger * P, 0, 0, 0).unwrap();
}

fn orders(h: &Harness, t: &Trader) -> Vec<OrderKind> {
    h.orders(&t.positions)
        .iter()
        .filter(|o| !o.is_empty())
        .map(|o| o.kind())
        .collect()
}

/// The SOL slot, if open.
fn slot(h: &Harness, w: &World, t: &Trader) -> Option<PositionSlot> {
    h.slot(t, &w.market)
}

fn is_open(h: &Harness, w: &World, t: &Trader) -> bool {
    slot(h, w, t).is_some()
}

fn free(h: &Harness, t: &Trader) -> u64 {
    h.account::<UserAccount>(&t.user).free_margin
}

fn reserved(h: &Harness, t: &Trader) -> u64 {
    h.account::<UserAccount>(&t.user).order_reserved
}

fn locked(h: &Harness, t: &Trader) -> u64 {
    h.account::<UserAccount>(&t.user).locked_margin
}

/// `place` with a stop-limit bound.
#[allow(clippy::too_many_arguments)]
fn place_limit(
    h: &mut Harness,
    w: &World,
    t: &Trader,
    kind: OrderKind,
    side: Side,
    size: u64,
    margin: u64,
    trigger: u64,
    limit: u64,
) -> Result<(), ()> {
    h.send(
        &[ixs::place_order_limit(
            &t.kp.pubkey(),
            t,
            w,
            kind,
            side,
            size,
            margin,
            trigger,
            0,
            0,
            0,
            limit,
        )],
        &[&t.kp],
    )
    .map(|_| ())
    .map_err(|_| ())
}

/// The `n`th non-empty order slot.
fn order_at(h: &Harness, t: &Trader, n: usize) -> OrderSlot {
    *h.orders(&t.positions)
        .iter()
        .filter(|o| !o.is_empty())
        .nth(n)
        .expect("order")
}

/// The most recent history record (closes land here, not in a queue).
fn last_record(h: &Harness, t: &Trader) -> HistoryRecord {
    let p = h.positions(&t.positions);
    p.history[(p.history_head as usize + HISTORY_LEN - 1) % HISTORY_LEN]
}

#[test]
fn take_profit_closes_long_at_trigger() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::TakeProfit, 160);

    mark(&mut h, &w, 155);
    tick(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t));

    mark(&mut h, &w, 160);
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    assert!(orders(&h, &t).is_empty());
    let rec = last_record(&h, &t);
    assert_eq!(h.positions(&t.positions).history_len, 1);
    // Indistinguishable from a manual close in the public disclosure.
    assert_eq!(rec.reason, HISTORY_REASON_USER);
    assert_eq!(rec.exit, 160 * P);
    assert!(rec.pnl > 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn stop_loss_closes_and_cancels_the_take_profit() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::TakeProfit, 170);
    exit_tp_sl(&mut h, &w, &t, OrderKind::StopLoss, 145);
    assert_eq!(orders(&h, &t).len(), 2);

    mark(&mut h, &w, 145);
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    assert!(
        orders(&h, &t).is_empty(),
        "the sibling exit must die with the position"
    );
    let rec = last_record(&h, &t);
    assert!(rec.pnl < 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn short_side_directions_are_mirrored() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Short,
            SOL10,
            M150,
            150 * P,
        )],
        &[&t.kp],
    )
    .unwrap();
    // For a short: TP below the mark, SL above it.
    assert!(place(
        &mut h,
        &w,
        &t,
        OrderKind::TakeProfit,
        Side::Short,
        0,
        0,
        160 * P,
        0,
        0,
        0
    )
    .is_err());
    place(
        &mut h,
        &w,
        &t,
        OrderKind::TakeProfit,
        Side::Short,
        0,
        0,
        140 * P,
        0,
        0,
        0,
    )
    .unwrap();
    place(
        &mut h,
        &w,
        &t,
        OrderKind::StopLoss,
        Side::Short,
        0,
        0,
        155 * P,
        0,
        0,
        0,
    )
    .unwrap();
    mark(&mut h, &w, 140);
    tick(&mut h, &w, &t);
    let rec = last_record(&h, &t);
    assert_eq!(rec.exit, 140 * P);
    assert!(rec.pnl > 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn exit_order_on_the_wrong_side_of_mark_is_refused() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    // A long's TP below the mark / SL above it would fire immediately.
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::TakeProfit,
            Side::Long,
            0,
            0,
            140 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::InvalidOrder));
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::StopLoss,
            Side::Long,
            0,
            0,
            160 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::InvalidOrder));
}

#[test]
fn placing_the_same_exit_kind_replaces_it() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::StopLoss, 140);
    exit_tp_sl(&mut h, &w, &t, OrderKind::StopLoss, 145);
    assert_eq!(orders(&h, &t), vec![OrderKind::StopLoss]);
    assert_eq!(order_at(&h, &t, 0).trigger, 145 * P);
}

#[test]
fn trailing_stop_follows_the_high_and_fires_on_reversal() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    // 5% trail.
    place(
        &mut h,
        &w,
        &t,
        OrderKind::TrailingStop,
        Side::Long,
        0,
        0,
        0,
        500,
        0,
        0,
    )
    .unwrap();

    mark(&mut h, &w, 160); // high 160 -> stop 152
    tick(&mut h, &w, &t);
    assert_eq!(order_at(&h, &t, 0).extreme, 160 * P);
    mark(&mut h, &w, 155); // above the stop: holds, extreme stays
    tick(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t));
    assert_eq!(order_at(&h, &t, 0).extreme, 160 * P);

    mark(&mut h, &w, 151); // through 152
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    let rec = last_record(&h, &t);
    assert_eq!(rec.exit, 151 * P);
    assert!(rec.pnl > 0, "locked in profit above the $150 entry");
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn trailing_stop_rejects_bad_distance() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    for bps in [0u16, 9, 5_001] {
        let r = h.send(
            &[ixs::place_order(
                &t.kp.pubkey(),
                &t,
                &w,
                OrderKind::TrailingStop,
                Side::Long,
                0,
                0,
                0,
                bps,
                0,
                0,
            )],
            &[&t.kp],
        );
        assert_custom_error(&r, err(DexxerError::InvalidOrder));
    }
}

#[test]
fn limit_buy_fills_when_mark_drops_to_trigger_with_attached_exits() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        140 * P,
        0,
        150 * P,
        130 * P,
    )
    .unwrap();

    tick(&mut h, &w, &t); // mark 150 > 140: waits
    assert!(!is_open(&h, &w, &t));
    mark(&mut h, &w, 145);
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));

    mark(&mut h, &w, 140);
    tick(&mut h, &w, &t);
    let pos = slot(&h, &w, &t).expect("open");
    assert_eq!(pos.side(), Side::Long);
    assert_eq!(pos.size, SOL10);
    assert_eq!(pos.entry, 140 * P);
    // Entry order consumed; TP and SL attached.
    assert_eq!(
        orders(&h, &t),
        vec![OrderKind::TakeProfit, OrderKind::StopLoss]
    );
    assert_invariant(&h, &w, &[&t]);

    // ...and the attached TP then works like any other.
    mark(&mut h, &w, 150);
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn stop_entry_short_fires_on_breakdown_and_siblings_are_dropped() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Stop,
        Side::Short,
        SOL10,
        M150,
        145 * P,
        0,
        0,
        0,
    )
    .unwrap();
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        120 * P,
        0,
        0,
        0,
    )
    .unwrap();
    assert_eq!(orders(&h, &t).len(), 2);
    mark(&mut h, &w, 145);
    tick(&mut h, &w, &t);
    let pos = slot(&h, &w, &t).expect("open");
    assert_eq!(pos.side(), Side::Short);
    assert!(
        orders(&h, &t).is_empty(),
        "one position per market: the other entry is moot"
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn entry_order_that_cannot_pay_its_fee_is_dropped_and_its_margin_returns() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // The whole deposit as margin: nothing is left for the open fee, which is
    // NOT reserved. 10 SOL at $150 is a ~1.5x position, so the risk checks pass.
    let all = free(&h, &t);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        all,
        150 * P,
        0,
        0,
        0,
    )
    .unwrap();
    assert_eq!(free(&h, &t), 0);
    assert_eq!(reserved(&h, &t), all);
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    assert!(orders(&h, &t).is_empty(), "dropped, not retried");
    assert_eq!(free(&h, &t), all, "the margin came back");
    assert_eq!(reserved(&h, &t), 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn placing_an_entry_order_needs_the_margin_to_be_free() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::Limit,
            Side::Long,
            SOL10,
            free(&h, &t) + 1,
            140 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::InsufficientMargin));
    assert!(orders(&h, &t).is_empty());
    assert_eq!(reserved(&h, &t), 0);
}

#[test]
fn entry_order_requires_an_empty_position_and_exit_order_an_open_one() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::StopLoss,
            Side::Long,
            0,
            0,
            140 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::PositionNotOpen));
    open_long(&mut h, &w, &t);
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::Limit,
            Side::Long,
            SOL10,
            M150,
            140 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::PositionNotEmpty));
}

#[test]
fn entry_validation_rejects_inverted_attached_exits() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // Long entry with TP below the trigger.
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::Limit,
            Side::Long,
            SOL10,
            M150,
            140 * P,
            0,
            130 * P,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::InvalidOrder));
}

#[test]
fn order_book_fills_up() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    for i in 0..ORDER_SLOTS as u64 {
        place(
            &mut h,
            &w,
            &t,
            OrderKind::Limit,
            Side::Long,
            SOL10,
            M10,
            (100 + i) * P,
            0,
            0,
            0,
        )
        .unwrap();
    }
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::Limit,
            Side::Long,
            SOL10,
            M10,
            90 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::OrderBookFull));
}

#[test]
fn cancel_order_clears_the_slot_and_rejects_empty_ones() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        100 * P,
        0,
        0,
        0,
    )
    .unwrap();
    h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert!(orders(&h, &t).is_empty());
    let r = h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]);
    assert_custom_error(&r, err(DexxerError::OrderNotFound));
    let r = h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 9)], &[&t.kp]);
    assert_custom_error(&r, err(DexxerError::OrderNotFound));
}

#[test]
fn stranger_cannot_place_or_cancel() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let s = Keypair::new();
    h.fund(&s.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::place_order(
            &s.pubkey(),
            &t,
            &w,
            OrderKind::Limit,
            Side::Long,
            SOL10,
            M150,
            100 * P,
            0,
            0,
            0,
        )],
        &[&s],
    );
    assert!(r.is_err());
}

#[test]
fn manual_close_clears_exit_orders_but_keeps_pending_entries() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::TakeProfit, 170);
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert!(orders(&h, &t).is_empty());
}

#[test]
fn stale_oracle_leaves_orders_untouched() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::StopLoss, 145);
    mark(&mut h, &w, 140);
    // Feed goes stale: no execution on an untrusted price, and no error.
    w.set_price(&mut h, 140 * P, 5, NOW - 100, 500);
    tick(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t));
    assert_eq!(orders(&h, &t), vec![OrderKind::StopLoss]);
}

#[test]
fn exit_is_refused_while_an_entry_order_holds_margin() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        100 * P,
        0,
        0,
        0,
    )
    .unwrap();
    h.warp(1_000, NOW);
    // Everything that is free goes out; the reservation stays.
    let bal = free(&h, &t);
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, bal)], &[&t.kp])
        .unwrap();
    let exit = |h: &mut Harness| {
        h.send(
            &[ixs::undelegate_user(&t.kp.pubkey(), &t, &w, &[w.market])],
            &[&t.kp],
        )
    };
    assert_custom_error(&exit(&mut h), err(DexxerError::BalanceNotZero));

    // Cancel, take the margin out, and the exit goes through.
    h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    h.warp(2_000, NOW);
    let bal = free(&h, &t);
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, bal)], &[&t.kp])
        .unwrap();
    exit(&mut h).unwrap();
    assert!(
        orders(&h, &t).is_empty(),
        "pending intent must not reach L1"
    );
}

/// One `Positions` account serves every market: an order carries its market,
/// so ticks, cancels and fills never cross markets.
#[test]
fn orders_are_scoped_to_their_market() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let btc = w.add_market(
        &mut h,
        "BTC",
        "1",
        MarketParams {
            min_size: 20_000,
            max_staleness_secs: 15,
            ..MarketParams::sol_perp_defaults()
        },
    );
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    p.min_size = 20_000;
    p.max_staleness_secs = 15;
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
    const B80K: u64 = 80_000_000_000;
    const BTC_01: u64 = 10_000_000; // 0.01 BTC -> $800 notional at $80k
    w.set_price_on(&mut h, &btc, B80K, 5, NOW, 100);
    h.send(
        &[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[])],
        &[&w.crank],
    )
    .unwrap();

    // A SOL position with a TP, and a BTC limit-buy resting below the market.
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::TakeProfit, 170);
    h.send(
        &[ixs::place_order_on(
            &t.kp.pubkey(),
            &t,
            &w,
            &btc,
            OrderKind::Limit,
            Side::Long,
            BTC_01,
            80_000_000,
            78_000_000_000,
            0,
            0,
            0,
        )],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(
        orders(&h, &t),
        vec![OrderKind::TakeProfit, OrderKind::Limit]
    );

    // The BTC order cannot be cancelled through the SOL market, nor the SOL
    // one through BTC.
    let r = h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 1)], &[&t.kp]);
    assert_custom_error(&r, err(DexxerError::OrderNotFound));
    let r = h.send(
        &[ixs::cancel_order_on(&t.kp.pubkey(), &t, &w, &btc, 0)],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::OrderNotFound));

    // A SOL tick that satisfies the SOL TP closes SOL only; the BTC limit stays.
    mark(&mut h, &w, 170);
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    assert_eq!(orders(&h, &t), vec![OrderKind::Limit]);

    // The BTC tick fills the BTC limit when BTC reaches it.
    w.set_price_on(&mut h, &btc, 78_000_000_000, 5, NOW, 101);
    h.send(
        &[ixs::crank_tick_on(&w.crank.pubkey(), &w, &btc, &[])],
        &[&w.crank],
    )
    .unwrap();
    h.send(
        &[ixs::liquidation_check_on(&w.crank.pubkey(), &w, &btc, &t)],
        &[&w.crank],
    )
    .unwrap();
    assert!(h.slot(&t, &btc.market).is_some());
    assert!(orders(&h, &t).is_empty());
    assert_invariant_markets(&h, &w, &[&t], &[w.market, btc.market]);
}

#[test]
fn place_order_with_a_foreign_feed_is_rejected() {
    // `place_order` re-registers the (trader, market) scheduled task, whose
    // account list is frozen at registration. A `feed` that is not
    // `Market.feed` must be refused here exactly as `open_position` refuses
    // it — otherwise the task would be re-registered with a junk feed and
    // every later `liquidation_check` would skip on `read_price`.
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    let mut ix = ixs::place_order(
        &t.kp.pubkey(),
        &t,
        &w,
        OrderKind::TakeProfit,
        Side::Long,
        0,
        0,
        160 * P,
        0,
        0,
        0,
    );
    // `feed` is index 7 of `Trader::trade_accounts` (same as trade.rs's
    // `wrong_feed_account_rejected`).
    ix.accounts[7].pubkey = w.market;
    let r = h.send(&[ix], &[&t.kp]);
    assert_custom_error(&r, err(DexxerError::WrongFeed));
    assert!(orders(&h, &t).is_empty());
}

/// Shrink a trader's `Positions` to the pre-orders footprint (3184 B): an
/// account onboarded before the order tail existed.
fn make_legacy(h: &mut Harness, t: &Trader) {
    let mut acc = h.svm.get_account(&t.positions).expect("positions");
    acc.data.truncate(Positions::SPACE);
    h.svm.set_account(t.positions, acc).unwrap();
}

#[test]
fn legacy_positions_without_order_tail_still_trades_and_refuses_orders() {
    // Blocker 3 of the PR review: the order tail is OPTIONAL. An account
    // created before it must keep trading, ticking and closing; only
    // `place_order`/`cancel_order` refuse it, with a dedicated error, until the
    // owner re-onboards.
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    make_legacy(&mut h, &t);
    assert_eq!(
        h.svm.get_account(&t.positions).unwrap().data.len(),
        Positions::SPACE
    );

    open_long(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t));
    mark(&mut h, &w, 151);
    tick(&mut h, &w, &t); // liquidation_check on a legacy account is a no-op, not an error
    assert!(is_open(&h, &w, &t));

    let r = place(
        &mut h,
        &w,
        &t,
        OrderKind::TakeProfit,
        Side::Long,
        0,
        0,
        160 * P,
        0,
        0,
        0,
    );
    assert!(r.is_err());
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::TakeProfit,
            Side::Long,
            0,
            0,
            160 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::OrdersUnsupported));
    let r = h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]);
    assert_custom_error(&r, err(DexxerError::OrdersUnsupported));

    // The relayer path liquidates/ticks legacy accounts too.
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();

    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert!(!is_open(&h, &w, &t));
    assert_eq!(h.positions(&t.positions).history_len, 1);
    assert_invariant(&h, &w, &[&t]);
}

// ------------------------------------------------------------------ stop-limit

#[test]
fn stop_limit_waits_outside_its_bound_and_fills_when_the_price_comes_back() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // Buy-stop at $155 that must not fill above $158.
    place_limit(
        &mut h,
        &w,
        &t,
        OrderKind::Stop,
        Side::Long,
        SOL10,
        M200,
        155 * P,
        158 * P,
    )
    .unwrap();
    assert_eq!(order_at(&h, &t, 0).limit, 158 * P);

    mark(&mut h, &w, 150); // below the trigger
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));

    mark(&mut h, &w, 165); // gaps through the trigger AND the bound
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t), "a gap beyond the limit must not fill");
    assert_eq!(orders(&h, &t), vec![OrderKind::Stop], "still armed");
    assert_eq!(reserved(&h, &t), M200, "and still holding its margin");

    mark(&mut h, &w, 157); // back inside [trigger, limit]
    tick(&mut h, &w, &t);
    let pos = slot(&h, &w, &t).expect("filled");
    assert_eq!(
        pos.entry,
        157 * P,
        "filled inside the bound, not at the gap"
    );
    assert!(orders(&h, &t).is_empty());
    assert_eq!(reserved(&h, &t), 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn stop_limit_short_is_mirrored() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // Sell-stop at $145 that must not fill below $142.
    place_limit(
        &mut h,
        &w,
        &t,
        OrderKind::Stop,
        Side::Short,
        SOL10,
        M150,
        145 * P,
        142 * P,
    )
    .unwrap();
    mark(&mut h, &w, 138); // gap down past the bound
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    mark(&mut h, &w, 143);
    tick(&mut h, &w, &t);
    assert_eq!(slot(&h, &w, &t).expect("filled").entry, 143 * P);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn stop_limit_validation() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let place_ = |h: &mut Harness, kind, side, trigger: u64, limit: u64| {
        h.send(
            &[ixs::place_order_limit(
                &t.kp.pubkey(),
                &t,
                &w,
                kind,
                side,
                SOL10,
                M10,
                trigger * P,
                0,
                0,
                0,
                limit * P,
            )],
            &[&t.kp],
        )
    };
    // The bound must lie beyond the trigger.
    let r = place_(&mut h, OrderKind::Stop, Side::Long, 155, 154);
    assert_custom_error(&r, err(DexxerError::InvalidOrder));
    let r = place_(&mut h, OrderKind::Stop, Side::Short, 145, 146);
    assert_custom_error(&r, err(DexxerError::InvalidOrder));
    // A limit order is bounded by its own trigger: no extra bound.
    let r = place_(&mut h, OrderKind::Limit, Side::Long, 140, 141);
    assert_custom_error(&r, err(DexxerError::InvalidOrder));
    // limit == trigger is a valid (tightest) bound.
    place_(&mut h, OrderKind::Stop, Side::Long, 155, 155).unwrap();
    // A failed placement reserved nothing.
    assert_eq!(reserved(&h, &t), M10);
}

// ------------------------------------------------------------ margin reservation

#[test]
fn placing_reserves_cancelling_returns() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let before = free(&h, &t);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        140 * P,
        0,
        0,
        0,
    )
    .unwrap();
    assert_eq!(free(&h, &t), before - M150);
    assert_eq!(reserved(&h, &t), M150);
    assert_eq!(
        locked(&h, &t),
        0,
        "reserved is not a position's locked margin"
    );
    assert_invariant(&h, &w, &[&t]);

    // The reserved money cannot be withdrawn.
    h.warp(1_000, NOW);
    let r = h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, before)], &[&t.kp]);
    assert_custom_error(&r, err(DexxerError::InsufficientMargin));
    h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, before - M150)],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(free(&h, &t), 0);

    h.send(&[ixs::cancel_order(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert_eq!(free(&h, &t), M150);
    assert_eq!(reserved(&h, &t), 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn a_fill_turns_the_reservation_into_locked_margin() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let before = free(&h, &t);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        140 * P,
        0,
        0,
        0,
    )
    .unwrap();
    mark(&mut h, &w, 140);
    tick(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t));
    assert_eq!(reserved(&h, &t), 0);
    assert_eq!(locked(&h, &t), M150);
    // Margin plus the open fee left free margin; nothing else did.
    let fee = before - M150 - free(&h, &t);
    assert!(fee > 0 && fee < M150 / 10, "open fee only: {fee}");
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn siblings_give_their_reservations_back_when_one_entry_fills() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let before = free(&h, &t);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Stop,
        Side::Short,
        SOL10,
        M150,
        145 * P,
        0,
        0,
        0,
    )
    .unwrap();
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        120 * P,
        0,
        0,
        0,
    )
    .unwrap();
    assert_eq!(reserved(&h, &t), 2 * M150);
    mark(&mut h, &w, 145);
    tick(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t));
    assert!(orders(&h, &t).is_empty());
    assert_eq!(reserved(&h, &t), 0, "the sibling's margin went back");
    assert_eq!(locked(&h, &t), M150);
    // One margin locked, one fee paid, the rest free.
    assert!(free(&h, &t) > before - M150 - M150 / 10);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn a_dropped_order_returns_its_reservation_and_the_next_one_can_still_fill() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // First (by slot) cannot pay its fee: it takes all the free margin... so
    // use two orders where the first is too large for the risk limits instead.
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        // Far above `max_position`: rejected by the risk checks at fill time.
        10_000 * SOL10,
        M10,
        150 * P,
        0,
        0,
        0,
    )
    .unwrap();
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        150 * P,
        0,
        0,
        0,
    )
    .unwrap();
    tick(&mut h, &w, &t);
    assert!(is_open(&h, &w, &t), "the second order filled");
    assert!(orders(&h, &t).is_empty());
    assert_eq!(reserved(&h, &t), 0, "both reservations settled");
    assert_eq!(locked(&h, &t), M150);
    assert_invariant(&h, &w, &[&t]);
}

// ------------------------------------------------------------------ partial exits

#[allow(clippy::too_many_arguments)]
fn place_exit(
    h: &mut Harness,
    w: &World,
    t: &Trader,
    kind: OrderKind,
    size: u64,
    trigger: u64,
) -> Result<(), ()> {
    place(h, w, t, kind, Side::Long, size, 0, trigger * P, 0, 0, 0)
}

#[test]
fn partial_take_profits_reduce_the_position_in_steps() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t); // 10 SOL
    let sol = SOL10 / 10; // 1 SOL
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 3 * sol, 160).unwrap();
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 2 * sol, 165).unwrap();
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 0, 175).unwrap(); // the rest
    assert_eq!(orders(&h, &t).len(), 3, "several of one kind coexist");

    mark(&mut h, &w, 160);
    tick(&mut h, &w, &t);
    let pos = slot(&h, &w, &t).expect("still open");
    assert_eq!(pos.size, 7 * sol);
    assert_eq!(pos.margin, M150 * 7 / 10, "margin released pro rata");
    let rec = last_record(&h, &t);
    assert_eq!(rec.reason, HISTORY_REASON_DECREASE);
    assert_eq!(rec.size, 3 * sol);
    assert_eq!(rec.exit, 160 * P);
    assert!(rec.pnl > 0);
    assert_eq!(orders(&h, &t).len(), 2, "the filled part is gone");
    assert_invariant(&h, &w, &[&t]);

    mark(&mut h, &w, 165);
    tick(&mut h, &w, &t);
    assert_eq!(slot(&h, &w, &t).expect("open").size, 5 * sol);

    mark(&mut h, &w, 175);
    tick(&mut h, &w, &t);
    assert!(
        !is_open(&h, &w, &t),
        "the whole-position order closed the rest"
    );
    assert!(orders(&h, &t).is_empty());
    assert_eq!(locked(&h, &t), 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn two_partial_exits_triggered_in_one_tick_both_run() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    let sol = SOL10 / 10;
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 2 * sol, 155).unwrap();
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 3 * sol, 158).unwrap();
    mark(&mut h, &w, 160); // gaps through both
    tick(&mut h, &w, &t);
    assert_eq!(slot(&h, &w, &t).expect("open").size, 5 * sol);
    assert!(orders(&h, &t).is_empty());
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn partial_exit_placement_rules() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    let sol = SOL10 / 10;
    let min = h.account::<Market>(&w.market).min_size;
    // As large as the position, or leaving less than min_size: refused.
    let r = place_exit(&mut h, &w, &t, OrderKind::TakeProfit, SOL10, 160);
    assert!(r.is_err());
    let r = place_exit(&mut h, &w, &t, OrderKind::TakeProfit, SOL10 - min + 1, 160);
    assert!(r.is_err());
    // Identical (kind, trigger, size) replaces; a different trigger or size adds.
    place_exit(&mut h, &w, &t, OrderKind::StopLoss, 2 * sol, 140).unwrap();
    place_exit(&mut h, &w, &t, OrderKind::StopLoss, 2 * sol, 140).unwrap();
    assert_eq!(orders(&h, &t).len(), 1);
    place_exit(&mut h, &w, &t, OrderKind::StopLoss, 2 * sol, 135).unwrap();
    place_exit(&mut h, &w, &t, OrderKind::StopLoss, 3 * sol, 140).unwrap();
    assert_eq!(orders(&h, &t).len(), 3);
    // A whole-position order is still one per kind: it replaces the previous one.
    place_exit(&mut h, &w, &t, OrderKind::StopLoss, 0, 130).unwrap();
    place_exit(&mut h, &w, &t, OrderKind::StopLoss, 0, 132).unwrap();
    assert_eq!(orders(&h, &t).len(), 4);
}

#[test]
fn a_partial_exit_that_is_now_the_whole_position_closes_it() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t); // 10 SOL
    let sol = SOL10 / 10;
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 4 * sol, 160).unwrap();
    // The trader shrinks the position by hand below the order's size.
    h.send(
        &[ixs::decrease_position(&t.kp.pubkey(), &t, &w, 7 * sol, 0)],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(slot(&h, &w, &t).expect("open").size, 3 * sol);
    mark(&mut h, &w, 160);
    tick(&mut h, &w, &t);
    assert!(
        !is_open(&h, &w, &t),
        "4 SOL asked of a 3 SOL position: all of it"
    );
    assert!(orders(&h, &t).is_empty());
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn a_partial_stop_loss_and_trailing_stop_work_like_any_other() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    let sol = SOL10 / 10;
    // Trail 5% on 4 SOL only.
    place(
        &mut h,
        &w,
        &t,
        OrderKind::TrailingStop,
        Side::Long,
        4 * sol,
        0,
        0,
        500,
        0,
        0,
    )
    .unwrap();
    mark(&mut h, &w, 160); // high 160 -> stop 152
    tick(&mut h, &w, &t);
    mark(&mut h, &w, 151);
    tick(&mut h, &w, &t);
    assert_eq!(slot(&h, &w, &t).expect("open").size, 6 * sol);
    assert!(orders(&h, &t).is_empty());
    assert_invariant(&h, &w, &[&t]);
}

// ------------------------------------------------------------- crank executes orders

#[test]
fn crank_tick_executes_exit_orders_for_a_candidate() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    exit_tp_sl(&mut h, &w, &t, OrderKind::TakeProfit, 160);
    // No scheduler tick anywhere: the relayer's crank alone moves the mark AND
    // runs the order.
    let slot_no = h.account::<Market>(&w.market).mark_slot + 1;
    w.set_price(&mut h, 160 * P, 5, NOW, slot_no);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert!(!is_open(&h, &w, &t));
    assert!(orders(&h, &t).is_empty());
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn crank_tick_fills_entry_orders_for_a_trader_with_no_position() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        SOL10,
        M150,
        140 * P,
        0,
        0,
        0,
    )
    .unwrap();
    let slot_no = h.account::<Market>(&w.market).mark_slot + 1;
    w.set_price(&mut h, 140 * P, 5, NOW, slot_no);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert!(is_open(&h, &w, &t));
    assert_eq!(reserved(&h, &t), 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn crank_tick_and_the_scheduled_check_do_not_double_execute() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    let sol = SOL10 / 10;
    place_exit(&mut h, &w, &t, OrderKind::TakeProfit, 3 * sol, 160).unwrap();
    let slot_no = h.account::<Market>(&w.market).mark_slot + 1;
    w.set_price(&mut h, 160 * P, 5, NOW, slot_no);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    tick(&mut h, &w, &t); // the same fill, seen by the other path
    assert_eq!(
        slot(&h, &w, &t).expect("open").size,
        7 * sol,
        "reduced once"
    );
    assert_eq!(h.positions(&t.positions).history_len, 1);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn crank_tick_skips_a_candidate_with_nothing_to_do_on_the_market() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // A trader with neither a position nor an order is still a no-op candidate.
    let slot_no = h.account::<Market>(&w.market).mark_slot + 1;
    w.set_price(&mut h, 151 * P, 5, NOW, slot_no);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert!(!is_open(&h, &w, &t));
    assert_invariant(&h, &w, &[&t]);
}

/// CU of `crank_tick` with one candidate, with and without a pending order —
/// the cost of the order check on the relayer path. Run with `-- --nocapture`.
#[test]
fn measure_crank_tick_with_orders() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    open_long(&mut h, &w, &t);
    let mut cu = |h: &mut Harness, price: u64, with: &[&Trader]| -> u64 {
        let slot_no = h.account::<Market>(&w.market).mark_slot + 1;
        w.set_price(h, price * P, 5, NOW, slot_no);
        let meta = h
            .send(&[ixs::crank_tick(&w.crank.pubkey(), &w, with)], &[&w.crank])
            .unwrap();
        meta.compute_units_consumed
    };
    let none = cu(&mut h, 151, &[]);
    let one = cu(&mut h, 152, &[&t]);
    exit_tp_sl(&mut h, &w, &t, OrderKind::TakeProfit, 170);
    exit_tp_sl(&mut h, &w, &t, OrderKind::StopLoss, 140);
    let with_orders = cu(&mut h, 153, &[&t]);
    println!(
        "crank_tick CU: no candidate {none}, 1 candidate (no orders) {one}, \
         1 candidate (TP+SL pending, none triggered) {with_orders}"
    );
    assert!(with_orders < 200_000);
}

// ------------------------------------------------------------- legacy layouts

#[test]
fn an_account_with_the_previous_704_byte_tail_is_treated_as_having_no_tail() {
    // The tail grew 704 -> 768 B (stop-limit): an account allocated for the
    // old tail is shorter than the new `SPACE_WITH_ORDERS`, so the program
    // sees no tail — it keeps trading and refuses new orders, like a
    // pre-orders account, instead of misreading the old 88-byte slots.
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    let mut acc = h.svm.get_account(&t.positions).expect("positions");
    acc.data.truncate(Positions::SPACE + 704);
    h.svm.set_account(t.positions, acc).unwrap();
    open_long(&mut h, &w, &t);
    let r = h.send(
        &[ixs::place_order(
            &t.kp.pubkey(),
            &t,
            &w,
            OrderKind::TakeProfit,
            Side::Long,
            0,
            0,
            160 * P,
            0,
            0,
            0,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, err(DexxerError::OrdersUnsupported));
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert_invariant(&h, &w, &[&t]);
}
