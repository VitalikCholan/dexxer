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
use state::{DisclosureArgs, MarketParams, Side};
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
        disclosure_delay_slots: u64,
        scheduler_signer: Pubkey,
        fee_payer: Pubkey,
        magic_fee_vault: Pubkey,
    ) -> Result<()> {
        admin::init_config(
            ctx,
            crank,
            oracle_program,
            tee_validator,
            disclosure_delay_slots,
            scheduler_signer,
            fee_payer,
            magic_fee_vault,
        )
    }
    pub fn init_market(
        ctx: Context<InitMarket>,
        params: MarketParams,
        lazer_feed_id: String,
    ) -> Result<()> {
        admin::init_market(ctx, params, lazer_feed_id)
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
    pub fn set_session(
        ctx: Context<SetSession>,
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
    pub fn open_position(
        ctx: Context<Trade>,
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
    pub fn close_position(ctx: Context<Trade>, limit_price: u64) -> Result<()> {
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
    pub fn decrease_position(ctx: Context<Trade>, close_size: u64, limit_price: u64) -> Result<()> {
        trade::decrease_position(ctx, close_size, limit_price)
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
    pub fn commit_aggregate<'info>(ctx: Context<'info, CommitAggregate<'info>>) -> Result<()> {
        commit::commit_aggregate(ctx)
    }
    pub fn commit_market(ctx: Context<CommitMarket>) -> Result<()> {
        commit::commit_market(ctx)
    }
    pub fn delegate_market(ctx: Context<DelegateMarket>) -> Result<()> {
        admin::delegate_market(ctx)
    }
    pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
        admin::delegate_pool(ctx)
    }
    pub fn delegate_user(ctx: Context<DelegateUser>) -> Result<()> {
        user::delegate_user(ctx)
    }
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        user::init_permissions(ctx)
    }
    pub fn write_commitment(
        ctx: Context<WriteCommitment>,
        nonce: u64,
        hash: [u8; 32],
    ) -> Result<()> {
        disclosure::write_commitment(ctx, nonce, hash)
    }
    pub fn write_disclosure(
        ctx: Context<WriteDisclosure>,
        args: DisclosureArgs,
        salt: [u8; 32],
    ) -> Result<()> {
        disclosure::write_disclosure(ctx, args, salt)
    }
}
