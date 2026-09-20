use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID},
    ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder},
};

// spec §8 Q2 / week-2 controller ruling task-4 #5: batch-commit the public
// aggregate (`Pool`) on a fixed interval, never per-event (CLAUDE.md
// commit-cadence rule) — driven by `crank_tick`'s scheduled task, not a
// trading instruction. Signer is `Config.fee_payer`, not `owner`/`admin`, so
// the scheduler can call this unattended; `Config.fee_payer` is intended to
// be a delegated ER fee payer so the fee-vault path in
// fees-and-commit-economics.md applies (see task-4 report). Same
// executable-gated commit pattern as `withdraw` (instructions/user.rs): on
// LiteSVM no Magic program is deployed at `MAGIC_PROGRAM_ID`, so the account
// is absent/non-executable and the CPI is skipped rather than failing.
#[derive(Accounts)]
pub struct CommitAggregate<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = payer.key() == config.fee_payer @ DexxerError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to Config.magic_fee_vault
    /// (set by `init_config`/a future `set_fee_vault` admin ix; required on the fee-vault
    /// commit path when the payer is a delegated ER account — see fees-and-commit-economics.md)
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the commit CPI via `.executable` in `commit_aggregate`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
pub fn commit_aggregate(ctx: Context<CommitAggregate>) -> Result<()> {
    let clock = Clock::get()?;
    // Set before the commit CPI so the committed bytes carry this slot.
    ctx.accounts.pool.last_commit_slot = clock.slot;
    // Only in a real ER does a Magic program actually live at this address;
    // on LiteSVM (and any environment without the ER runtime) it is absent,
    // so skip the commit CPI rather than fail.
    if ctx.accounts.magic_program.to_account_info().executable {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.pool.to_account_info()])
        .build_and_invoke()?;
    }
    Ok(())
}

// Same template as `commit_aggregate`, for `Market` after `set_params`.
// Admin-gated rather than fee-payer-gated: `Market` carries no per-user
// fields (spec §8 Q2), so there is no privacy reason to route it through the
// scheduled fee-payer path, and admin already signs `set_params` itself.
#[derive(Accounts)]
pub struct CommitMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the commit CPI via `.executable` in `commit_market`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
pub fn commit_market(ctx: Context<CommitMarket>) -> Result<()> {
    if ctx.accounts.magic_program.to_account_info().executable {
        MagicIntentBundleBuilder::new(
            ctx.accounts.admin.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.market.to_account_info()])
        .build_and_invoke()?;
    }
    Ok(())
}
