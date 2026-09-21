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
// Single admin bootstrap ix carrying 8 distinct config values; a params-struct
// refactor would churn every caller (client + LiteSVM) for no runtime benefit.
#[allow(clippy::too_many_arguments)]
pub fn init_config(
    ctx: Context<InitConfig>,
    crank: Pubkey,
    oracle_program: Pubkey,
    tee_validator: Pubkey,
    disclosure_delay_slots: u64,
    scheduler_signer: Pubkey,
    fee_payer: Pubkey,
    magic_fee_vault: Pubkey,
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
    // Week-2 Task 1 M1: scheduled ticks are NOT signed by the flat
    // `magicblock_magic_program_api::pda::CRANK_SIGNER` PDA — caller supplies
    // the real signer here as a starting value. Task 6 (fix round 3) found the
    // actual signer Magic Program uses for a scheduled `crank_tick` is the
    // *per-authority* `crank_signer_pda(admin)` (seeds `["crank-executor",
    // authority]`, authority = the `schedule_crank` payer), not this
    // constructor's static value — on devnet this field is overwritten after
    // `init_config` via the base-layer `set_scheduler_signer` admin ix with
    // `crank_signer_pda(admin)` before `schedule_crank` is ever called (see
    // `tests/er/lib/crank-signer.ts`, `scripts/admin/set-scheduler-signer.ts`).
    // `crank_tick`'s constraint still accepts the flat `CRANK_SIGNER` PDA as a
    // third branch (crank.rs untouched).
    c.scheduler_signer = scheduler_signer;
    c.fee_payer = fee_payer;
    c.magic_fee_vault = magic_fee_vault;
    c.crank_task_id = 0;
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

// Week-2 Task 5 fix round 1 (controller ruling): the dedicated, delegatable
// fee-escrow PDA that pays `commit_aggregate`'s intent CPI (see
// state/fee_escrow.rs and instructions/commit.rs). Separate init ix — the
// smallest coherent surface — rather than folding into `init_config`/
// `init_pool`, so it stays independently testable and doesn't perturb their
// existing account lists.
#[derive(Accounts)]
pub struct InitFeeEscrow<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + FeeEscrow::INIT_SPACE, seeds = [FEE_ESCROW_SEED], bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    pub system_program: Program<'info, System>,
}
pub fn init_fee_escrow(ctx: Context<InitFeeEscrow>) -> Result<()> {
    let e = &mut ctx.accounts.fee_escrow;
    e.version = 1;
    e.bump = ctx.bumps.fee_escrow;
    Ok(())
}

