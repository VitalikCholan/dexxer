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
    // Week-2 Task 5 fix round 2 (controller ruling): per-account withdraw
    // cooldown, guarding the shared `FeeEscrow`'s commit budget against a
    // sybil griefing a withdraw(1)-per-tx drain loop (see instructions/user.rs).
    pub last_withdraw_slot: u64,
    pub bump: u8,
}
