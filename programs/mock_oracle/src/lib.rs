// The `#[program]` macro expands to a discriminator-dispatch match whose
// generated arms trip clippy::diverging_sub_expression on this clippy/rustc
// version; this is Anchor-generated code, not ours. Same override as
// `dexxer_core` (see its `lib.rs`).
#![allow(clippy::diverging_sub_expression)]

//! Localnet/mb-stack test fixture: writes a price feed account in the exact
//! byte layout `dexxer_core::oracle::parse_price_update` reads (Pyth
//! `PriceUpdateV2`, 134 bytes total). Devnet uses the real MagicBlock oracle
//! instead — this program only exists so ER scenarios can move prices without
//! a live Pyth Lazer feed.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{delegate, ephemeral},
    cpi::DelegateConfig,
};

declare_id!("68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh");

pub const FEED_SEED: &[u8] = b"price_feed";
pub const LAZER_SEED: &[u8] = b"pyth-lazer";
// 8 (Anchor discriminator) + 126 = 134 bytes, matching the real Pyth
// `PriceUpdateV2` account size that `dexxer_core::oracle::parse_price_update`
// expects.
pub const BODY: usize = 126;

#[account]
pub struct Feed {
    pub body: [u8; BODY],
}

#[ephemeral]
#[program]
pub mod mock_oracle {
    use super::*;

    /// Create the feed PDA and stamp the fields that never change after
    /// creation: write authority (the initializer), tag (1 = Full), a
    /// non-zero feed id, and the fixed +8 exponent used by every devnet
    /// fixture in `oracle.rs`.
    pub fn init_feed(ctx: Context<InitFeed>, _lazer_feed_id: String) -> Result<()> {
        let f = &mut ctx.accounts.feed;
        f.body = [0u8; BODY];
        f.body[0..32].copy_from_slice(ctx.accounts.authority.key().as_ref());
        f.body[32] = 1; // tag = Full
        f.body[33..65].copy_from_slice(&[0xc6u8; 32]); // non-zero placeholder feed id
        f.body[81..85].copy_from_slice(&8i32.to_le_bytes()); // exponent = +8
        Ok(())
    }

    /// Overwrite price/conf/publish_time/ema/posted_slot. Only the account
    /// that called `init_feed` (the stored write authority) may call this.
    pub fn set_price(
        ctx: Context<SetPrice>,
        price_1e8: i64,
        conf: u64,
        publish_time: i64,
    ) -> Result<()> {
        let slot = Clock::get()?.slot;
        let b = &mut ctx.accounts.feed.body;
        require!(
            b[0..32] == ctx.accounts.authority.key().to_bytes(),
            ErrorCode::Unauthorized
        );
        b[65..73].copy_from_slice(&price_1e8.to_le_bytes());
        b[73..81].copy_from_slice(&conf.to_le_bytes());
        b[85..93].copy_from_slice(&publish_time.to_le_bytes());
        b[93..101].copy_from_slice(&publish_time.to_le_bytes());
        b[101..109].copy_from_slice(&price_1e8.to_le_bytes());
        b[109..117].copy_from_slice(&conf.to_le_bytes());
        b[117..125].copy_from_slice(&slot.to_le_bytes());
        Ok(())
    }

    /// Delegate the feed PDA to an ER validator so scenarios can move prices
    /// inside the rollup. `remaining_accounts[0]`, if present, picks the
    /// validator (mirrors `dexxer_core::admin::delegate_market`).
    pub fn delegate_feed(ctx: Context<DelegateFeed>, lazer_feed_id: String) -> Result<()> {
        ctx.accounts.delegate_feed(
            &ctx.accounts.authority,
            &[FEED_SEED, LAZER_SEED, lazer_feed_id.as_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("unauthorized")]
    Unauthorized,
}

#[derive(Accounts)]
#[instruction(lazer_feed_id: String)]
pub struct InitFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + BODY,
        seeds = [FEED_SEED, LAZER_SEED, lazer_feed_id.as_bytes()],
        bump
    )]
    pub feed: Account<'info, Feed>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub feed: Account<'info, Feed>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(lazer_feed_id: String)]
pub struct DelegateFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: delegated feed PDA
    #[account(mut, del, seeds = [FEED_SEED, LAZER_SEED, lazer_feed_id.as_bytes()], bump)]
    pub feed: UncheckedAccount<'info>,
}
