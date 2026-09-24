use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::action;
use ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer;

/// Written on L1 by the delegation program as a post-commit action of the
/// 5-min `Pool` commit (spec §2.4.1). `escrow` signer + `source_program` are the
/// two checks that make this action-only (check 7, 19.09.2026): only the
/// delegation program can sign the escrow balance PDA, and it inserts the
/// destination program id as an extra account before the macro-injected
/// escrow pair — `source_program` absorbs that slot so Anchor's positional
/// deserialization stays aligned (see spikes/06-magic-action RESULT.md check 7).
/// Seeded by the 32-byte commitment hash, not `nonce` (week-3 controller
/// ruling 9): `nonce` is `UserAccount.nonce`, a per-user counter, so two
/// traders' first closes both land on nonce 1 and collide on the same PDA.
/// The hash is unique per record and reveals nothing about ordering (unlike
/// a global counter on `Pool`, which would leak close order across users).
#[action]
#[derive(Accounts)]
#[instruction(nonce: u64, hash: [u8; 32])]
pub struct WriteCommitment<'info> {
    #[account(init, payer = escrow, space = 8 + Commitment::INIT_SPACE,
        seeds = [COMMIT_SEED, &hash], bump)]
    pub commitment: Account<'info, Commitment>,
    /// Plain (never delegated) L1 account — readable here to pin `escrow_auth` to `Config.fee_payer`.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
    /// CHECK: program that scheduled the action; absorbs the dispatcher-inserted slot.
    #[account(address = crate::ID @ DexxerError::InvalidActionSigner)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: escrow authority = the fee payer whose action-escrow funds L1 fees.
    #[account(constraint = escrow_auth.key() == config.fee_payer @ DexxerError::InvalidActionSigner)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: Magic escrow PDA; only the delegation program can sign for it.
    #[account(mut, signer @ DexxerError::InvalidActionSigner,
        address = ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ DexxerError::InvalidActionSigner)]
    pub escrow: UncheckedAccount<'info>,
}

pub fn write_commitment(ctx: Context<WriteCommitment>, nonce: u64, hash: [u8; 32]) -> Result<()> {
    let c = &mut ctx.accounts.commitment;
    c.version = 1;
    c.hash = hash;
    c.slot = Clock::get()?.slot;
    c.nonce = nonce;
    c.bump = ctx.bumps.commitment;
    Ok(())
}

/// Both PDAs are seeded by `commitment_hash(&args, &salt)` (ruling 9, same
/// reasoning as `WriteCommitment` above) — recomputed here from the ix args
/// rather than passed as an extra argument, since the L1 action builder
/// (`commit.rs`) already has `(args, salt)` in hand from `due_reveals` and
/// this keeps `write_disclosure`'s signature unchanged from Task 3.
#[action]
#[derive(Accounts)]
#[instruction(args: DisclosureArgs, salt: [u8; 32])]
pub struct WriteDisclosure<'info> {
    #[account(init, payer = escrow, space = 8 + Disclosure::INIT_SPACE,
        seeds = [DISCLOSURE_SEED, &commitment_hash(&args, &salt)], bump)]
    pub disclosure: Account<'info, Disclosure>,
    #[account(seeds = [COMMIT_SEED, &commitment_hash(&args, &salt)], bump = commitment.bump)]
    pub commitment: Account<'info, Commitment>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
    /// CHECK: see WriteCommitment
    #[account(address = crate::ID @ DexxerError::InvalidActionSigner)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: see WriteCommitment
    #[account(constraint = escrow_auth.key() == config.fee_payer @ DexxerError::InvalidActionSigner)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: see WriteCommitment
    #[account(mut, signer @ DexxerError::InvalidActionSigner,
        address = ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ DexxerError::InvalidActionSigner)]
    pub escrow: UncheckedAccount<'info>,
}

pub fn write_disclosure(
    ctx: Context<WriteDisclosure>,
    args: DisclosureArgs,
    salt: [u8; 32],
) -> Result<()> {
    require!(
        commitment_hash(&args, &salt) == ctx.accounts.commitment.hash,
        DexxerError::BadDisclosureHash
    );
    let d = &mut ctx.accounts.disclosure;
    d.version = 1;
    d.owner = Pubkey::default(); // owner is NOT disclosed — spec §2.3: the record is the trade, not the trader
    d.market = args.market;
    d.side = args.side;
    d.size = args.size;
    d.entry = args.entry;
    d.exit = args.exit;
    d.pnl = args.pnl;
    d.fees = args.fees;
    d.reason = args.reason;
    d.opened_slot = args.opened_slot;
    d.closed_slot = args.closed_slot;
    d.nonce = args.nonce;
    d.bump = ctx.bumps.disclosure;
    Ok(())
}

/// Records in the ring whose `write_commitment` has not been scheduled yet ->
/// `(nonce, hash)` for `commit_aggregate` to turn into `write_commitment`
/// post-commit actions, newest-last in ring order, at most `max` of them.
///
/// The `commitment_written` flag is flipped HERE, in the same ER transaction
/// that schedules the action (week-5 Task 1) — which is what retires the
/// crank-asserted `mark_committed` step and with it spec risk #20: the program
/// no longer has to take the crank's word that an L1 `Commitment` exists. A
/// failed/replayed bundle cannot re-emit an action for the same record, and a
/// nonce whose commitment did land hard-fails `write_commitment`'s L1 `init`
/// anyway (week-3 controller ruling 7). What remains is spec risk #26: a
/// dropped bundle leaves the record flagged with no L1 `Commitment` behind it.
pub fn pending_commitments(dq: &mut DisclosureQueue, max: usize) -> Result<Vec<(u64, [u8; 32])>> {
    let mut out = Vec::new();
    for i in 0..dq.len as usize {
        if out.len() >= max {
            break;
        }
        let idx = (dq.head as usize)
            .checked_add(i)
            .ok_or(DexxerError::MathOverflow)?
            % DQ_CAPACITY;
        let rec = &mut dq.records[idx];
        if !rec.commitment_written {
            let args = DisclosureArgs::from(&*rec);
            out.push((rec.nonce, commitment_hash(&args, &rec.salt)));
            rec.commitment_written = true;
        }
    }
    Ok(out)
}

