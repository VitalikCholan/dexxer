use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    apk, assert_custom_error, ixs,
    setup::{World, SEED_AMOUNT},
    token_ix::*,
    Harness,
};
use solana_keypair::Keypair;
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

// Week-5 Task 2: once an orphaned `DisclosureQueue` has been committed back to
// L1 by `close_orphan_queue`, its rent is reclaimed here by the protocol's
// `fee_payer` — the account is dead weight from then on, and the protocol,
// not the departed user, is the one that can still sign for it.
#[test]
fn close_queue_l1_returns_rent_to_fee_payer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);

    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::close_queue_l1(&stranger.pubkey(), &t.dq)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let before = h.svm.get_account(&w.fee_payer.pubkey()).unwrap().lamports;
    let rent = h.svm.get_account(&t.dq).unwrap().lamports;
    assert!(rent > 0);
    h.send(
        &[ixs::close_queue_l1(&w.fee_payer.pubkey(), &t.dq)],
        &[&w.fee_payer],
    )
    .unwrap();
    assert_eq!(
        h.svm.get_account(&t.dq).map(|a| a.lamports).unwrap_or(0),
        0,
        "queue account closed"
    );
    assert_eq!(
        h.svm.get_account(&w.fee_payer.pubkey()).unwrap().lamports,
        before + rent,
        "rent lands on fee_payer"
    );
}
