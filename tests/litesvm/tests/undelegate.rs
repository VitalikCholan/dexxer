use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{apk, assert_custom_error, ixs, setup::World, Harness};
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
    h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000_000)],
        &[&t.kp],
    )
    .unwrap();
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.session_key, anchor_lang::prelude::Pubkey::default());
    assert_eq!((u.session_expiry, u.actions_left, u.nonce), (0, 0, 0));
    assert_eq!(u.exit_salt, [0u8; 32]);
    assert_eq!(
        u.owner,
        apk(t.kp.pubkey()),
        "owner kept — it is the PDA seed"
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!((dq.head, dq.len), (0, 0));
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
    // `owner: Signer` re-derives `user_account`/`position`/`dq`'s PDAs from
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
