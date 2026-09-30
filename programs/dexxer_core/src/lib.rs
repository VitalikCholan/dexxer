// The `#[program]` macro expands to a discriminator-dispatch match whose
// generated arms trip clippy::diverging_sub_expression on this clippy/rustc
// version; this is Anchor-generated code, not ours, and clippy's own
// diagnostic suggests this exact crate-level override.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod risk;
pub mod state;
pub mod token;
use instructions::*;
use state::{MarketParams, Side};
declare_id!("G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV");

#[ephemeral]
#[program]
pub mod dexxer_core {
    use super::*;
    #[allow(clippy::too_many_arguments)]
    pub fn init_config(
        ctx: Context<InitConfig>,
        crank: Pubkey,
        oracle_program: Pubkey,
        tee_validator: Pubkey,
        scheduler_signer: Pubkey,
        fee_payer: Pubkey,
        magic_fee_vault: Pubkey,
    ) -> Result<()> {
        admin::init_config(
            ctx,
            crank,
            oracle_program,
            tee_validator,
            scheduler_signer,
            fee_payer,
            magic_fee_vault,
        )
    }
    pub fn init_market(
        ctx: Context<InitMarket>,
        symbol: [u8; 8],
        params: MarketParams,
        lazer_feed_id: String,
    ) -> Result<()> {
        admin::init_market(ctx, symbol, params, lazer_feed_id)
    }
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        admin::init_pool(ctx)
    }
    pub fn set_params(ctx: Context<AdminMarket>, params: MarketParams) -> Result<()> {
        admin::set_params(ctx, params)
    }
    pub fn pause(ctx: Context<AdminConfig>) -> Result<()> {
        admin::pause(ctx)
    }
    pub fn unpause(ctx: Context<AdminConfig>) -> Result<()> {
        admin::unpause(ctx)
    }
    pub fn set_scheduler_signer(
        ctx: Context<AdminConfig>,
        new_scheduler_signer: Pubkey,
    ) -> Result<()> {
        admin::set_scheduler_signer(ctx, new_scheduler_signer)
    }
    pub fn seed_pool(ctx: Context<SeedPool>, amount: u64) -> Result<()> {
        admin::seed_pool(ctx, amount)
    }
    pub fn init_fee_escrow(ctx: Context<InitFeeEscrow>) -> Result<()> {
        admin::init_fee_escrow(ctx)
    }
    pub fn delegate_fee_escrow(ctx: Context<DelegateFeeEscrow>) -> Result<()> {
        admin::delegate_fee_escrow(ctx)
    }
    pub fn faucet_init(ctx: Context<FaucetInit>, amount: u64) -> Result<()> {
        user::faucet_init(ctx, amount)
    }
    pub fn faucet_mint(ctx: Context<FaucetMint>, amount: u64) -> Result<()> {
        user::faucet_mint(ctx, amount)
    }
    pub fn init_user(ctx: Context<InitUser>, exit_salt: [u8; 32]) -> Result<()> {
        user::init_user(ctx, exit_salt)
    }
    pub fn set_session<'info>(
        ctx: Context<'info, SetSession<'info>>,
        session_key: Pubkey,
        expiry: i64,
        actions: u32,
    ) -> Result<()> {
        user::set_session(ctx, session_key, expiry, actions)
    }
    pub fn credit_deposit(ctx: Context<CreditDeposit>, amount: u64) -> Result<()> {
        user::credit_deposit(ctx, amount)
    }
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        user::withdraw(ctx, amount)
    }
    pub fn open_position<'info>(
        ctx: Context<'info, Trade<'info>>,
        side: Side,
        size: u64,
        margin: u64,
        limit_price: u64,
    ) -> Result<()> {
        trade::open_position(ctx, side, size, margin, limit_price)
    }
    pub fn add_margin(ctx: Context<Trade>, amount: u64) -> Result<()> {
        trade::add_margin(ctx, amount)
    }
    pub fn close_position<'info>(
        ctx: Context<'info, Trade<'info>>,
        limit_price: u64,
    ) -> Result<()> {
        trade::close_position(ctx, limit_price)
    }
    pub fn increase_position(
        ctx: Context<Trade>,
        add_size: u64,
        add_margin: u64,
        limit_price: u64,
    ) -> Result<()> {
        trade::increase_position(ctx, add_size, add_margin, limit_price)
    }
    pub fn decrease_position<'info>(
        ctx: Context<'info, Trade<'info>>,
        close_size: u64,
        limit_price: u64,
    ) -> Result<()> {
        trade::decrease_position(ctx, close_size, limit_price)
    }
    /// Week-5 Task 3: the per-position scheduled liquidation task's
    /// instruction. Registered by `open_position`, signed by
    /// `crank_signer_pda(fee_escrow)`, never carries `remaining_accounts`.
    pub fn liquidation_check(ctx: Context<LiquidationCheck>) -> Result<()> {
        liquidation::liquidation_check(ctx)
    }
    pub fn crank_tick<'info>(ctx: Context<'info, CrankTick<'info>>) -> Result<()> {
        crank::crank_tick(ctx)
    }
    pub fn schedule_crank<'info>(
        ctx: Context<'info, ScheduleCrank<'info>>,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        crank::schedule_crank(ctx, task_id, interval_ms, iterations)
    }
    pub fn cancel_crank<'info>(
        ctx: Context<'info, CancelCrank<'info>>,
        task_id: i64,
    ) -> Result<()> {
        crank::cancel_crank(ctx, task_id)
    }
    pub fn commit_aggregate(ctx: Context<CommitAggregate>) -> Result<()> {
        commit::commit_aggregate(ctx)
    }
    pub fn commit_market(ctx: Context<CommitMarket>) -> Result<()> {
        commit::commit_market(ctx)
    }
    pub fn delegate_market(ctx: Context<DelegateMarket>, symbol: [u8; 8]) -> Result<()> {
        admin::delegate_market(ctx, symbol)
    }
    pub fn init_position(ctx: Context<InitPosition>, symbol: [u8; 8]) -> Result<()> {
        positions::init_position(ctx, symbol)
    }
    pub fn delegate_position(ctx: Context<DelegatePosition>, symbol: [u8; 8]) -> Result<()> {
        positions::delegate_position(ctx, symbol)
    }
    pub fn init_position_permission(ctx: Context<InitPositionPermission>) -> Result<()> {
        positions::init_position_permission(ctx)
    }
    pub fn undelegate_position<'info>(
        ctx: Context<'info, UndelegatePosition<'info>>,
    ) -> Result<()> {
        positions::undelegate_position(ctx)
    }
    pub fn close_exited_position(ctx: Context<CloseExitedPosition>) -> Result<()> {
        positions::close_exited_position(ctx)
    }
    pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
        admin::delegate_pool(ctx)
    }
    pub fn init_pool_live(ctx: Context<InitPoolLive>) -> Result<()> {
        pool_live::init_pool_live(ctx)
    }
    pub fn delegate_pool_live(ctx: Context<DelegatePoolLive>) -> Result<()> {
        pool_live::delegate_pool_live(ctx)
    }
    pub fn delegate_user(ctx: Context<DelegateUser>) -> Result<()> {
        user::delegate_user(ctx)
    }
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        user::init_permissions(ctx)
    }
    pub fn init_market_permissions(ctx: Context<InitMarketPermissions>) -> Result<()> {
        user::init_market_permissions(ctx)
    }
    pub fn undelegate_user<'info>(ctx: Context<'info, UndelegateUser<'info>>) -> Result<()> {
        user::undelegate_user(ctx)
    }
    pub fn close_exited_user(ctx: Context<CloseExitedUser>) -> Result<()> {
        user::close_exited_user(ctx)
    }
    pub fn init_balances_root(ctx: Context<InitBalancesRoot>) -> Result<()> {
        root::init_balances_root(ctx)
    }
    pub fn delegate_balances_root(ctx: Context<DelegateBalancesRoot>) -> Result<()> {
        root::delegate_balances_root(ctx)
    }
    pub fn set_balances_root<'info>(
        ctx: Context<'info, SetBalancesRoot<'info>>,
        begin: bool,
        finalize: bool,
        padding_seed: [u8; 32],
    ) -> Result<()> {
        root::set_balances_root(ctx, begin, finalize, padding_seed)
    }
}
