use anchor_lang::{AccountSerialize, Space};
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{
    apk, assert_custom_error, assert_invariant, ixs, pdas, pk,
    setup::{Trader, World},
    Harness,
};
use solana_account::Account;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

fn prog() -> Pubkey {
    pk(dexxer_core::ID)
}

/// Writes a real, correctly-discriminated `Commitment` account directly into the
/// ledger — standing in for the one a genuine `write_commitment` action call would
/// have produced (LiteSVM has no delegation program to drive that CPI). This lets
/// `write_disclosure_direct_call_rejected` exercise the same escrow-signer /
/// `source_program` gate as `write_commitment_direct_call_rejected`, instead of
/// failing earlier on a merely-missing `commitment` account.
/// `hash` both derives the `Commitment` PDA (ruling 9, week 3 — hash-seeded,
/// not nonce-seeded) and is stored as the account's own `hash` field, matching
/// what a real `write_commitment` produces.
fn seed_commitment(h: &mut Harness, nonce: u64, hash: [u8; 32]) {
    let (pda, bump) = Pubkey::find_program_address(&[COMMIT_SEED, &hash], &prog());
    let commitment = Commitment {
        version: 1,
        hash,
        slot: 100,
        nonce,
        bump,
    };
    let mut data = Vec::new();
    commitment.try_serialize(&mut data).unwrap();
    h.svm
        .set_account(
            pda,
            Account {
                lamports: 10_000_000,
                data,
                owner: prog(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

// Direct calls to the `#[action]` handlers must be impossible: `escrow` has to be
// a signer at the delegation program's balance PDA, which no wallet can produce.
// Both tests assert the specific rejection (a `PrivilegeEscalation` instruction
// error from the `system_program::create_account` CPI that funds the `init`'d
// account with `payer = escrow`) rather than any failure — a plain wallet can
// sign as `escrow_auth` for itself, but never as the derived `escrow` PDA.
#[test]
fn write_commitment_direct_call_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::write_commitment_direct(
            &stranger.pubkey(),
            &w,
            1,
            [9u8; 32],
        )],
        &[&stranger],
    );
    assert!(
        r.is_err(),
        "direct write_commitment must fail (escrow not a signer)"
    );
    let e = format!("{:?}", r.err().unwrap().err);
    assert!(
        e.contains("PrivilegeEscalation"),
        "expected the escrow-payer CPI to fail on privilege escalation, got: {e}"
    );
}

#[test]
fn write_disclosure_direct_call_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let args = DisclosureArgs {
        market: apk(w.market),
        side: Side::Long,
        size: 1,
        entry: 1,
        exit: 1,
        pnl: 0,
        fees: 0,
        reason: CloseReason::User,
        opened_slot: 1,
        closed_slot: 2,
        nonce: 1,
        reveal_after_slot: 3,
    };
    // A real `Commitment` must already exist for `write_disclosure` to reach the
    // escrow-signer check at all (its own account is read-only, seeds-checked).
    // The `Commitment` is now hash-seeded (ruling 9), so it must be seeded at
    // the exact hash `write_disclosure_direct` will derive from (args, salt).
    let salt = [1u8; 32];
    let hash = commitment_hash(&args, &salt);
    seed_commitment(&mut h, args.nonce, hash);
    let r = h.send(
        &[ixs::write_disclosure_direct(
            &stranger.pubkey(),
            &w,
            args,
            salt,
        )],
        &[&stranger],
    );
    assert!(
        r.is_err(),
        "direct write_disclosure must fail (escrow not a signer)"
    );
    let e = format!("{:?}", r.err().unwrap().err);
    assert!(
        e.contains("PrivilegeEscalation"),
        "expected the escrow-payer CPI to fail on privilege escalation, got: {e}"
    );
}

