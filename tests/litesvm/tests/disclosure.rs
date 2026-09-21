use anchor_lang::AccountSerialize;
use dexxer_core::state::*;
use dexxer_litesvm::{apk, ixs, pk, setup::World, Harness};
use solana_account::Account;
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
fn seed_commitment(h: &mut Harness, nonce: u64, hash: [u8; 32]) {
    let (pda, bump) = Pubkey::find_program_address(&[COMMIT_SEED, &nonce.to_le_bytes()], &prog());
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
    seed_commitment(&mut h, args.nonce, [7u8; 32]);
    let r = h.send(
        &[ixs::write_disclosure_direct(
            &stranger.pubkey(),
            &w,
            args,
            [1u8; 32],
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
