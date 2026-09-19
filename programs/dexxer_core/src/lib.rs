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
use state::MarketParams;
declare_id!("G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV");

#[ephemeral]
#[program]
pub mod dexxer_core {
    use super::*;
    pub fn init_config(
        ctx: Context<InitConfig>,
        crank: Pubkey,
        oracle_program: Pubkey,
        tee_validator: Pubkey,
        disclosure_delay_slots: u64,
    ) -> Result<()> {
        admin::init_config(
            ctx,
            crank,
            oracle_program,
            tee_validator,
            disclosure_delay_slots,
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
    pub fn seed_pool(ctx: Context<SeedPool>, amount: u64) -> Result<()> {
        admin::seed_pool(ctx, amount)
    }
    pub fn faucet_init(ctx: Context<FaucetInit>, amount: u64) -> Result<()> {
        user::faucet_init(ctx, amount)
    }
    pub fn faucet_mint(ctx: Context<FaucetMint>, amount: u64) -> Result<()> {
        user::faucet_mint(ctx, amount)
    }
    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        user::init_user(ctx)
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
}
