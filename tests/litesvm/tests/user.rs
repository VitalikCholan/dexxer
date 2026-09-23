use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    apk, assert_custom_error, custom_error_code, ixs,
    setup::{Trader, World, SEED_AMOUNT},
    token_ix::*,
    Harness,
};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

#[test]
fn faucet_limits_per_day() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let u = Keypair::new();
    h.fund(&u.pubkey(), 2_000_000_000);
    h.send(&[create_ata(&u.pubkey(), &u.pubkey(), &w.mint)], &[&u])
        .unwrap();
    h.send(&[ixs::faucet_init(&u.pubkey(), &w, 10_000_000_000)], &[&u])
        .unwrap();
    let r = h.send(&[ixs::faucet_mint(&u.pubkey(), &w, 1)], &[&u]);
    assert_custom_error(&r, 6000 + DexxerError::FaucetLimit as u32);
    // bootstrap's own faucet loop already warped the clock well past the
    // epoch; jump forward by more than one day from wherever it left off.
    h.warp(50_000, 10_000_000);
    h.send(&[ixs::faucet_mint(&u.pubkey(), &w, 1)], &[&u])
        .unwrap();
    assert_eq!(
        token_balance(&h.svm, &ata(&u.pubkey(), &w.mint)),
        10_000_000_001
    );
}

#[test]
fn init_user_creates_three_pdas_and_prefunds_permission_rent() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);
    let ua: UserAccount = h.account(&t.user);
    assert_eq!(ua.owner, apk(t.kp.pubkey()));
    assert_eq!(ua.free_margin, 0);
    let p: Position = h.account(&t.position);
    assert_eq!(p.state, PositionState::Empty);
    assert_eq!(p.market, apk(w.market));
    let _dq: DisclosureQueue = h.account(&t.dq);
    let extra = ephemeral_rollups_sdk::ephemeral_accounts::rent(
        ephemeral_rollups_sdk::access_control::structs::EphemeralPermission::size_of(
            PERMISSION_MEMBERS,
        ) as u32,
    );
    let pos_acc = h.svm.get_account(&t.position).unwrap();
    assert_eq!(
        pos_acc.lamports,
        h.svm.minimum_balance_for_rent_exemption(pos_acc.data.len()) + extra
    );
}

#[test]
fn credit_deposit_moves_tokens_and_credits_free_margin() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000); // 1000 dUSDC
    assert_eq!(h.account::<UserAccount>(&t.user).free_margin, 1_000_000_000);
    assert_eq!(
        h.account::<PoolLive>(&w.pool_live).capital_total,
        SEED_AMOUNT + 1_000_000_000
    );
    assert_eq!(
        token_balance(&h.svm, &w.pool_ata),
        SEED_AMOUNT + 1_000_000_000
    );
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::credit_deposit(&stranger.pubkey(), &t, &w, 1)],
        &[&stranger],
    );
    assert!(r.is_err(), "stranger cannot credit someone else's account");
}

#[test]
fn set_session_only_by_owner() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);
    let session = Keypair::new();
    h.send(
        &[ixs::set_session(
            &t.kp.pubkey(),
            &t,
            &session.pubkey(),
            10_000,
            5,
        )],
        &[&t.kp],
    )
    .unwrap();
    let ua: UserAccount = h.account(&t.user);
    assert_eq!(ua.session_key, apk(session.pubkey()));
    assert_eq!(ua.actions_left, 5);
    let r = h.send(
        &[ixs::set_session(
            &session.pubkey(),
            &t,
            &session.pubkey(),
            20_000,
            5,
        )],
        &[&session],
    );
    assert!(r.is_err(), "session key cannot re-issue itself");
}

// ---------------------------------------------------------- week-5 Task 2
// Exit-side rent reclaim and the re-onboarding guard around it.
// Fix round 1 (controller ruling, CRITICAL 1): `close_queue_l1` closed only the
// queue and could strand an owner in a state no instruction could repair.
// `close_exited_user` closes all three PDAs together, so after it plain
// `init_user` is the re-onboarding path again.

