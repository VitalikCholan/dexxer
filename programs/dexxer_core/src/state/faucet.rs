use anchor_lang::prelude::*;

/// Daily-limited dUSDC faucet, one PDA per owner.
#[account]
#[derive(InitSpace)]
pub struct Faucet {
    pub version: u8,
    pub owner: Pubkey,
    pub day_start: i64,
    pub minted_today: u64,
    pub bump: u8,
}

/// 10,000 dUSDC/day (6 decimals).
pub const FAUCET_DAILY_LIMIT: u64 = 10_000_000_000;