/// Pops up to `max` records that are both already committed (`commitment_written`)
/// and past their reveal slot (`reveal_after_slot <= slot`).
/// Ring order is preserved for the remaining records (compaction is O(len), len <= 8).
/// Records are popped only when they are actually emitted here — never peeked and left —
/// so a `write_disclosure` action for a given nonce is scheduled at most once.
pub fn due_reveals(
    dq: &mut DisclosureQueue,
    slot: u64,
    max: usize,
) -> Result<Vec<(DisclosureArgs, [u8; 32])>> {
    let mut out = Vec::new();
    let mut kept: Vec<ClosedRecord> = Vec::new();
    for i in 0..dq.len as usize {
        let idx = (dq.head as usize + i) % DQ_CAPACITY;
        let rec = dq.records[idx];
        // `commitment_written` first: a disclosure may never reach L1 before
        // the commitment it opens, so a record whose `write_commitment` has
        // not been scheduled yet waits here even if its reveal slot passed
        // (`WriteDisclosure` reads the `Commitment` PDA and would fail).
        if rec.commitment_written && rec.reveal_after_slot <= slot && out.len() < max {
            out.push((DisclosureArgs::from(&rec), rec.salt));
        } else {
            kept.push(rec);
        }
    }
    dq.records = [ClosedRecord::default(); DQ_CAPACITY];
    for (i, r) in kept.iter().enumerate() {
        dq.records[i] = *r;
    }
    dq.head = 0;
    dq.len = u8::try_from(kept.len()).map_err(|_| DexxerError::MathOverflow)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(recs: &[ClosedRecord]) -> DisclosureQueue {
        let mut records = [ClosedRecord::default(); DQ_CAPACITY];
        records[..recs.len()].copy_from_slice(recs);
        DisclosureQueue {
            version: 1,
            owner: Pubkey::default(),
            head: 0,
            len: recs.len() as u8,
            records,
            bump: 255,
        }
    }

    fn record(nonce: u64, reveal_after_slot: u64, commitment_written: bool) -> ClosedRecord {
        ClosedRecord {
            nonce,
            reveal_after_slot,
            commitment_written,
            ..ClosedRecord::default()
        }
    }

    /// The rule `commit_aggregate` leans on: a disclosure may never be scheduled
    /// before the commitment it opens, even when the reveal slot is long past.
    /// Isolated here because in a real bundle `pending_commitments` runs first
    /// and normally flips the flag before `due_reveals` ever sees the record —
    /// the skip is only observable once the action budget runs out.
    #[test]
    fn due_reveals_skips_due_but_uncommitted() {
        let mut dq = queue(&[record(1, 0, false)]);
        let out = due_reveals(&mut dq, 10_000, 8).unwrap();
        assert!(
            out.is_empty(),
            "an uncommitted record must never be revealed"
        );
        assert_eq!(dq.len, 1, "and it must stay in the ring");
        assert_eq!(dq.records[0].nonce, 1);

        dq.records[0].commitment_written = true;
        let out = due_reveals(&mut dq, 10_000, 8).unwrap();
        assert_eq!(out.len(), 1, "once committed, the same record is due");
        assert_eq!(dq.len, 0);
    }

    #[test]
    fn pending_commitments_flags_only_what_it_returns() {
        let mut dq = queue(&[record(1, 0, false), record(2, 0, false), record(3, 0, true)]);
        let out = pending_commitments(&mut dq, 1).unwrap();
        assert_eq!(out.len(), 1, "clamped to `max`");
        assert_eq!(out[0].0, 1, "ring order: oldest unwritten first");
        assert!(
            dq.records[0].commitment_written,
            "the returned record is flagged"
        );
        assert!(
            !dq.records[1].commitment_written,
            "a record left out of the budget keeps its flag for the next bundle"
        );

        let out = pending_commitments(&mut dq, 8).unwrap();
        assert_eq!(out.len(), 1, "already-written records are never re-emitted");
        assert_eq!(out[0].0, 2);
        assert!(pending_commitments(&mut dq, 8).unwrap().is_empty());
    }

    #[test]
    fn push_fills_the_ring_then_rejects() {
        let mut dq = queue(&[]);
        for n in 0..DQ_CAPACITY as u64 {
            dq.push(record(n, 0, false)).unwrap();
        }
        assert_eq!(dq.len as usize, DQ_CAPACITY);
        let err = dq.push(record(99, 0, false)).unwrap_err();
        // `require!` wraps the variant in an `AnchorError` carrying the source
        // location, so compare the error number rather than the rendered string.
        match err {
            anchor_lang::error::Error::AnchorError(e) => assert_eq!(
                e.error_code_number,
                anchor_lang::error::ERROR_CODE_OFFSET + DexxerError::QueueFull as u32
            ),
            other => panic!("expected QueueFull, got {other:?}"),
        }
        assert_eq!(
            dq.len as usize, DQ_CAPACITY,
            "a rejected push changes nothing"
        );
        assert!(
            dq.records.iter().all(|r| r.nonce != 99),
            "the rejected record must not have landed anywhere in the ring"
        );
    }
}
