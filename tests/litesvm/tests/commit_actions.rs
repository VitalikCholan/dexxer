use anchor_lang::AccountSerialize;
use dexxer_core::state::*;
use dexxer_litesvm::{apk, assert_invariant, ixs, setup::World, Harness};
use solana_account::Account;
use solana_instruction::AccountMeta;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

fn prog() -> Pubkey {
    dexxer_litesvm::pk(dexxer_core::ID)
}

/// A `ClosedRecord` with distinguishing `nonce`/`reveal_after_slot`, everything
/// else fixed and irrelevant to `due_reveals`/`commit_aggregate`'s `DisclosureQueue`
/// path (neither reads `market`/`side`/`size`/... — only `reveal_after_slot` for
/// due-ness and `nonce` for the emitted `write_disclosure`/PDA derivation).
fn record(nonce: u64, reveal_after_slot: u64, commitment_written: bool) -> ClosedRecord {
    ClosedRecord {
        market: apk(Pubkey::new_unique()),
        side: Side::Long,
        size: 1,
        entry: 1,
        exit: 1,
        pnl: 0,
        fees: 0,
        reason: CloseReason::User,
        opened_slot: 1,
        closed_slot: 2,
        salt: [0u8; 32],
        nonce,
        reveal_after_slot,
        commitment_written,
    }
}

/// Writes a real, correctly-discriminated `DisclosureQueue` account directly into
/// the ledger, so a ring can be put in any state (mixed `commitment_written`
/// flags, more records than one close could produce) without replaying trades.
/// `commit_aggregate`'s remaining_accounts loop only re-derives
/// the PDA from `dq.owner` and checks equality (never reads `dq.bump`), so any
/// `owner` works as long as the account address matches `[DQ_SEED, owner]`.
/// Mirrors `tests/disclosure.rs`'s `seed_commitment` helper for the same reason.
fn seed_dq(h: &mut Harness, owner: Pubkey, records: &[ClosedRecord]) -> Pubkey {
    assert!(
        records.len() <= DQ_CAPACITY,
        "test bug: seed exceeds DQ_CAPACITY"
    );
    let (pda, bump) = Pubkey::find_program_address(&[DQ_SEED, owner.as_ref()], &prog());
    let mut arr = [ClosedRecord::default(); DQ_CAPACITY];
    arr[..records.len()].copy_from_slice(records);
    let dq = DisclosureQueue {
        version: 1,
        owner: apk(owner),
        head: 0,
        len: records.len() as u8,
        records: arr,
        bump,
    };
    let mut data = Vec::new();
    dq.try_serialize(&mut data).unwrap();
    let rent = h.svm.minimum_balance_for_rent_exemption(data.len());
    h.svm
        .set_account(
            pda,
            Account {
                lamports: rent,
                data,
                owner: prog(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    pda
}

// (a) A due record (`reveal_after_slot <= slot`) is popped and the tx succeeds;
// a not-due record seeded alongside it survives, unchanged, shifted to index 0 —
// this is the "remaining records are unchanged" half of the brief's case (a).
#[test]
fn due_record_popped_not_due_record_preserved() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let owner = Pubkey::new_unique();
    // Already committed: this case is about the reveal half of the bundle only.
    let due = record(1, 0, true);
    let not_due = record(2, 1_000_000_000, true);
    let dq_pda = seed_dq(&mut h, owner, &[due, not_due]);
    let extra = vec![AccountMeta::new(dq_pda, false)];
    h.send(
        &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra, 8)],
        &[&w.fee_payer],
    )
    .unwrap();
    let dq: DisclosureQueue = h.account(&dq_pda);
    assert_eq!(dq.len, 1, "the due record must be popped");
    assert_eq!(dq.head, 0);
    assert_eq!(
        dq.records[0].nonce, not_due.nonce,
        "the not-due record must be the one left behind"
    );
    assert_eq!(dq.records[0].reveal_after_slot, not_due.reveal_after_slot);
}

