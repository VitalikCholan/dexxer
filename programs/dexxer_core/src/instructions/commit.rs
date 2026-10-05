use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID},
    ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder},
};

// spec §8 Q2 / week-2 controller ruling task-4 #5: batch-commit the public
// aggregate (`Pool`) on a fixed interval, never per-event (CLAUDE.md
// commit-cadence rule) — driven by `crank_tick`'s scheduled task, not a
// trading instruction. `payer` (`Config.fee_payer`) authorizes/signs the
// outer transaction so the scheduler can call this unattended — but week-2
// Task 5 fix round 1 (controller ruling) found that a top-level `Signer`
// structurally can never satisfy the fee-vault path's "payer must be
// delegated, signs via seeds" requirement (confirmed on real devnet:
// `commit_aggregate` hard-failed at commit #11 with `0xA0000000`, the
// no-vault-path limit, even with `.magic_fee_vault(...)` wired — see
// weeks0-5-history.md#week-2 §Task 5 "03-commit-cycle"). The CPI's actual intent payer
// is now `fee_escrow` (state/fee_escrow.rs), a dedicated delegated PDA that
// signs via `invoke_signed` — mirroring the private-counter spike's M3b fix
// (`commit_with_vault` switched its CPI payer from a plain wallet to the
// delegated `counter` PDA for the same reason). `payer`/`fee_escrow` are
// deliberately independent (per fees-and-commit-economics.md: "the payer...
// and the committed accounts... are independent") — `payer` still gates who
// may call this instruction; `fee_escrow` is what the validator actually
// debits on the fee-vault path. Same executable-gated commit pattern as
// `withdraw` (instructions/user.rs): on LiteSVM no Magic program is deployed
// at `MAGIC_PROGRAM_ID`, so the account is absent/non-executable and the CPI
// is skipped rather than failing.
#[derive(Accounts)]
pub struct CommitAggregate<'info> {
    // Boxed (as `trade.rs` does for its larger accounts): `Config` is the
    // biggest account read here, and keeping it on the heap keeps the
    // function's stack frame well under the SBF 4096-byte limit.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(constraint = payer.key() == config.fee_payer @ DexxerError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    // week-4 Task 1: the private live counters this call snapshots into `pool`
    // above (step-rounded). Read-only — `snapshot_into` only reads `self`.
    // NEVER included in `.commit(&[...])` below: `PoolLive` must stay off L1.
    #[account(seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump,
        constraint = pool_live.mint == pool.mint @ DexxerError::PoolLiveMismatch)]
    pub pool_live: Account<'info, PoolLive>,
    // `zero_copy` (controller ruling 5) — AccountLoader, not Account/Box.
    #[account(mut, seeds = [BALANCES_ROOT_SEED], bump = balances_root.load()?.bump)]
    pub balances_root: AccountLoader<'info, BalancesRoot>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
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

/// Commits the public `Pool` snapshot and `BalancesRoot` — nothing else. Trades
/// are not disclosed any more (spec §2.9), so the bundle carries no post-commit
/// actions and the instruction takes no `remaining_accounts`.
pub fn commit_aggregate(ctx: Context<CommitAggregate>) -> Result<()> {
    let clock = Clock::get()?;
    // Step-rounded snapshot (week-4 Task 1), set before the commit CPI so the
    // committed bytes carry it: assets down, liabilities up, `last_commit_slot`
    // stamped inside `snapshot_into`.
    ctx.accounts
        .pool_live
        .snapshot_into(&mut ctx.accounts.pool, clock.slot)?;

    // Only in a real ER does a Magic program actually live at this address;
    // on LiteSVM (and any environment without the ER runtime) it is absent,
    // so skip the commit CPI rather than fail.
    if ctx.accounts.magic_program.to_account_info().executable {
        let bump = ctx.accounts.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(
            ctx.accounts.fee_escrow.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.balances_root.to_account_info(),
        ])
        .build_and_invoke_signed(&[seeds])?;
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
