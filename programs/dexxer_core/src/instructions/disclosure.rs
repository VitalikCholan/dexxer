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

#[derive(Accounts)]
pub struct MarkCommitted<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = crank.key() == config.crank @ DexxerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [DQ_SEED, position.owner.as_ref()], bump = dq.bump)]
    pub dq: Box<Account<'info, DisclosureQueue>>,
}

/// Crank observed the `Commitment` PDA on base (the ER cannot read L1 — spec
/// risk #2) and now retires the closed record into the disclosure ring,
/// returning the position to `Empty` so the trader can open again. Crank-
/// asserted by design (spec risk #20); the L1 `Commitment` is public, so a
/// crank that lies here is visible to anyone after the fact.
///
/// Order matters (controller ruling 7, week 3): validate -> push into the
/// queue -> only then reset the position. `commitment_written` must never be
/// cleared before the record is safely queued, since a failure between those
/// two steps would otherwise let a later `commit_aggregate` re-emit
/// `write_commitment` for a nonce that already has an L1 record.
pub fn mark_committed(ctx: Context<MarkCommitted>) -> Result<()> {
    let pos = &mut ctx.accounts.position;
    require!(pos.state == PositionState::Closed, DexxerError::NotClosed);
    let rec = pos.closed.ok_or(DexxerError::NotClosed)?;
    require!(rec.commitment_written, DexxerError::CommitmentNotWritten);

    let dq = &mut ctx.accounts.dq;
    require!((dq.len as usize) < DQ_CAPACITY, DexxerError::QueueFull);
    let idx = (dq.head as usize)
        .checked_add(dq.len as usize)
        .ok_or(DexxerError::MathOverflow)?
        % DQ_CAPACITY;
    dq.records[idx] = rec;
    dq.len = dq.len.checked_add(1).ok_or(DexxerError::MathOverflow)?;

    pos.closed = None;
    pos.state = PositionState::Empty;
    pos.side = Side::Long;
    pos.size = 0;
    pos.entry = 0;
    pos.margin = 0;
    pos.liq_price = 0;
    pos.opened_slot = 0;
    pos.liq_ticks = 0;
    pos.oi_notional = 0;
    Ok(())
}

/// A closed position whose commitment has not been emitted yet -> (nonce, hash).
/// Used by `commit_aggregate` to decide whether a `Position` in `remaining_accounts`
/// needs a `write_commitment` post-commit action this bundle.
pub fn pending_commitment(pos: &Position) -> Option<(u64, [u8; 32])> {
    if pos.state != PositionState::Open && pos.state != PositionState::Empty {
        if let Some(rec) = pos.closed.as_ref() {
            if !rec.commitment_written {
                let args = DisclosureArgs::from(rec);
                return Some((rec.nonce, commitment_hash(&args, &rec.salt)));
            }
        }
    }
    None
}

/// Pops up to `max` records whose reveal slot has passed (`reveal_after_slot <= slot`).
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
        if rec.reveal_after_slot <= slot && out.len() < max {
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
