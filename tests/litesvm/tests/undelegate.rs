use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    apk, assert_custom_error, ixs,
    setup::{Trader, World},
    Harness,
};
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
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
    assert_eq!((u.session_expiry, u.actions_left, u.nonce), (0, 0, 0));
    assert_eq!(u.last_withdraw_slot, 0);
    assert_eq!(u.exit_salt, [0u8; 32]);
    assert_eq!(
        u.owner,
        apk(t.kp.pubkey()),
        "owner kept — it is the PDA seed"
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!((dq.head, dq.len), (0, 0));
}

// Week-5 Task 2: exit with disclosure debt. Until this task a record left in
// the ring by a close was a hard block on the exit (`QueueNotEmpty`) — the
// user could not leave until the reveal cycle ran (production: 30 days). Now
// the exit carries the debt: `UserAccount`/`Position` leave, the queue stays
// behind in the ER, delegated and crank-only, and the crank closes it after
// the last reveal.

/// Full close + full withdraw, leaving one pending record in the ring — the
/// shared preamble of every exit-with-debt test below. Returns a trader whose
/// `dq.len == 1` and whose balances are zero.
fn trader_with_queue_debt(h: &mut Harness, w: &World) -> Trader {
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
    // limit_price 0 accepts any price. Since week-5 Task 1 the close frees the
    // `Position` straight to `Empty` and pushes the record into the ring.
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, w, 0)], &[&t.kp])
        .unwrap();
    assert_eq!(h.account::<DisclosureQueue>(&t.dq).len, 1);
    let free = h.account::<UserAccount>(&t.user).free_margin;
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, w, free)], &[&t.kp])
        .unwrap();
    t
}

#[test]
fn undelegate_with_pending_disclosures_keeps_queue() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = trader_with_queue_debt(&mut h, &w);
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert!(u.exited, "the partial exit must flag the account as exited");
    // The `UserAccount` is scrubbed on both branches — only the queue differs.
    assert_eq!(u.exit_salt, [0u8; 32]);
    assert_eq!((u.session_expiry, u.actions_left, u.nonce), (0, 0, 0));
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Empty
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(dq.len, 1, "the queue keeps the debt it still owes L1");
    assert_ne!(
        dq.records[dq.head as usize].size, 0,
        "the pending record itself must survive the exit unscrubbed"
    );
}

#[test]
fn close_orphan_queue_requires_empty_queue_and_exited_user() {
    let mut h = Harness::new();
    // delay 0: a single `commit_aggregate` both commits and reveals the record
    // in one bundle, which is what drains the orphaned ring.
    let w = World::bootstrap_with_delay(&mut h, 0);
    h.warp(9_101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = trader_with_queue_debt(&mut h, &w);
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();

    // (1) the queue still owes L1 a commitment and a disclosure.
    let r = h.send(
        &[ixs::close_orphan_queue(&w.crank.pubkey(), &t, &w)],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::QueueStillPending as u32);

    // (2) one reveal cycle drains it.
    h.send(
        &[ixs::commit_aggregate(
            &w.fee_payer.pubkey(),
            &w,
            &[AccountMeta::new(t.dq, false)],
        )],
        &[&w.fee_payer],
    )
    .unwrap();
    assert_eq!(h.account::<DisclosureQueue>(&t.dq).len, 0);

    // (3) ...but the owner has not actually left this ledger yet.
    let r = h.send(
        &[ixs::close_orphan_queue(&w.crank.pubkey(), &t, &w)],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);

    // (4) LiteSVM deploys no Magic program, so `undelegate_user`'s
    // `commit_and_undelegate` CPI was skipped and the `UserAccount` is still
    // sitting here. In a real ER that account vanishes from the validator's
    // clone the moment the undelegation lands — that absence IS the orphan
    // signal `close_orphan_queue` reads. Reproduce it by hand (LiteSVM lets a
    // test write account state directly, the same lever `World::set_price`
    // pulls for the oracle feed).
    h.blank_account(&t.user);
    h.send(
        &[ixs::close_orphan_queue(&w.crank.pubkey(), &t, &w)],
        &[&w.crank],
    )
    .unwrap();
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(
        (dq.head, dq.len),
        (0, 0),
        "the orphan close scrubs the ring before handing it back to L1"
    );
    assert_eq!(dq.records[0].nonce, 0, "records wiped");
    assert_eq!(
        dq.owner,
        apk(t.kp.pubkey()),
        "owner kept — it is the PDA seed"
    );
}

#[test]
fn close_orphan_queue_rejects_stranger() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    // The crank check runs before the queue/exit checks, so a fresh trader's
    // (empty, still-present) accounts are enough to pin the authorization.
    let r = h.send(
        &[ixs::close_orphan_queue(&stranger.pubkey(), &t, &w)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
}

#[test]
fn init_user_reuse_queue_reactivates() {
    let mut h = Harness::new();
    // delay 0 so one `commit_aggregate` drains the ring: fix round 1 (minor 6)
    // — the reuse path is for the owner who comes back AFTER the reveal cycle
    // has settled the debt but BEFORE the crank reclaimed the queue, so the
    // queue is empty by then. A queue that still owed L1 a reveal would be
    // crank-only and, on a real ER, still delegated.
    let w = World::bootstrap_with_delay(&mut h, 0);
    h.warp(9_101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = trader_with_queue_debt(&mut h, &w);
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    h.send(
        &[ixs::commit_aggregate(
            &w.fee_payer.pubkey(),
            &w,
            &[AccountMeta::new(t.dq, false)],
        )],
        &[&w.fee_payer],
    )
    .unwrap();
    assert_eq!(h.account::<DisclosureQueue>(&t.dq).len, 0);

    // Undelegation hands the three PDAs back to this program scrubbed — it
    // does not close them — so plain `init_user` cannot re-onboard: its
    // `init`s hit accounts that already exist. (`close_exited_user` is what
    // makes `init_user` viable again, see tests/user.rs.)
    let r = h.send(&[ixs::init_user(&t.kp.pubkey(), &w, [0x11; 32])], &[&t.kp]);
    assert!(
        r.is_err(),
        "init_user must not be able to re-create existing PDAs"
    );

    h.send(
        &[ixs::init_user_reuse_queue(&t.kp.pubkey(), &w, [0x11; 32])],
        &[&t.kp],
    )
    .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert!(!u.exited, "re-onboarding clears the exit flag");
    assert_eq!(u.version, 2);
    assert_eq!(u.exit_salt, [0x11; 32]);
    assert_eq!((u.free_margin, u.locked_margin), (0, 0));
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Empty
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(dq.len, 0, "the reused queue carries no outstanding debt");
    assert_eq!(dq.owner, apk(t.kp.pubkey()), "the queue itself is reused");
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