// (b) A not-yet-due record survives `commit_aggregate` completely untouched:
// same length, same head, identical bytes.
#[test]
fn not_due_record_survives_untouched() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let owner = Pubkey::new_unique();
    let not_due = record(3, 1_000_000_000, true);
    let dq_pda = seed_dq(&mut h, owner, &[not_due]);
    let extra = vec![AccountMeta::new(dq_pda, false)];
    h.send(
        &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra, 8)],
        &[&w.fee_payer],
    )
    .unwrap();
    let dq: DisclosureQueue = h.account(&dq_pda);
    assert_eq!(dq.len, 1, "not-due record must survive");
    assert_eq!(dq.head, 0);
    assert_eq!(dq.records[0].nonce, not_due.nonce);
    assert_eq!(dq.records[0].reveal_after_slot, not_due.reveal_after_slot);
    assert_eq!(dq.records[0].salt, not_due.salt);
}

// (c) The action budget is shared: commitments are scheduled first, reveals get
// what is left. Five due-but-uncommitted records produce 5 `write_commitment`
// actions and then only 3 `write_disclosure` ones (`MAX_ACTIONS_PER_COMMIT` is
// 8), so two records stay in the ring — flagged as committed, waiting for the
// next bundle to reveal them. Ring order decides who waits: the two past the
// budget, not an arbitrary pair.
#[test]
fn commitments_and_reveals_share_the_action_budget() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let owner = Pubkey::new_unique();
    let recs: Vec<ClosedRecord> = (100u64..105).map(|n| record(n, 0, false)).collect();
    let dq_pda = seed_dq(&mut h, owner, &recs);
    let extra = vec![AccountMeta::new(dq_pda, false)];
    let meta = h
        .send(
            &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra, 8)],
            &[&w.fee_payer],
        )
        .unwrap();
    assert!(
        meta.logs
            .iter()
            .any(|l| l.contains(&format!("actions={MAX_ACTIONS_PER_COMMIT}"))),
        "the bundle must be filled to the cap, logs: {:?}",
        meta.logs
    );
    let dq: DisclosureQueue = h.account(&dq_pda);
    let revealed = MAX_ACTIONS_PER_COMMIT - recs.len();
    assert_eq!(
        dq.len as usize,
        recs.len() - revealed,
        "only the reveals the budget allowed are popped"
    );
    assert_eq!(dq.head, 0);
    assert_eq!(
        dq.records[0].nonce,
        100 + revealed as u64,
        "the record beyond the budget, in ring order, is the one left behind"
    );
    assert!(
        dq.records[..dq.len as usize]
            .iter()
            .all(|r| r.commitment_written),
        "every record got its commitment, even the ones left un-revealed"
    );
}

// (d) A record whose commitment was already scheduled: a second
// `commit_aggregate` over the same queue is a no-op — `pending_commitments`
// skips a record whose `commitment_written` is set, so no action is emitted and
// (critically) the tx does not error.
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
fn second_commit_on_an_already_written_record_is_a_noop() {
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
    h.send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    let extra = vec![AccountMeta::new(t.dq, false)];
    let meta = h
        .send(
            &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra, 8)],
            &[&w.fee_payer],
        )
        .unwrap();
    assert!(meta.logs.iter().any(|l| l.contains("actions=1")));
    let r1 = h.account::<DisclosureQueue>(&t.dq).records[0];
    assert!(r1.commitment_written);

    let meta = h
        .send(
            &[ixs::commit_aggregate(&w.fee_payer.pubkey(), &w, &extra, 8)],
            &[&w.fee_payer],
        )
        .unwrap();
    assert!(
        meta.logs.iter().any(|l| l.contains("actions=0")),
        "nothing is re-emitted, logs: {:?}",
        meta.logs
    );
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(dq.len, 1, "the record is still waiting for its reveal slot");
    assert_eq!(dq.records[0].nonce, r1.nonce);
    assert!(dq.records[0].commitment_written, "flag stays true");
    assert_invariant(&h, &w, &[&t]);
}

