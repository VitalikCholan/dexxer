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
fn init_user_creates_pdas_and_prefunds_permission_rent() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);
    let ua: UserAccount = h.account(&t.user);
    assert_eq!(ua.owner, apk(t.kp.pubkey()));
    assert_eq!(ua.free_margin, 0);
    let p = h.positions(&t.positions);
    assert_eq!(p.open_count(), 0);
    assert_eq!(p.owner, apk(t.kp.pubkey()));
    assert!(h.slot(&t, &w.market).is_none());
    let extra = ephemeral_rollups_sdk::ephemeral_accounts::rent(
        ephemeral_rollups_sdk::access_control::structs::EphemeralPermission::size_of(
            PERMISSION_MEMBERS,
        ) as u32,
    );
    let pos_acc = h.svm.get_account(&t.positions).unwrap();
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
// `close_exited_user` closes both PDAs together, so after it plain `init_user`
// is the re-onboarding path.

/// Clean exit: no trades, `undelegate_user` leaves `exited == true`.
fn exited_trader(h: &mut Harness, w: &World) -> Trader {
    let t = w.new_trader(h, 0);
    h.send(
        &[ixs::undelegate_user(&t.kp.pubkey(), &t, w, &[w.market])],
        &[&t.kp],
    )
    .unwrap();
    assert!(h.account::<UserAccount>(&t.user).exited);
    t
}

fn lamports(h: &Harness, k: &Pubkey) -> u64 {
    h.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
}

#[test]
fn close_exited_user_returns_rent_of_both_pdas_to_payer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = exited_trader(&mut h, &w);

    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::close_exited_user(
            &stranger.pubkey(),
            &t,
            &w,
            &t.kp.pubkey(),
        )],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);

    let o = t.kp.pubkey();
    let before = lamports(&h, &o);
    let rent: u64 = [t.user, t.positions].iter().map(|k| lamports(&h, k)).sum();
    assert!(rent > 0);
    h.send(
        &[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w, &o)],
        &[&w.fee_payer],
    )
    .unwrap();
    for k in [t.user, t.positions] {
        assert_eq!(lamports(&h, &k), 0, "PDA {k} must be closed");
    }
    assert_eq!(
        lamports(&h, &o),
        before + rent,
        "the rent of both PDAs lands on the recorded payer (here the owner)"
    );

    // The slate is genuinely blank now — plain `init_user` onboards this owner
    // again, which is the whole point of closing both together.
    h.send(&[ixs::init_user(&t.kp.pubkey(), &w, [0x7c; 32])], &[&t.kp])
        .unwrap();
    let u: UserAccount = h.account(&t.user);
    assert!(!u.exited);
    assert_eq!(u.exit_salt, [0x7c; 32]);
}

#[test]
fn close_exited_user_returns_rent_to_whoever_paid_it() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = exited_trader(&mut h, &w); // harness onboards with `payer = owner`
    let o = t.kp.pubkey();
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.rent_payer, apk(o), "init_user recorded its payer");
    assert_eq!(u.owner, apk(o), "the scrub keeps owner");
    let rent = lamports(&h, &t.user) + lamports(&h, &t.positions);
    let owner_before = lamports(&h, &o);
    // The relayer's fee_payer closes; the lamports go to the recorded payer.
    h.send(
        &[ixs::close_exited_user(&w.fee_payer.pubkey(), &t, &w, &o)],
        &[&w.fee_payer],
    )
    .unwrap();
    assert_eq!(lamports(&h, &o), owner_before + rent);
    assert_eq!(lamports(&h, &t.user), 0);
}

#[test]
fn close_exited_user_sponsored_rent_goes_to_fee_payer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let kp = Keypair::new();
    let o = kp.pubkey();
    h.fund(&o, 1_000_000_000);
    // Sponsored onboarding: `fee_payer` fronts the rent, the owner only signs.
    h.send(
        &[ixs::init_user_paid(
            &o,
            &w.fee_payer.pubkey(),
            &w,
            [0x11; 32],
        )],
        &[&kp, &w.fee_payer],
    )
    .unwrap();
    let t = Trader {
        user: dexxer_litesvm::pdas::user(&o),
        positions: dexxer_litesvm::pdas::positions(&o),
        ata: Pubkey::default(),
        kp,
    };
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.rent_payer, apk(w.fee_payer.pubkey()));
    h.send(&[ixs::undelegate_user(&o, &t, &w, &[w.market])], &[&t.kp])
        .unwrap();
    // The scrub must not have zeroed the recorded payer.
    let u: UserAccount = h.account(&t.user);
    assert!(u.exited);
    assert_eq!(u.rent_payer, apk(w.fee_payer.pubkey()));
    let rent = lamports(&h, &t.user) + lamports(&h, &t.positions);
    let fp_before = lamports(&h, &w.fee_payer.pubkey());
    let owner_before = lamports(&h, &o);
    // The owner closes on their own; the rent still goes back to the sponsor.
    h.send(
        &[ixs::close_exited_user(&o, &t, &w, &w.fee_payer.pubkey())],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(lamports(&h, &w.fee_payer.pubkey()), fp_before + rent);
    assert_eq!(lamports(&h, &o), owner_before);
}

