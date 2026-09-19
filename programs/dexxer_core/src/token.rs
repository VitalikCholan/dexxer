use crate::state::POOL_SEED;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

/// Signer seeds for the pool PDA, used in CPI calls where the pool signs as
/// token account authority.
pub fn pool_signer_seeds<'a>(mint: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [POOL_SEED, mint.as_ref(), bump]
}

pub fn transfer_signed_by_owner<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    owner: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: owner.to_account_info(),
            },
        ),
        amount,
    )
}

pub fn transfer_signed_by_pool<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    pool: &AccountInfo<'info>,
    mint: &Pubkey,
    bump: u8,
    amount: u64,
) -> Result<()> {
    let bump = [bump];
    let seeds = pool_signer_seeds(mint, &bump);
    let seeds: &[&[u8]] = &seeds;
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: pool.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}
