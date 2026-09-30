use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, assert_invariant, ixs, setup::World, Harness};
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
// Task 7's tests settled on NOW = 2_000_000 as the clock base (bootstrap
// warps the clock past 1_000_000 on its own via the faucet-funding loop);
// mirror that here instead of the brief's literal 1_000_000, keeping every
// relative delta intact.
const NOW: i64 = 2_000_000;

#[test]
fn increase_uses_vwap_entry_and_charges_fee_on_delta() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    // This test's focus is VWAP-entry/fee math on the price delta, not the
    // deviation guard (task 12 finding #1) — no crank tick runs between open
    // and increase here, so raise max_deviation_bps to keep the later 150 ->
    // 160 jump from tripping OracleDeviation on increase_position.
    let mut mp = MarketParams::sol_perp_defaults();
    mp.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, mp)],
        &[&w.admin],
    )
    .unwrap();
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
    w.set_price(&mut h, 160_000_000, 5, NOW, 101);
    h.send(
        &[ixs::increase_position(
            &t.kp.pubkey(),
            &t,
            &w,
            SOL10,
            160_000_000,
            160_000_000,
        )],
        &[&t.kp],
    )
    .unwrap();
    let p = h.slot(&t, &w.market).expect("open slot");
    assert_eq!(p.size, 2 * SOL10);
    assert_eq!(p.entry, 155_000_000);
    assert_eq!(p.margin, M150 + 160_000_000);
    let u: UserAccount = h.account(&t.user);
    assert_eq!(
        u.free_margin,
        1_000_000_000 - M150 - 900_000 - 160_000_000 - 960_000
    ); // fee 6 bps of 1600 $
    assert_eq!(
        h.account::<MarketRisk>(&w.risk).oi_long,
        1_500_000_000 + 1_600_000_000
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn increase_rejects_leverage_breach_on_total() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
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
    let r = h.send(
        &[ixs::increase_position(
            &t.kp.pubkey(),
            &t,
            &w,
            SOL10,
            100_000_000,
            P150,
        )],
        &[&t.kp],
    ); // total 3000 $ on 250 $ = 12x
    assert_custom_error(&r, 6000 + DexxerError::InsufficientMargin as u32);
}

#[test]
fn decrease_partial_releases_pro_rata_margin_and_realises_pnl() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
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
        &[ixs::decrease_position(
            &t.kp.pubkey(),
            &t,
            &w,
            4_000_000_000,
            165_000_000,
        )],
        &[&t.kp],
    )
    .unwrap();
    let p = h.slot(&t, &w.market).expect("open slot");
    assert!(p.is_open());
    assert_eq!(p.size, 6_000_000_000);
    assert_eq!(p.margin, 90_000_000);
    assert_eq!(p.entry, P150);
    // released margin 60 $, pnl 4x15 = 60 $, fee 6 bps of 660 $ = 0.396 $ -> +119.604 $
    assert_eq!(
        h.account::<UserAccount>(&t.user).free_margin,
        1_000_000_000 - M150 - 900_000 + 119_604_000
    );
    assert_eq!(h.account::<MarketRisk>(&w.risk).oi_long, 900_000_000);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn decrease_full_equals_close() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
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
    h.send(
        &[ixs::decrease_position(&t.kp.pubkey(), &t, &w, SOL10, P150)],
        &[&t.kp],
    )
    .unwrap();
    assert!(h.slot(&t, &w.market).is_none());
}

