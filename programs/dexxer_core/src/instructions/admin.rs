use crate::{errors::DexxerError, oracle::feed_pda, state::*, token::transfer_signed_by_owner};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, mint::decimals = 6, mint::authority = mint_auth)]
    pub dusdc_mint: Account<'info, Mint>,
    /// CHECK: PDA used only as mint authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_auth: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}
pub fn init_config(
    ctx: Context<InitConfig>,
    crank: Pubkey,
    oracle_program: Pubkey,
    tee_validator: Pubkey,
    disclosure_delay_slots: u64,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.version = 1;
    c.admin = ctx.accounts.admin.key();
    c.crank = crank;
    c.paused = false;
    c.oracle_program = oracle_program;
    c.tee_validator = tee_validator;
    c.dusdc_mint = ctx.accounts.dusdc_mint.key();
    c.disclosure_delay_slots = disclosure_delay_slots;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, &SOL_SYMBOL], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = 8 + MarketRisk::INIT_SPACE, seeds = [RISK_SEED, market.key().as_ref()], bump)]
    pub market_risk: Account<'info, MarketRisk>,
    pub system_program: Program<'info, System>,
}
pub fn init_market(
    ctx: Context<InitMarket>,
    params: MarketParams,
    lazer_feed_id: String,
) -> Result<()> {
    require!(params.validate(), DexxerError::InvalidParams);
    let m = &mut ctx.accounts.market;
    m.version = 1;
    m.symbol = SOL_SYMBOL;
    m.feed = feed_pda(&ctx.accounts.config.oracle_program, &lazer_feed_id);
    apply_params(m, &params);
    m.mark = 0;
    m.mark_slot = 0;
    m.paused_open = false;
    m.stale_ticks = 0;
    m.bump = ctx.bumps.market;
    let r = &mut ctx.accounts.market_risk;
    r.version = 1;
    r.market = m.key();
    r.bump = ctx.bumps.market_risk;
    Ok(())
}
pub fn apply_params(m: &mut Market, p: &MarketParams) {
    m.max_lev_bps = p.max_lev_bps;
    m.imr_bps = p.imr_bps;
    m.mmr_bps = p.mmr_bps;
    m.open_fee_bps = p.open_fee_bps;
    m.close_fee_bps = p.close_fee_bps;
    m.liq_fee_bps = p.liq_fee_bps;
    m.oi_cap = p.oi_cap;
    m.max_position = p.max_position;
    m.min_size = p.min_size;
    m.max_staleness_secs = p.max_staleness_secs;
    m.max_conf_bps = p.max_conf_bps;
    m.max_deviation_bps = p.max_deviation_bps;
    m.ema_alpha_bps = p.ema_alpha_bps;
    m.liq_hysteresis_ticks = p.liq_hysteresis_ticks;
    m.max_stale_ticks = p.max_stale_ticks;
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized, has_one = dusdc_mint)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED, dusdc_mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    pub dusdc_mint: Account<'info, Mint>,
    #[account(init, payer = admin, associated_token::mint = dusdc_mint, associated_token::authority = pool)]
    pub pool_ata: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
    let p = &mut ctx.accounts.pool;
    p.version = 1;
    p.mint = ctx.accounts.dusdc_mint.key();
    p.vault_ata = ctx.accounts.pool_ata.key();
    p.bump = ctx.bumps.pool;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
}
pub fn set_params(ctx: Context<AdminMarket>, params: MarketParams) -> Result<()> {
    require!(params.validate(), DexxerError::InvalidParams);
    apply_params(&mut ctx.accounts.market, &params);
    Ok(())
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
}
pub fn pause(ctx: Context<AdminConfig>) -> Result<()> {
    ctx.accounts.config.paused = true;
    Ok(())
}
pub fn unpause(ctx: Context<AdminConfig>) -> Result<()> {
    ctx.accounts.config.paused = false;
    Ok(())
}

#[derive(Accounts)]
pub struct SeedPool<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump, has_one = vault_ata)]
    pub pool: Account<'info, Pool>,
    #[account(mut, token::mint = pool.mint, token::authority = admin)]
    pub admin_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn seed_pool(ctx: Context<SeedPool>, amount: u64) -> Result<()> {
    require!(amount > 0, DexxerError::AmountZero);
    transfer_signed_by_owner(
        &ctx.accounts.token_program,
        &ctx.accounts.admin_ata,
        &ctx.accounts.vault_ata,
        &ctx.accounts.admin,
        amount,
    )?;
    let p = &mut ctx.accounts.pool;
    p.capital_total = p
        .capital_total
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    p.protocol_liquidity = p
        .protocol_liquidity
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    Ok(())
}