/// Helper for the budget test below: send one `commit_aggregate` over `dq_pda`
/// with the given `max_actions` and return the `actions=N` the program logged.
fn commit_with_budget(h: &mut Harness, w: &World, dq_pda: Pubkey, max_actions: u8) -> usize {
    let extra = vec![AccountMeta::new(dq_pda, false)];
    let meta = h
        .send(
            &[ixs::commit_aggregate(
                &w.fee_payer.pubkey(),
                w,
                &extra,
                max_actions,
            )],
            &[&w.fee_payer],
        )
        .unwrap();
    let line = meta
        .logs
        .iter()
        .find_map(|l| l.split("actions=").nth(1).map(str::to_string))
        .unwrap_or_else(|| panic!("no actions= log, logs: {:?}", meta.logs));
    line.trim().parse().unwrap()
}

// Week-5 final review C1 (RED first): before `commit_aggregate` took a
// `max_actions` argument, `room` came straight off `MAX_ACTIONS_PER_COMMIT`, so
// a SINGLE queue with a full ring always emitted up to 8 actions no matter what
// the client asked for. 8 real actions is a measured bridge `0xA0000002` FAIL
// (week 5, Task 7) and 4 is a measured PASS — which made a full ring
// permanently undrainable, and with it a position neither closable
// (`QueueFull`) nor liquidatable. The client-chosen budget is what unsticks it.
//
// One queue, 5 uncommitted records, all due at delay 0 = 10 potential actions.
// `max_actions = 4` must yield exactly 4 — and because commitments are
// scheduled BEFORE reveals (`WriteDisclosure` reads the `Commitment` the
// matching `WriteCommitment` creates), all 4 go to commitments and nothing is
// popped this bundle. A second call then drains: 1 remaining commitment + 3
// reveals.
#[test]
fn single_queue_never_exceeds_requested_budget() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let owner = Pubkey::new_unique();
    let recs: Vec<ClosedRecord> = (200u64..205).map(|n| record(n, 0, false)).collect();
    let dq_pda = seed_dq(&mut h, owner, &recs);

    assert_eq!(
        commit_with_budget(&mut h, &w, dq_pda, 4),
        4,
        "one queue must respect the REQUESTED budget, not MAX_ACTIONS_PER_COMMIT"
    );
    let dq: DisclosureQueue = h.account(&dq_pda);
    assert_eq!(
        dq.records[..dq.len as usize]
            .iter()
            .filter(|r| r.commitment_written)
            .count(),
        4,
        "commitments first: the whole budget went to commitments"
    );
    assert_eq!(dq.len as usize, 5, "no reveal fit in this bundle");

    // Second call at the same budget drains: the 5th commitment plus 3 reveals.
    assert_eq!(commit_with_budget(&mut h, &w, dq_pda, 4), 4);
    let dq: DisclosureQueue = h.account(&dq_pda);
    assert_eq!(dq.len, 2, "a second bundle really drains the ring");

    // Third call finishes it — the ring is no longer permanently stuck.
    assert_eq!(commit_with_budget(&mut h, &w, dq_pda, 4), 2);
    assert_eq!(h.account::<DisclosureQueue>(&dq_pda).len, 0);
}

// The clamp itself: `0` means "one action", not "no actions" (a caller that
// wants a bare Pool+BalancesRoot commit passes no remaining_accounts at all),
// and anything above the program's hard ceiling is capped at
// `MAX_ACTIONS_PER_COMMIT` rather than accepted.
#[test]
fn max_actions_is_clamped_to_one_and_to_the_program_cap() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let recs: Vec<ClosedRecord> = (300u64..305).map(|n| record(n, 0, false)).collect();

    let low = seed_dq(&mut h, Pubkey::new_unique(), &recs);
    assert_eq!(
        commit_with_budget(&mut h, &w, low, 0),
        1,
        "0 clamps UP to 1"
    );

    let high = seed_dq(&mut h, Pubkey::new_unique(), &recs);
    assert_eq!(
        commit_with_budget(&mut h, &w, high, 200),
        MAX_ACTIONS_PER_COMMIT,
        "an over-large request is capped at the program ceiling"
    );
}
