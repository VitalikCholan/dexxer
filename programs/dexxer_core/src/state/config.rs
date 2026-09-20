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
    // Week 2 (spec §8 Q2, controller ruling task-2 #1): scheduler/fee-payer/
    // fee-vault identities and the crank's Magic Actions task id, all
    // consumed by later tasks' instructions. Layout freezes here.
    /// The Magic Program's crank-signer PDA (`magicblock_magic_program_api::pda::CRANK_SIGNER`),
    /// initialized once at `init_config` time.
    pub scheduler_signer: Pubkey,
    /// Pays for scheduled crank transactions on the ER.
    pub fee_payer: Pubkey,
    /// Magic Program fee vault funding the crank schedule.
    pub magic_fee_vault: Pubkey,
    /// Magic Actions scheduled-task id for the crank, set once registered.
    pub crank_task_id: i64,
    pub bump: u8,
}
