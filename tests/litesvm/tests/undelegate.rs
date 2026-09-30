use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    apk, assert_custom_error, ixs,
    setup::{Trader, World},
    Harness,
};
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
const NOW: i64 = 2_000_000;

fn world_with_price(h: &mut Harness) -> World {
    let w = World::bootstrap(h);
    h.warp(9_101, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    w
}

#[test]
fn undelegate_rejected_with_open_position() {
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
    let r = h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::HasOpenPosition as u32);
}

#[test]
fn undelegate_rejected_with_balance() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000); // free_margin = 1000 dUSDC, not withdrawn
    let r = h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::BalanceNotZero as u32);
}

#[test]
fn undelegate_scrubs_after_full_withdraw() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    // Real `withdraw` (not a seeded/synthetic value): sets `last_withdraw_slot`
    // to the current slot, which `undelegate_user` must scrub back to 0.
    h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000_000)],
        &[&t.kp],
    )
    .unwrap();
    assert_ne!(
        h.account::<UserAccount>(&t.user).last_withdraw_slot,
        0,
        "test bug: withdraw should have set a non-zero last_withdraw_slot"
    );
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.session_key, anchor_lang::prelude::Pubkey::default());
    assert_eq!((u.session_expiry, u.actions_left), (0, 0));
    assert_eq!(u.last_withdraw_slot, 0);
    assert_eq!(u.exit_salt, [0u8; 32]);
    assert_eq!(
        u.owner,
        apk(t.kp.pubkey()),
        "owner kept — it is the PDA seed"
    );
}

/// Full close + full withdraw — the owner has traded, closed out and taken
/// everything back. Returns a trader whose balances are zero.
fn trader_after_closed_trade(h: &mut Harness, w: &World) -> Trader {
    let t = w.new_trader(h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    // limit_price 0 accepts any price; the close frees the `Position` to `Empty`.
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, w, 0)], &[&t.kp])
        .unwrap();
    let free = h.account::<UserAccount>(&t.user).free_margin;
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, w, free)], &[&t.kp])
        .unwrap();
    t
}

/// A past trade leaves nothing behind that could hold the exit back: trades
/// are not disclosed any more, so every exit is a full one.
#[test]
fn undelegate_after_closed_trade_is_full_exit() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = trader_after_closed_trade(&mut h, &w);
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert!(u.exited, "the exit must flag the account as exited");
    assert_eq!(u.exit_salt, [0u8; 32]);
    assert_eq!((u.session_expiry, u.actions_left), (0, 0));
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Empty
    );
}

#[test]
fn undelegate_only_by_owner() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000_000)],
        &[&t.kp],
    )
    .unwrap();
    // `owner: Signer` re-derives `user_account`/`position`'s PDAs from
    // `owner.key()`, so passing a signer that isn't the trader's real owner
    // makes the account-supplied addresses disagree with that derivation —
    // Anchor's `ConstraintSeeds` (2006) fires, same shape as
    // `withdraw_by_session_rejected` in tests/litesvm/tests/withdraw.rs.
    let r = h.send(
        &[ixs::undelegate_user(&w.crank.pubkey(), &t, &w)],
        &[&w.crank],
    );
    assert_custom_error(&r, 2006);
}
