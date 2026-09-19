use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub admin: Pubkey,
    pub crank: Pubkey,
    pub paused: bool,
    pub oracle_program: Pubkey,
    pub tee_validator: Pubkey,
    pub dusdc_mint: Pubkey,
    pub disclosure_delay_slots: u64,
    pub bump: u8,
}
