use crate::{errors::DexxerError, oracle::feed_pda, state::*, token::transfer_signed_by_owner};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use ephemeral_rollups_sdk::{anchor::delegate, cpi::DelegateConfig};

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

// spec §8 Q2: delegate the market's own account and its risk-ledger sibling to
// the TEE validator. Neither carries user-scoped fields, so no ER permission
// account is created for them here — market data stays readable to the crank.
#[delegate]
#[derive(Accounts)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [MARKET_SEED, &SOL_SYMBOL], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [RISK_SEED, market.key().as_ref()], bump)]
    pub market_risk: UncheckedAccount<'info>,
}
pub fn delegate_market(ctx: Context<DelegateMarket>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    ctx.accounts.delegate_market(
        &ctx.accounts.admin,
        &[MARKET_SEED, &SOL_SYMBOL],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    ctx.accounts.delegate_market_risk(
        &ctx.accounts.admin,
        &[RISK_SEED, market_key.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

// spec §8 Q2: delegate the pool PDA plus its ephemeral SPL ATA (init -> deposit
// 0 -> delegate, same order as the SDK's client-side `delegateSpl()`). The
// eATA's own delegation buffer/record/metadata are separate accounts from the
// pool PDA's (auto-generated by `#[delegate]` for the `pool` field only).
#[delegate]
#[derive(Accounts)]
pub struct DelegatePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized, has_one = dusdc_mint)]
    pub config: Account<'info, Config>,
    pub dusdc_mint: Account<'info, Mint>,
    /// CHECK: delegated PDA (also signs the eSPL CPIs as the eATA "user")
    #[account(mut, del, seeds = [POOL_SEED, dusdc_mint.key().as_ref()], bump)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = dusdc_mint, associated_token::authority = pool)]
    pub pool_ata: Account<'info, TokenAccount>,
    /// CHECK: eSPL ephemeral ATA record, EphemeralAta::find_pda(pool, mint)
    #[account(mut)]
    pub pool_eata: UncheckedAccount<'info>,
    /// CHECK: eSPL global vault, GlobalVault::find_pda(mint) — must exist (client runs delegateSpl(admin, mint, …, initVaultIfMissing) first)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: vault token account, find_vault_ata(mint, vault)
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,
    /// CHECK: delegation PDAs for the eATA
    #[account(mut)]
    pub eata_buffer: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub eata_record: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub eata_metadata: UncheckedAccount<'info>,
    /// CHECK: eSPL program
    #[account(address = ephemeral_rollups_sdk::consts::ESPL_TOKEN_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
    let mint = ctx.accounts.dusdc_mint.key();
    let (expected_eata, _) = espl::find_ephemeral_ata(&ctx.accounts.pool.key(), &mint);
    require_keys_eq!(
        ctx.accounts.pool_eata.key(),
        expected_eata,
        DexxerError::InvalidInput
    );
    let bump = ctx.bumps.pool;
    let seeds: &[&[u8]] = &[POOL_SEED, mint.as_ref(), &[bump]];
    // same order as SDK delegateSpl(): init eATA -> transfer to vault (0) -> delegate eATA
    espl::initialize_ephemeral_ata(
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.pool_eata.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.dusdc_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
    )?;
    espl::deposit_spl_tokens(
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.pool_eata.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.dusdc_mint.to_account_info(),
        &ctx.accounts.pool_ata.to_account_info(),
        &ctx.accounts.vault_ata.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        0,
        seeds,
    )?;
    espl::delegate_ephemeral_ata(
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.pool_eata.to_account_info(),
        &ctx.accounts.espl_program.to_account_info(),
        &ctx.accounts.eata_buffer.to_account_info(),
        &ctx.accounts.eata_record.to_account_info(),
        &ctx.accounts.eata_metadata.to_account_info(),
        &ctx.accounts.delegation_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        Some(ctx.accounts.config.tee_validator),
    )?;
    ctx.accounts.delegate_pool(
        &ctx.accounts.admin,
        &[POOL_SEED, mint.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

// Hand-rolled eSPL ("ephemeral SPL token") CPI helpers, mirroring
// `ephemeral_rollups_sdk::spl::cpi::{InitializeEphemeralAta, DepositSplTokens,
// DelegateEphemeralAta}` byte-for-byte (discriminators, account order, data
// layout copied from the SDK source at
// ephemeral-rollups-sdk-0.16.2/src/spl/cpi/*.rs). Reimplemented locally rather
// than enabling the SDK's `spl` cargo feature: that feature unconditionally
// pulls in `encryption` -> `solana-sdk` (the full off-chain client SDK), which
// drags `rand 0.9`/`getrandom 0.3` into the SBF program build with no
// `getrandom` backend registered for the target — `anchor build` fails with
// "target is not supported" before dexxer_core itself is even reached. None
// of that machinery is needed for the three CPIs used here. See task-11
// report, Deviations.
mod espl {
    use anchor_lang::prelude::*;
    use anchor_lang::solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    };

    // ephemeral_rollups_sdk::spl::EphemeralSplDiscriminator variants used here.
    const INITIALIZE_EPHEMERAL_ATA: u8 = 0;
    const DEPOSIT_SPL_TOKENS: u8 = 2;
    const DELEGATE_EPHEMERAL_ATA: u8 = 4;

    fn espl_program_id() -> Pubkey {
        Pubkey::new_from_array(ephemeral_rollups_sdk::consts::ESPL_TOKEN_PROGRAM_ID.to_bytes())
    }

    /// `ephemeral_rollups_sdk::spl::types::EphemeralAta::find_pda`
    pub fn find_ephemeral_ata(user: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[user.as_ref(), mint.as_ref()], &espl_program_id())
    }

    /// `ephemeral_rollups_sdk::spl::cpi::InitializeEphemeralAta`
    pub fn initialize_ephemeral_ata<'info>(
        payer: &AccountInfo<'info>,
        eata: &AccountInfo<'info>,
        user: &AccountInfo<'info>,
        mint: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
    ) -> Result<()> {
        let ix = Instruction {
            program_id: espl_program_id(),
            accounts: vec![
                AccountMeta::new(*eata.key, false),
                AccountMeta::new(*payer.key, false),
                AccountMeta::new_readonly(*user.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new_readonly(*system_program.key, false),
            ],
            data: vec![INITIALIZE_EPHEMERAL_ATA],
        };
        invoke(
            &ix,
            &[
                eata.clone(),
                payer.clone(),
                user.clone(),
                mint.clone(),
                system_program.clone(),
            ],
        )?;
        Ok(())
    }

    /// `ephemeral_rollups_sdk::spl::cpi::DepositSplTokens`
    #[allow(clippy::too_many_arguments)]
    pub fn deposit_spl_tokens<'info>(
        authority: &AccountInfo<'info>,
        eata: &AccountInfo<'info>,
        vault: &AccountInfo<'info>,
        mint: &AccountInfo<'info>,
        user_source_token_acc: &AccountInfo<'info>,
        vault_token_acc: &AccountInfo<'info>,
        token_program: &AccountInfo<'info>,
        amount: u64,
        signer_seeds: &[&[u8]],
    ) -> Result<()> {
        let mut data = Vec::with_capacity(9);
        data.push(DEPOSIT_SPL_TOKENS);
        data.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction {
            program_id: espl_program_id(),
            accounts: vec![
                AccountMeta::new(*eata.key, false),
                AccountMeta::new_readonly(*vault.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new(*user_source_token_acc.key, false),
                AccountMeta::new(*vault_token_acc.key, false),
                AccountMeta::new_readonly(*authority.key, true),
                AccountMeta::new_readonly(*token_program.key, false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                eata.clone(),
                vault.clone(),
                mint.clone(),
                user_source_token_acc.clone(),
                vault_token_acc.clone(),
                authority.clone(),
                token_program.clone(),
            ],
            &[signer_seeds],
        )?;
        Ok(())
    }

    /// `ephemeral_rollups_sdk::spl::cpi::DelegateEphemeralAta`
    #[allow(clippy::too_many_arguments)]
    pub fn delegate_ephemeral_ata<'info>(
        payer: &AccountInfo<'info>,
        eata: &AccountInfo<'info>,
        espl_token_program: &AccountInfo<'info>,
        delegation_buffer: &AccountInfo<'info>,
        delegation_record: &AccountInfo<'info>,
        delegation_metadata: &AccountInfo<'info>,
        delegation_program: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        validator: Option<Pubkey>,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(33);
        data.push(DELEGATE_EPHEMERAL_ATA);
        if let Some(validator) = validator {
            data.extend_from_slice(validator.as_ref());
        }
        let ix = Instruction {
            program_id: espl_program_id(),
            accounts: vec![
                AccountMeta::new(*payer.key, true),
                AccountMeta::new(*eata.key, false),
                AccountMeta::new_readonly(*espl_token_program.key, false),
                AccountMeta::new(*delegation_buffer.key, false),
                AccountMeta::new(*delegation_record.key, false),
                AccountMeta::new(*delegation_metadata.key, false),
                AccountMeta::new_readonly(*delegation_program.key, false),
                AccountMeta::new_readonly(*system_program.key, false),
            ],
            data,
        };
        invoke(
            &ix,
            &[
                payer.clone(),
                eata.clone(),
                espl_token_program.clone(),
                delegation_buffer.clone(),
                delegation_record.clone(),
                delegation_metadata.clone(),
                delegation_program.clone(),
                system_program.clone(),
            ],
        )?;
        Ok(())
    }
}
