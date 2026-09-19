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
    let p: Position = h.account(&t.position);
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
    let p: Position = h.account(&t.position);
    assert_eq!(p.state, PositionState::Open);
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
    let p: Position = h.account(&t.position);
    assert_eq!(p.state, PositionState::Closed);
    assert_eq!(p.closed.unwrap().reason, CloseReason::User);
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