// Delegates the fee-escrow PDA to the TEE validator, same pattern as
// `delegate_market`/`delegate_pool` above.
#[delegate]
#[derive(Accounts)]
pub struct DelegateFeeEscrow<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [FEE_ESCROW_SEED], bump)]
    pub fee_escrow: UncheckedAccount<'info>,
}
pub fn delegate_fee_escrow(ctx: Context<DelegateFeeEscrow>) -> Result<()> {
    ctx.accounts.delegate_fee_escrow(
        &ctx.accounts.admin,
        &[FEE_ESCROW_SEED],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
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
// Task-6 fix round 3 (controller ruling, supersedes round 2's in-schedule_crank
// write attempt): base-layer admin ix, same `AdminConfig` context/pattern as
// `pause`/`unpause` above — `config` is writable here with no issue, because
// this ix has nothing to do with `ScheduleCrankCpi`'s `instruction_accounts`
// (the restriction fix round 2 hit twice — a writable, non-delegated account
// there is unconditionally rejected — only applies to that specific CPI's
// account list, not to ordinary base-layer writes to an undelegated `Config`).
// Client computes `new_scheduler_signer = crank_signer_pda(admin)` the same
// way `schedule_crank` used to (see `tests/er/lib/crank-signer.ts`) and calls
// this once per admin before scheduling; `schedule_crank` then just reads
// `Config.scheduler_signer` back (see `crank.rs`) instead of computing or
// writing it itself.
pub fn set_scheduler_signer(ctx: Context<AdminConfig>, new_scheduler_signer: Pubkey) -> Result<()> {
    ctx.accounts.config.scheduler_signer = new_scheduler_signer;
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
    /// CHECK: eSPL ephemeral ATA record, verified against espl::find_ephemeral_ata(pool, mint)
    #[account(mut)]
    pub pool_eata: UncheckedAccount<'info>,
    /// CHECK: eSPL global vault, verified against espl::find_global_vault(mint) — must exist
    /// (client runs delegateSpl(admin, mint, …, initVaultIfMissing) first)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: vault token account, verified against get_associated_token_address(vault, mint)
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,
    /// CHECK: delegation PDAs for the eATA, verified against espl::find_eata_delegation_pdas(eata)
    #[account(mut)]
    pub eata_buffer: UncheckedAccount<'info>,
    /// CHECK: verified against espl::find_eata_delegation_pdas(eata)
    #[account(mut)]
    pub eata_record: UncheckedAccount<'info>,
    /// CHECK: verified against espl::find_eata_delegation_pdas(eata)
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

    // Every "CHECK" account below is client-supplied and unconstrained by Anchor
    // seeds (some are PDAs of the eSPL program, not ours), so re-derive and
    // verify each one here rather than trusting the caller.
    let (expected_eata, _) = espl::find_ephemeral_ata(&ctx.accounts.pool.key(), &mint);
    require_keys_eq!(
        ctx.accounts.pool_eata.key(),
        expected_eata,
        DexxerError::InvalidInput
    );
    let (expected_vault, _) = espl::find_global_vault(&mint);
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault,
        DexxerError::InvalidInput
    );
    let expected_vault_ata =
        anchor_spl::associated_token::get_associated_token_address(&expected_vault, &mint);
    require_keys_eq!(
        ctx.accounts.vault_ata.key(),
        expected_vault_ata,
        DexxerError::InvalidInput
    );
    let eata_delegation = espl::find_eata_delegation_pdas(&expected_eata);
    require_keys_eq!(
        ctx.accounts.eata_buffer.key(),
        eata_delegation.buffer,
        DexxerError::InvalidInput
    );
    require_keys_eq!(
        ctx.accounts.eata_record.key(),
        eata_delegation.record,
        DexxerError::InvalidInput
    );
    require_keys_eq!(
        ctx.accounts.eata_metadata.key(),
        eata_delegation.metadata,
        DexxerError::InvalidInput
    );

    let bump = ctx.bumps.pool;
    let seeds: &[&[u8]] = &[POOL_SEED, mint.as_ref(), &[bump]];
    // same order as SDK delegateSpl(): init eATA -> transfer to vault (0) -> delegate eATA
    espl::InitializeEphemeralAta {
        payer: &ctx.accounts.admin.to_account_info(),
        eata: &ctx.accounts.pool_eata.to_account_info(),
        user: &ctx.accounts.pool.to_account_info(),
        mint: &ctx.accounts.dusdc_mint.to_account_info(),
        system_program: &ctx.accounts.system_program.to_account_info(),
    }
    .invoke()?;
    // Deposit the pool's *entire current* base-layer balance into the vault as
    // part of delegation, not a hardcoded 0 (task-13 finding: mb-stack accepts
    // `amount: 0` without error, but then the ER-visible ephemeral balance for
    // `pool_ata` is 0 too — pool funds seeded on L1 via `seed_pool` before
    // this call would be stranded, invisible from the ER). Reading the amount
    // straight off the already-deserialized `pool_ata` account keeps this
    // correct regardless of when `seed_pool` runs relative to delegation.
    let deposit_amount = ctx.accounts.pool_ata.amount;
    espl::DepositSplTokens {
        authority: &ctx.accounts.pool.to_account_info(),
        eata: &ctx.accounts.pool_eata.to_account_info(),
        vault: &ctx.accounts.vault.to_account_info(),
        mint: &ctx.accounts.dusdc_mint.to_account_info(),
        user_source_token_acc: &ctx.accounts.pool_ata.to_account_info(),
        vault_token_acc: &ctx.accounts.vault_ata.to_account_info(),
        token_program: &ctx.accounts.token_program.to_account_info(),
        amount: deposit_amount,
    }
    .invoke_signed(seeds)?;
    espl::DelegateEphemeralAta {
        payer: &ctx.accounts.admin.to_account_info(),
        eata: &ctx.accounts.pool_eata.to_account_info(),
        espl_token_program: &ctx.accounts.espl_program.to_account_info(),
        delegation_buffer: &ctx.accounts.eata_buffer.to_account_info(),
        delegation_record: &ctx.accounts.eata_record.to_account_info(),
        delegation_metadata: &ctx.accounts.eata_metadata.to_account_info(),
        delegation_program: &ctx.accounts.delegation_program.to_account_info(),
        system_program: &ctx.accounts.system_program.to_account_info(),
        validator: Some(ctx.accounts.config.tee_validator),
    }
    .invoke()?;
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
    use ephemeral_rollups_sdk::delegate_args::DelegateAccounts;

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

    /// `ephemeral_rollups_sdk::spl::types::GlobalVault::find_pda`
    pub fn find_global_vault(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[mint.as_ref()], &espl_program_id())
    }

    /// The eATA's own delegation buffer/record/metadata PDAs — distinct from the
    /// pool PDA's (those are `#[delegate]`-generated). Computed the same way the
    /// SDK's `ephemeral_rollups_sdk::delegate_args::DelegateAccounts::new(eata,
    /// ESPL_TOKEN_PROGRAM_ID)` does: owner_program = the eSPL token program,
    /// since it (not us) owns the eATA account.
    pub struct EataDelegationPdas {
        pub buffer: Pubkey,
        pub record: Pubkey,
        pub metadata: Pubkey,
    }

    pub fn find_eata_delegation_pdas(eata: &Pubkey) -> EataDelegationPdas {
        let compat_eata = ephemeral_rollups_sdk::compat::Pubkey::new_from_array(eata.to_bytes());
        let accounts = DelegateAccounts::new(
            compat_eata,
            ephemeral_rollups_sdk::consts::ESPL_TOKEN_PROGRAM_ID,
        );
        EataDelegationPdas {
            buffer: Pubkey::new_from_array(accounts.delegate_buffer.to_bytes()),
            record: Pubkey::new_from_array(accounts.delegation_record.to_bytes()),
            metadata: Pubkey::new_from_array(accounts.delegation_metadata.to_bytes()),
        }
    }

    /// `ephemeral_rollups_sdk::spl::cpi::InitializeEphemeralAta`
    pub struct InitializeEphemeralAta<'a, 'info> {
        pub payer: &'a AccountInfo<'info>,
        pub eata: &'a AccountInfo<'info>,
        pub user: &'a AccountInfo<'info>,
        pub mint: &'a AccountInfo<'info>,
        pub system_program: &'a AccountInfo<'info>,
    }
    impl<'a, 'info> InitializeEphemeralAta<'a, 'info> {
        pub fn invoke(self) -> Result<()> {
            let ix = Instruction {
                program_id: espl_program_id(),
                accounts: vec![
                    AccountMeta::new(*self.eata.key, false),
                    // Must be `is_signer: true`: the eSPL program CPIs into the
                    // System Program to create+fund the eATA, which requires the
                    // payer's actual signature. Matches the TS SDK's
                    // `initEphemeralAtaIx` (payer: isSigner true) — verified
                    // against a real eSPL program on mb-stack (task-13): with
                    // `false` here the eSPL program's own System Program CPI
                    // fails with `PrivilegeEscalation`.
                    AccountMeta::new(*self.payer.key, true),
                    AccountMeta::new_readonly(*self.user.key, false),
                    AccountMeta::new_readonly(*self.mint.key, false),
                    AccountMeta::new_readonly(*self.system_program.key, false),
                ],
                data: vec![INITIALIZE_EPHEMERAL_ATA],
            };
            invoke(
                &ix,
                &[
                    self.eata.clone(),
                    self.payer.clone(),
                    self.user.clone(),
                    self.mint.clone(),
                    self.system_program.clone(),
                ],
            )?;
            Ok(())
        }
    }

    /// `ephemeral_rollups_sdk::spl::cpi::DepositSplTokens`
    pub struct DepositSplTokens<'a, 'info> {
        pub authority: &'a AccountInfo<'info>,
        pub eata: &'a AccountInfo<'info>,
        pub vault: &'a AccountInfo<'info>,
        pub mint: &'a AccountInfo<'info>,
        pub user_source_token_acc: &'a AccountInfo<'info>,
        pub vault_token_acc: &'a AccountInfo<'info>,
        pub token_program: &'a AccountInfo<'info>,
        pub amount: u64,
    }
    impl<'a, 'info> DepositSplTokens<'a, 'info> {
        pub fn invoke_signed(self, signer_seeds: &[&[u8]]) -> Result<()> {
            let mut data = Vec::with_capacity(9);
            data.push(DEPOSIT_SPL_TOKENS);
            data.extend_from_slice(&self.amount.to_le_bytes());
            let ix = Instruction {
                program_id: espl_program_id(),
                accounts: vec![
                    AccountMeta::new(*self.eata.key, false),
                    AccountMeta::new_readonly(*self.vault.key, false),
                    AccountMeta::new_readonly(*self.mint.key, false),
                    AccountMeta::new(*self.user_source_token_acc.key, false),
                    AccountMeta::new(*self.vault_token_acc.key, false),
                    AccountMeta::new_readonly(*self.authority.key, true),
                    AccountMeta::new_readonly(*self.token_program.key, false),
                ],
                data,
            };
            invoke_signed(
                &ix,
                &[
                    self.eata.clone(),
                    self.vault.clone(),
                    self.mint.clone(),
                    self.user_source_token_acc.clone(),
                    self.vault_token_acc.clone(),
                    self.authority.clone(),
                    self.token_program.clone(),
                ],
                &[signer_seeds],
            )?;
            Ok(())
        }
    }

    /// `ephemeral_rollups_sdk::spl::cpi::DelegateEphemeralAta`
    pub struct DelegateEphemeralAta<'a, 'info> {
        pub payer: &'a AccountInfo<'info>,
        pub eata: &'a AccountInfo<'info>,
        pub espl_token_program: &'a AccountInfo<'info>,
        pub delegation_buffer: &'a AccountInfo<'info>,
        pub delegation_record: &'a AccountInfo<'info>,
        pub delegation_metadata: &'a AccountInfo<'info>,
        pub delegation_program: &'a AccountInfo<'info>,
        pub system_program: &'a AccountInfo<'info>,
        pub validator: Option<Pubkey>,
    }
    impl<'a, 'info> DelegateEphemeralAta<'a, 'info> {
        pub fn invoke(self) -> Result<()> {
            let mut data = Vec::with_capacity(33);
            data.push(DELEGATE_EPHEMERAL_ATA);
            if let Some(validator) = self.validator {
                data.extend_from_slice(validator.as_ref());
            }
            let ix = Instruction {
                program_id: espl_program_id(),
                accounts: vec![
                    AccountMeta::new(*self.payer.key, true),
                    AccountMeta::new(*self.eata.key, false),
                    AccountMeta::new_readonly(*self.espl_token_program.key, false),
                    AccountMeta::new(*self.delegation_buffer.key, false),
                    AccountMeta::new(*self.delegation_record.key, false),
                    AccountMeta::new(*self.delegation_metadata.key, false),
                    AccountMeta::new_readonly(*self.delegation_program.key, false),
                    AccountMeta::new_readonly(*self.system_program.key, false),
                ],
                data,
            };
            invoke(
                &ix,
                &[
                    self.payer.clone(),
                    self.eata.clone(),
                    self.espl_token_program.clone(),
                    self.delegation_buffer.clone(),
                    self.delegation_record.clone(),
                    self.delegation_metadata.clone(),
                    self.delegation_program.clone(),
                    self.system_program.clone(),
                ],
            )?;
            Ok(())
        }
    }
}