// Fix round 1: the two tests above prove a plain wallet is rejected, but only via
// the `init` CPI's own lamport-transfer signer requirement — an incidental
// side effect of the target account being unfunded, not the program's own
// `signer @ InvalidActionSigner` constraint on `escrow`. Anchor's `init`
// degrades to `allocate`+`assign` (signed by the target PDA's own seeds, never
// touching `escrow`) once the target already holds rent-exempt lamports —
// anyone can produce that by airdropping to a public PDA address. These two
// tests pre-fund the target and additionally use the *real* `Config.fee_payer`
// as `escrow_auth` (public, no signature needed), so every other constraint
// passes and only `escrow`'s own signer/address check remains — proving that
// check itself, not the CPI side effect, is what blocks a plain wallet.
#[test]
fn write_commitment_prefunded_target_still_blocked_by_escrow_signer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let nonce = 2u64;
    let hash = [9u8; 32];
    let target = pdas::commitment(&hash);
    let rent = h
        .svm
        .minimum_balance_for_rent_exemption(8 + Commitment::INIT_SPACE);
    h.svm.airdrop(&target, rent).unwrap();
    // World::bootstrap's init_config sets fee_payer = admin.pubkey().
    let fee_payer = w.admin.pubkey();
    let r = h.send(
        &[ixs::write_commitment_direct_with_escrow_auth(
            &fee_payer, &w, nonce, hash,
        )],
        &[],
    );
    assert!(
        r.is_err(),
        "prefunded direct write_commitment must still fail (escrow signer/address check)"
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidActionSigner as u32);
}

#[test]
fn write_disclosure_prefunded_target_still_blocked_by_escrow_signer() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let nonce = 2u64;
    let args = DisclosureArgs {
        market: apk(w.market),
        side: Side::Long,
        size: 1,
        entry: 1,
        exit: 1,
        pnl: 0,
        fees: 0,
        reason: CloseReason::User,
        opened_slot: 1,
        closed_slot: 2,
        nonce,
        reveal_after_slot: 3,
    };
    let salt = [1u8; 32];
    let hash = commitment_hash(&args, &salt);
    seed_commitment(&mut h, nonce, hash);
    let target = pdas::disclosure(&hash);
    let rent = h
        .svm
        .minimum_balance_for_rent_exemption(8 + Disclosure::INIT_SPACE);
    h.svm.airdrop(&target, rent).unwrap();
    let fee_payer = w.admin.pubkey();
    let r = h.send(
        &[ixs::write_disclosure_direct_with_escrow_auth(
            &fee_payer, &w, args, salt,
        )],
        &[],
    );
    assert!(
        r.is_err(),
        "prefunded direct write_disclosure must still fail (escrow signer/address check)"
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidActionSigner as u32);
}

// Task 3: `commit_aggregate` reads `remaining_accounts` for post-commit actions.
// LiteSVM has no delegation program, so the Magic CPI itself is skipped (same
// executable-gated pattern as `commit_aggregate`'s own doc comment) — these
// tests assert the ER-side effects the loop performs unconditionally, before
// that CPI: `commitment_written` flips, the loop ignores non-`Closed`
// positions, and it rejects a program-owned account that is neither a
// `Position` nor a `DisclosureQueue`.
const P100: u64 = 100_000_000;
const SOL1: u64 = 1_000_000_000;
const M20: u64 = 20_000_000;
const NOW: i64 = 2_000_000;

fn world_with_price(h: &mut Harness) -> World {
    let w = World::bootstrap(h);
    h.warp(9_101, NOW);
    w.set_price(h, P100, 5, NOW, 100);
    w
}

fn open_then_close(h: &mut Harness, w: &World) -> Trader {
    let t = w.new_trader(h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            w,
            Side::Long,
            SOL1,
            M20,
            P100,
        )],
        &[&t.kp],
    )
    .unwrap();
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, w, 0)], &[&t.kp])
        .unwrap();
    t
}

