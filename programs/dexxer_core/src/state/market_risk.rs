use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct MarketRisk {
    pub version: u8,
    pub market: Pubkey,
    pub oi_long: u64,
    pub oi_short: u64,
    pub open_positions: u32,
    pub bump: u8,
}