#[test]
fn close_after_increase_keeps_oi_ledger_exact() {
    // Regression for a Task 10 randomized-sequence finding (step 155, seed
    // 0xDEADBEEF): `increase_position` updates `entry` to a VWAP that rounds
    // up, and `finalize_close`/`decrease_position` used to recompute the OI
    // decrement as `notional(size, entry)` off that rounded entry. Because
    // `notional` itself also rounds up, the recompute can exceed the ledger's
    // true remaining balance (double rounding), underflowing `checked_sub`
    // and failing the whole crank tx / close — even though the position and
    // pool are perfectly healthy. `PositionSlot.oi_notional` now tracks the exact
    // contribution in lock-step at open/increase/decrease, so this must
    // always succeed. (`add_size`/`add_price` below are chosen, via offline
    // search, to reproduce a positive recompute-vs-ledger drift.)
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    // This regression's focus is the OI ledger, not the deviation guard (task
    // 12 finding #1) — no crank tick runs between open and increase here, so
    // raise max_deviation_bps to keep the 150 -> 160 jump below from tripping
    // OracleDeviation on increase_position.
    let mut mp = MarketParams::sol_perp_defaults();
    mp.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, mp)],
        &[&w.admin],
    )
    .unwrap();
    let t = w.new_trader(&mut h, 2_000_000_000);
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
    let add_size: u64 = 7_000_000_001;
    let add_price: u64 = 160_000_003;
    w.set_price(&mut h, add_price, 5, NOW, 101);
    h.send(
        &[ixs::increase_position(
            &t.kp.pubkey(),
            &t,
            &w,
            add_size,
            400_000_000,
            u64::MAX,
        )],
        &[&t.kp],
    )
    .unwrap();
    let p = h.slot(&t, &w.market).expect("open slot");
    assert_eq!(p.entry, 154_117_649, "VWAP entry rounds up");
    // Before the fix: notional(p.size, p.entry) = 2_620_000_034 > the ledger's
    // tracked 2_620_000_022 (open_notional 1_500_000_000 + delta_notional
    // 1_120_000_022) — a 12 base-unit shortfall that underflowed `checked_sub`.
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert!(h.slot(&t, &w.market).is_none());
    assert_eq!(h.account::<MarketRisk>(&w.risk).oi_long, 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn second_increase_after_vwap_rounding_is_accepted() {
    // Regression for a Task 10 fix-round-2 finding: `increase_position`'s
    // OI-cap check ("pretend the existing exposure is not there") used to
    // recompute `notional(position.size, position.entry)` off the stored
    // (VWAP, rounds-up) entry and subtract that from a `risk_view` copy of
    // the ledger. After a prior increase has rounded `entry` up, that
    // recompute can exceed the ledger's true remaining contribution — the
    // same double-rounding class as `close_after_increase_keeps_oi_ledger_exact`
    // above — underflowing `checked_sub` and rejecting a second, perfectly
    // legitimate increase with a spurious MathOverflow. `increase_position`
    // now reads `position.oi_notional` (exact by construction) instead, so a
    // second increase after the first has rounded the entry must succeed.
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    // Same rationale as close_after_increase_keeps_oi_ledger_exact above:
    // this test's focus is the OI-cap ledger, not the deviation guard (task
    // 12 finding #1); raise max_deviation_bps so the 150 -> 160 jump below
    // doesn't trip OracleDeviation on increase_position.
    let mut mp = MarketParams::sol_perp_defaults();
    mp.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, mp)],
        &[&w.admin],
    )
    .unwrap();
    let t = w.new_trader(&mut h, 2_000_000_000);
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
    let add_price: u64 = 160_000_003;
    w.set_price(&mut h, add_price, 5, NOW, 101);
    h.send(
        &[ixs::increase_position(
            &t.kp.pubkey(),
            &t,
            &w,
            7_000_000_001,
            400_000_000,
            u64::MAX,
        )],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(
        h.slot(&t, &w.market).expect("open slot").entry,
        154_117_649,
        "VWAP entry rounds up"
    );
    // Second increase at the same price: before the fix, the OI-cap check's
    // recompute (2_620_000_034) exceeded the ledger's tracked contribution
    // (2_620_000_022), underflowing `checked_sub` and rejecting this call.
    h.send(
        &[ixs::increase_position(
            &t.kp.pubkey(),
            &t,
            &w,
            10_000_000,
            200_000,
            u64::MAX,
        )],
        &[&t.kp],
    )
    .unwrap();
    let p = h.slot(&t, &w.market).expect("open slot");
    assert!(p.is_open());
    assert_eq!(
        h.account::<MarketRisk>(&w.risk).oi_long,
        p.oi_notional,
        "OI ledger must equal the sum of open positions' tracked oi_notional"
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn decrease_leaving_dust_or_undermargined_remainder_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
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
    let r = h.send(
        &[ixs::decrease_position(
            &t.kp.pubkey(),
            &t,
            &w,
            SOL10 - 1_000_000,
            P150,
        )],
        &[&t.kp],
    ); // remainder 0.001 SOL < min_size
    assert_custom_error(&r, 6000 + DexxerError::PositionTooSmall as u32);
    let r = h.send(
        &[ixs::decrease_position(
            &t.kp.pubkey(),
            &t,
            &w,
            SOL10 + 1,
            P150,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidInput as u32);
}

/// Final review I3: a partial decrease realises PnL on the closed part, so it
/// leaves a history record (`reason = HISTORY_REASON_DECREASE`) — otherwise
/// that PnL never shows in the owner's History. The later full close adds its
/// own record with `reason = User`.
#[test]
fn a_partial_decrease_writes_a_history_record() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
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
    let opened = h.slot(&t, &w.market).expect("open slot").opened_slot;
    assert_eq!(h.positions(&t.positions).history_len, 0);
    h.warp(107, NOW);
    w.set_price(&mut h, 165_000_000, 5, NOW, 101);
    h.send(
        &[ixs::decrease_position(
            &t.kp.pubkey(),
            &t,
            &w,
            4_000_000_000,
            165_000_000,
        )],
        &[&t.kp],
    )
    .unwrap();
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 1);
    let r = p.history[0];
    assert_eq!(dexxer_litesvm::pk(r.market), w.market);
    assert_eq!(r.size, 4_000_000_000, "the closed part only");
    assert_eq!(r.entry, P150);
    assert_eq!(r.exit, 165_000_000);
    assert_eq!(r.pnl, 60_000_000, "4 SOL x 15 $");
    assert_eq!(r.fees, 396_000, "6 bps of 660 $");
    assert_eq!(r.opened_slot, opened);
    assert_eq!(r.closed_slot, 107);
    assert_eq!(r.side, Side::Long.as_u8());
    assert_eq!(r.reason, HISTORY_REASON_DECREASE);
    let s = h.slot(&t, &w.market).expect("still open");
    assert_eq!(s.size, 6_000_000_000);

    h.warp(108, NOW);
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    let p = h.positions(&t.positions);
    assert_eq!(p.history_len, 2);
    assert_eq!(p.history[1].reason, CloseReason::User.as_u8());
    assert_eq!(p.history[1].size, 6_000_000_000);
    assert_invariant(&h, &w, &[&t]);
}
