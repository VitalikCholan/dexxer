use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub version: u8,
    pub mint: Pubkey,
    pub vault_ata: Pubkey,
    pub capital_total: u64,
    pub protocol_liquidity: u64,
    pub locked_total: u64,
    pub fees_accrued: u64,
    pub insurance: u64,
    pub bad_debt_total: u64,
    pub last_commit_slot: u64,
    pub bump: u8,
}
