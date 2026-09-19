use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub version: u8,
    pub owner: Pubkey,
    pub session_key: Pubkey,
    pub session_expiry: i64,
    pub actions_left: u32,
    pub free_margin: u64,
    pub locked_margin: u64,
    pub nonce: u64,
    pub bump: u8,
}
