use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

#[derive(Accounts)]
pub struct InitPoolLive<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: Public pool, read once to seed the live counters. A devnet
    /// migration has `Pool` already delegated (owned by the Delegation
    /// Program) by the time this runs, so a typed `Account<'info, Pool>`'s
    /// owner check would reject it with `AccountOwnedByWrongProgram` (week
    /// 4, Task 3). Deserialized manually instead (`Pool::try_deserialize`,
    /// discriminator-checked, owner-unchecked; `mint` validated below), and
    /// seeded from `config.dusdc_mint` rather than a self-referential
    /// `pool.mint` (matches `DelegatePoolLive`'s seed pattern).
    #[account(seeds = [POOL_SEED, config.dusdc_mint.as_ref()], bump)]
    pub pool: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = 8 + PoolLive::INIT_SPACE,
        seeds = [POOL_LIVE_SEED, config.dusdc_mint.as_ref()], bump)]
    pub pool_live: Account<'info, PoolLive>,
    pub system_program: Program<'info, System>,
}

pub fn init_pool_live(ctx: Context<InitPoolLive>) -> Result<()> {
    let data = ctx.accounts.pool.try_borrow_data()?;
    let p = Pool::try_deserialize(&mut &data[..])?;
    require!(
        p.mint == ctx.accounts.config.dusdc_mint,
        DexxerError::PoolLiveMismatch
    );
    let l = &mut ctx.accounts.pool_live;
    l.version = 1;
    l.mint = p.mint;
    l.capital_total = p.capital_total;
    l.protocol_liquidity = p.protocol_liquidity;
    l.locked_total = p.locked_total;
    l.fees_accrued = p.fees_accrued;
    l.insurance = p.insurance;
    l.bad_debt_total = p.bad_debt_total;
    l.bump = ctx.bumps.pool_live;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePoolLive<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub dusdc_mint: Account<'info, Mint>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [POOL_LIVE_SEED, dusdc_mint.key().as_ref()], bump)]
    pub pool_live: UncheckedAccount<'info>,
}

pub fn delegate_pool_live(ctx: Context<DelegatePoolLive>) -> Result<()> {
    let mint = ctx.accounts.dusdc_mint.key();
    ctx.accounts.delegate_pool_live(
        &ctx.accounts.admin,
        &[POOL_LIVE_SEED, mint.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}
