use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    assert_custom_error, assert_invariant, ixs,
    setup::{World, SEED_AMOUNT},
    token_ix::*,
    Harness,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn withdraw_moves_tokens_and_debits_free_margin() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000); // 1000 dUSDC deposited
    let amount = 400_000_000u64;

    let owner_before = token_balance(&h.svm, &t.ata);
    let vault_before = token_balance(&h.svm, &w.pool_ata);

    h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, amount)], &[&t.kp])
        .unwrap();

    assert_eq!(
        h.account::<UserAccount>(&t.user).free_margin,
        1_000_000_000 - amount
    );
    assert_eq!(
        h.account::<Pool>(&w.pool).capital_total,
        SEED_AMOUNT + 1_000_000_000 - amount
    );
    assert_eq!(token_balance(&h.svm, &w.pool_ata), vault_before - amount);
    assert_eq!(token_balance(&h.svm, &t.ata), owner_before + amount);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn withdraw_more_than_free_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let r = h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000_001)],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::InsufficientMargin as u32);
}

#[test]
fn withdraw_by_session_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let session = Keypair::new();
    h.fund(&session.pubkey(), 1_000_000_000);
    // Give the session key its own ATA so the rejection below is actually
    // about the owner check, not an incidental "ATA doesn't exist" failure.
    h.send(
        &[create_ata(&session.pubkey(), &session.pubkey(), &w.mint)],
        &[&session],
    )
    .unwrap();
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
    // `withdraw` is owner-only (no `assert_trader` session branch): passing
    // the session key as the `owner` signer must be rejected. `user_account`
    // re-derives its PDA from `seeds = [USER_SEED, owner.key().as_ref()]`,
    // so a mismatched `owner` (the session key) makes the account-supplied
    // `t.user` address disagree with that derivation — Anchor's built-in
    // `ConstraintSeeds` (error 2006) fires during account validation, before
    // the instruction body (and its custom `Unauthorized` check) ever runs.
    // Confirmed empirically: this is the exact error the transaction fails
    // with, not `DexxerError::Unauthorized` (6000 + 19 = 6019).
    let r = h.send(&[ixs::withdraw(&session.pubkey(), &t, &w, 1)], &[&session]);
    assert_custom_error(&r, 2006);
}

#[test]
fn withdraw_zero_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let r = h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]);
    // Week-2 Task 5 fix round 2: `amount >= MIN_WITHDRAW` (1 dUSDC) now guards
    // first, before the old `amount > 0` check — 0 fails as "below minimum",
    // surfaced as `InvalidParams`, not the retired `AmountZero`.
    assert_custom_error(&r, 6000 + DexxerError::InvalidParams as u32);
}

#[test]
fn withdraw_below_minimum_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);
    // 500_000 (0.5 dUSDC) is below MIN_WITHDRAW (1_000_000 = 1 dUSDC).
    let r = h.send(&[ixs::withdraw(&t.kp.pubkey(), &t, &w, 500_000)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidParams as u32);
}

#[test]
fn withdraw_cooldown_enforced() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let t = w.new_trader(&mut h, 1_000_000_000);

    // First withdraw: succeeds, sets `last_withdraw_slot`.
    h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000)],
        &[&t.kp],
    )
    .unwrap();

    // Immediate second withdraw (same slot, well within the 300-slot
    // cooldown): rejected.
    let r = h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000)],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::WithdrawCooldown as u32);

    // Warp forward past the cooldown (current slot + 301 is comfortably past
    // last_withdraw_slot + WITHDRAW_COOLDOWN_SLOTS): now succeeds.
    let now_slot = h.svm.get_sysvar::<solana_clock::Clock>().slot;
    h.warp(now_slot + 301, 2_000_000);
    h.send(
        &[ixs::withdraw(&t.kp.pubkey(), &t, &w, 1_000_000)],
        &[&t.kp],
    )
    .unwrap();

    assert_eq!(
        h.account::<UserAccount>(&t.user).free_margin,
        1_000_000_000 - 2_000_000
    );
}