// Week-5 Task 1 retired the `Position` candidate kind: a close no longer parks
// its record on the position, so a `Position` handed to `commit_aggregate` is a
// stale caller and is rejected outright rather than silently doing nothing.
#[test]
fn commit_aggregate_rejects_position_candidate() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = open_then_close(&mut h, &w);
    let extra = vec![AccountMeta::new(t.position, false)];
    let r = h.send(
        &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
    assert!(
        !h.account::<DisclosureQueue>(&t.dq).records[0].commitment_written,
        "the rejected bundle scheduled nothing"
    );
}

#[test]
fn commit_aggregate_rejects_foreign_remaining_account() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    // Program-owned but neither `Position` nor `DisclosureQueue`.
    let extra = vec![AccountMeta::new(w.market, false)];
    let r = h.send(
        &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)],
        &[&w.fee_payer],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
}

// Week-5 Task 1: the close path is queue-first. `finalize_close` pushes the
// `ClosedRecord` straight into the owner's `DisclosureQueue` and resets the
// `Position` to `Empty` in the same instruction, so there is no `Closed`
// holding state, no `pending_commitment` on the position, and no
// `mark_committed` bridge any more. `commit_aggregate` sources BOTH
// `write_commitment` (records still unwritten) and `write_disclosure`
// (records due) from that queue, commitment first.

#[test]
fn close_moves_record_to_queue_and_frees_position() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = open_then_close(&mut h, &w);
    let p: Position = h.account(&t.position);
    assert_eq!(
        p.state,
        PositionState::Empty,
        "close frees the position now"
    );
    assert!(
        p.closed.is_none(),
        "the record lives in the queue, not the position"
    );
    assert_eq!(
        (
            p.size,
            p.entry,
            p.margin,
            p.liq_price,
            p.oi_notional,
            p.liq_ticks,
            p.opened_slot
        ),
        (0, 0, 0, 0, 0, 0, 0),
        "every trade field is reset, nothing left behind for the next open"
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(dq.len, 1);
    assert_eq!(dq.head, 0);
    assert_eq!(
        dq.records[0].nonce,
        h.account::<UserAccount>(&t.user).nonce,
        "the queued record carries the close's nonce"
    );
    assert!(
        !dq.records[0].commitment_written,
        "queued uncommitted — commit_aggregate is what flips this"
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn reopen_immediately_after_close_keeps_invariant() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = open_then_close(&mut h, &w);
    // Same slot as the close: no crank tick, no commit_aggregate, no crank
    // round-trip of any kind between the two trades.
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Short,
            SOL1,
            M20,
            P100,
        )],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Open
    );
    assert_eq!(
        h.account::<DisclosureQueue>(&t.dq).len,
        1,
        "the previous close is still queued, awaiting its commitment"
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn close_with_full_queue_fails_atomically() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t = w.new_trader(&mut h, 10_000_000_000);
    let open = |h: &mut Harness, w: &World| {
        h.send(
            &[ixs::open_position(
                &t.kp.pubkey(),
                &t,
                w,
                Side::Long,
                SOL1,
                M20,
                P100,
            )],
            &[&t.kp],
        )
        .unwrap();
    };
    // Fill the ring: DQ_CAPACITY closes with nothing draining it (the default
    // disclosure delay keeps every record un-due, and no commit_aggregate runs).
    for _ in 0..DQ_CAPACITY {
        open(&mut h, &w);
        h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
            .unwrap();
    }
    assert_eq!(
        h.account::<DisclosureQueue>(&t.dq).len as usize,
        DQ_CAPACITY
    );
    open(&mut h, &w);
    let r = h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp]);
    assert_custom_error(&r, 6000 + DexxerError::QueueFull as u32);
    // Atomic: the whole close reverted, so the position is still Open with its
    // margin locked and the queue is untouched.
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Open,
        "a rejected close must leave the position open, not half-settled"
    );
    assert_eq!(
        h.account::<DisclosureQueue>(&t.dq).len as usize,
        DQ_CAPACITY
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn commit_aggregate_emits_commitment_and_disclosure_in_one_bundle_at_delay_zero() {
    let mut h = Harness::new();
    // disclosure_delay_slots == 0: the record is due the slot it is queued.
    let w = World::bootstrap_with_delay(&mut h, 0);
    h.warp(9_101, NOW);
    w.set_price(&mut h, P100, 5, NOW, 100);
    let t = open_then_close(&mut h, &w);
    let extra = vec![AccountMeta::new(t.dq, false)];
    let meta = h
        .send(
            &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)],
            &[&w.fee_payer],
        )
        .unwrap();
    // LiteSVM has no Magic program, so the bundle CPI is skipped and the
    // CallHandlers never log their own `Instruction: Write*` lines — the
    // program's own `actions=N` log is what the built bundle is asserted on.
    assert!(
        meta.logs.iter().any(|l| l.contains("actions=2")),
        "expected write_commitment + write_disclosure in one bundle, logs: {:?}",
        meta.logs
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(
        dq.len, 0,
        "a due record is committed and revealed in the same bundle, then popped"
    );
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn due_reveals_skips_uncommitted() {
    let mut h = Harness::new();
    // Default delay (100 slots): the freshly queued record is not due yet, so
    // only its `write_commitment` is scheduled this bundle.
    let w = world_with_price(&mut h);
    let t = open_then_close(&mut h, &w);
    let extra = vec![AccountMeta::new(t.dq, false)];
    let meta = h
        .send(
            &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)],
            &[&w.fee_payer],
        )
        .unwrap();
    assert!(
        meta.logs.iter().any(|l| l.contains("actions=1")),
        "expected exactly one action (the commitment), logs: {:?}",
        meta.logs
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(dq.len, 1, "the record stays queued until its reveal slot");
    assert!(
        dq.records[0].commitment_written,
        "the flag flips in the same ER tx that schedules the action"
    );
    assert_invariant(&h, &w, &[&t]);
}