#[test]
fn close_exited_user_guards_signer_and_destination() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = exited_trader(&mut h, &w);
    let o = t.kp.pubkey();
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::close_exited_user(&stranger.pubkey(), &t, &w, &o)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    // Right signer, wrong destination.
    let r = h.send(
        &[ixs::close_exited_user(
            &w.fee_payer.pubkey(),
            &t,
            &w,
            &stranger.pubkey(),
        )],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    // The owner may close their own accounts.
    h.send(&[ixs::close_exited_user(&o, &t, &w, &o)], &[&t.kp])
        .unwrap();
}

#[test]
fn close_exited_user_rejects_non_exited() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    // A live trader who never exited: the accounts are all present and valid,
    // so only the `exited` gate stands between them and being closed.
    let t = w.new_trader(&mut h, 0);
    let r = h.send(
        &[ixs::close_exited_user(
            &w.fee_payer.pubkey(),
            &t,
            &w,
            &t.kp.pubkey(),
        )],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);
}

// Fix round 1 (controller ruling, IMPORTANT 2): `DelegateUser` takes every PDA
// as an `UncheckedAccount`, so without an explicit read an exited account could
// be pushed straight back into the ER — scrubbed, `exit_salt` zeroed. The
// legitimate way back is `close_exited_user` followed by a fresh `init_user`.
#[test]
fn delegate_user_rejects_exited_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = exited_trader(&mut h, &w);

    let r = h.send(
        &[ixs::delegate_user(&t.kp.pubkey(), &t.kp.pubkey(), &w)],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::NotExited as u32);

    h.send(
        &[ixs::close_exited_user(
            &w.fee_payer.pubkey(),
            &t,
            &w,
            &t.kp.pubkey(),
        )],
        &[&w.fee_payer],
    )
    .unwrap();
    h.send(&[ixs::init_user(&t.kp.pubkey(), &w, [0x33; 32])], &[&t.kp])
        .unwrap();
    // LiteSVM deploys no delegation program, so the CPI below still cannot
    // succeed here — what this asserts is that the guard no longer fires and
    // the call now reaches the delegation CPI.
    let r = h.send(
        &[ixs::delegate_user(&t.kp.pubkey(), &t.kp.pubkey(), &w)],
        &[&t.kp],
    );
    assert_ne!(
        custom_error_code(&r),
        Some(6000 + DexxerError::NotExited as u32),
        "a re-onboarded account must pass the exited guard"
    );
}

// Week-5 Task 3 (P1): `DelegateUser` gained a `payer: Signer` distinct from
// `owner`, so the delegation records can be funded by the relayer's
// sponsor key while the owner keeps signing for its own PDAs. LiteSVM deploys
// no delegation program, so the CPI itself can never succeed here — what is
// assertable is the half that runs BEFORE it: `payer` really is a separate,
// required signer, and a call carrying one still reaches the delegation CPI
// instead of failing account validation. Whether the lamports actually come
// out of `payer` is a devnet measurement (Task 4), not a LiteSVM one.
#[test]
fn delegate_user_with_separate_payer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 0);
    let payer = Keypair::new();
    h.fund(&payer.pubkey(), 5_000_000_000);

    let ix = ixs::delegate_user(&t.kp.pubkey(), &payer.pubkey(), &w);
    assert_eq!(ix.accounts[0].pubkey, t.kp.pubkey(), "owner stays first");
    let payer_meta = &ix.accounts[1];
    assert_eq!(payer_meta.pubkey, payer.pubkey(), "payer follows owner");
    assert!(
        payer_meta.is_signer && payer_meta.is_writable,
        "payer must be a writable signer"
    );

    // (1) `payer` unsigned: Anchor's `Signer` check is what fires (3010,
    // AccountNotSigner) — proof the new field is genuinely a required signer
    // and not just along for the ride.
    let mut unsigned = ix.clone();
    unsigned.accounts[1].is_signer = false;
    let r = h.send(&[unsigned], &[&t.kp]);
    assert_eq!(
        custom_error_code(&r),
        Some(3010),
        "payer must be rejected when it does not sign"
    );

    // (2) both sign: every constraint passes and the call reaches the
    // delegation CPI, which cannot succeed without a delegation program.
    let owner_before = h.svm.get_account(&t.kp.pubkey()).unwrap().lamports;
    let r = h.send(&[ix], &[&t.kp, &payer]);
    assert!(r.is_err(), "no delegation program is deployed on LiteSVM");
    assert_eq!(
        custom_error_code(&r),
        None,
        "the failure must be the missing delegation program, not a constraint"
    );
    assert_eq!(
        h.svm.get_account(&t.kp.pubkey()).unwrap().lamports,
        owner_before,
        "a failed delegation charges the owner nothing"
    );
}
