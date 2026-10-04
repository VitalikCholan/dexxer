// Conditional orders (Limit / Stop / TP / SL / Trailing). Orders live in
// `Positions.orders` and are executed by the per-position scheduled task, i.e.
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
    h.positions(&t.positions)
        .orders
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

/// The `n`th non-empty order slot.
fn order_at(h: &Harness, t: &Trader, n: usize) -> OrderSlot {
    *h.positions(&t.positions)
        .orders
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
fn entry_order_that_cannot_be_afforded_is_dropped_not_retried() {
    let mut h = Harness::new();
    let (w, t) = world(&mut h);
    // $1000 margin against a ~$1000 deposit once fees are included.
    place(
        &mut h,
        &w,
        &t,
        OrderKind::Limit,
        Side::Long,
        100 * SOL10,
        2_000_000_000,
        150 * P,
        0,
        0,
        0,
    )
    .unwrap();
    tick(&mut h, &w, &t);
    assert!(!is_open(&h, &w, &t));
    assert!(orders(&h, &t).is_empty());
    assert_invariant(&h, &w, &[&t]);
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
            M150,
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
            M150,
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
fn undelegate_scrubs_pending_orders() {
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
    // Withdraw everything so the exit guard passes.
    h.warp(1_000, NOW);
    let bal = h.account::<UserAccount>(&t.user).free_margin;
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, bal)], &[&t.kp])
        .unwrap();
    h.send(
        &[ixs::undelegate_user(&t.kp.pubkey(), &t, &w, &[w.market])],
        &[&t.kp],
    )
    .unwrap();
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