/// Clean exit: no trades, so the ring is empty and `undelegate_user` takes all
/// three accounts on its non-debt branch, leaving `exited == true`.
fn exited_trader(h: &mut Harness, w: &World) -> Trader {
    let t = w.new_trader(h, 0);
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, w)], &[&t.kp])
        .unwrap();
    assert!(h.account::<UserAccount>(&t.user).exited);
    t
}

fn lamports(h: &Harness, k: &Pubkey) -> u64 {
    h.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
}

#[test]
fn close_exited_user_returns_rent_of_three_pdas_to_fee_payer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = exited_trader(&mut h, &w);

    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::close_exited_user(&stranger.pubkey(), &t, &w)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let before = lamports(&h, &w.fee_payer.pubkey());
    let rent: u64 = [t.user, t.position, t.dq]
        .iter()
        .map(|k| lamports(&h, k))
        .sum();
    assert!(rent > 0);
    h.send(
        &[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w)],
        &[&w.fee_payer],
    )
    .unwrap();
    for k in [t.user, t.position, t.dq] {
        assert_eq!(lamports(&h, &k), 0, "PDA {k} must be closed");
    }
    assert_eq!(
        lamports(&h, &w.fee_payer.pubkey()),
        before + rent,
        "the rent of all three PDAs lands on fee_payer"
    );

    // The slate is genuinely blank now — plain `init_user` onboards this owner
    // again, which is the whole point of closing all three together.
    h.send(&[ixs::init_user(&t.kp.pubkey(), &w, [0x7c; 32])], &[&t.kp])
        .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert!(!u.exited);
    assert_eq!(u.exit_salt, [0x7c; 32]);
    assert_eq!(h.account::<DisclosureQueue>(&t.dq).len, 0);
}

#[test]
fn close_exited_user_rejects_non_exited() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    // A live trader who never exited: the accounts are all present and valid,
    // so only the `exited` gate stands between them and being closed.
    let t = w.new_trader(&mut h, 0);
    let r = h.send(
        &[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w)],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);
}

#[test]
fn close_exited_user_rejects_pending_queue() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(9_101, 2_000_000);
    w.set_price(&mut h, 150_000_000, 5, 2_000_000, 100);
    let t = w.new_trader(&mut h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            10_000_000_000,
            150_000_000,
            150_000_000,
        )],
        &[&t.kp],
    )
    .unwrap();
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    let free = h.account::<UserAccount>(&t.user).free_margin;
    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, free)], &[&t.kp])
        .unwrap();
    // Partial exit: `exited` is set and the balances are zero, so every account
    // constraint passes — the pending record is the only thing left to stop it.
    h.send(&[ixs::undelegate_user(&t.kp.pubkey(), &t, &w)], &[&t.kp])
        .unwrap();
    assert_eq!(h.account::<DisclosureQueue>(&t.dq).len, 1);
    let r = h.send(
        &[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w)],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::QueueStillPending as u32);
}

// Fix round 1 (controller ruling, IMPORTANT 2): `DelegateUser` takes every PDA
// as an `UncheckedAccount`, so without an explicit read an exited account could
// be pushed straight back into the ER — scrubbed, `exit_salt` zeroed —
// bypassing `init_user_reuse_queue` entirely.
#[test]
fn delegate_user_rejects_exited_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = exited_trader(&mut h, &w);

    let r = h.send(&[ixs::delegate_user(&t.kp.pubkey(), &w)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);

    h.send(
        &[ixs::init_user_reuse_queue(&t.kp.pubkey(), &w, [0x33; 32])],
        &[&t.kp],
    )
    .unwrap();
    // LiteSVM deploys no delegation program, so the CPI below still cannot
    // succeed here — what this asserts is that the guard no longer fires and
    // the call now reaches the delegation CPI.
    let r = h.send(&[ixs::delegate_user(&t.kp.pubkey(), &w)], &[&t.kp]);
    assert_ne!(
        custom_error_code(&r),
        Some(6000 + DexxerError::NotExited as u32),
        "a re-onboarded account must pass the exited guard"
    );
}
