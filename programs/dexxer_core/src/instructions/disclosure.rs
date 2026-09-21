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
#[action]
#[derive(Accounts)]
#[instruction(nonce: u64, hash: [u8; 32])]
pub struct WriteCommitment<'info> {
    #[account(init, payer = escrow, space = 8 + Commitment::INIT_SPACE,
        seeds = [COMMIT_SEED, &nonce.to_le_bytes()], bump)]
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

#[action]
#[derive(Accounts)]
#[instruction(args: DisclosureArgs, salt: [u8; 32])]
pub struct WriteDisclosure<'info> {
    #[account(init, payer = escrow, space = 8 + Disclosure::INIT_SPACE,
        seeds = [DISCLOSURE_SEED, &args.nonce.to_le_bytes()], bump)]
    pub disclosure: Account<'info, Disclosure>,
    #[account(seeds = [COMMIT_SEED, &args.nonce.to_le_bytes()], bump = commitment.bump)]
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