// Task 8b (ruling 9): `nonce` is `UserAccount.nonce`, a per-user counter — two
// different traders' first close both land on nonce 1. Before this task,
// `Commitment`/`Disclosure` were seeded by nonce alone, so the second trader's
// `write_commitment` would collide with (and fail to `init` over) the first's.
// Seeding by `commitment_hash(&args, &salt)` instead makes the PDA unique per
// record regardless of the colliding nonce.
#[test]
fn commitments_from_two_traders_do_not_collide() {
    let mut h = Harness::new();
    let w = world_with_price(&mut h);
    let t1 = open_then_close(&mut h, &w);
    let t2 = open_then_close(&mut h, &w);

    let rec1 = h.account::<DisclosureQueue>(&t1.dq).records[0];
    let rec2 = h.account::<DisclosureQueue>(&t2.dq).records[0];
    assert_eq!(
        rec1.nonce, 1,
        "test bug: expected each trader's first close"
    );
    assert_eq!(
        rec2.nonce, 1,
        "test bug: expected each trader's first close"
    );

    let hash1 = commitment_hash(&DisclosureArgs::from(&rec1), &rec1.salt);
    let hash2 = commitment_hash(&DisclosureArgs::from(&rec2), &rec2.salt);
    assert_ne!(
        hash1, hash2,
        "distinct closes (different owner/entry/exit/slot) must hash differently"
    );
    let commitment1 = pdas::commitment(&hash1);
    let commitment2 = pdas::commitment(&hash2);
    assert_ne!(
        commitment1, commitment2,
        "same-nonce Commitment PDAs must not collide across traders"
    );

    // Both queues commit in the same bundle; both actions target distinct PDAs
    // and both records flip commitment_written — no `init`-over-existing failure.
    let extra = vec![
        AccountMeta::new(t1.dq, false),
        AccountMeta::new(t2.dq, false),
    ];
    h.send(
        &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra)],
        &[&w.fee_payer],
    )
    .unwrap();
    assert!(h.account::<DisclosureQueue>(&t1.dq).records[0].commitment_written);
    assert!(h.account::<DisclosureQueue>(&t2.dq).records[0].commitment_written);
    assert_invariant(&h, &w, &[&t1, &t2]);
}
