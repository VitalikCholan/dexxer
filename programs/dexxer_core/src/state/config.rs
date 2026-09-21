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
    /// Signer of scheduled Magic Actions crank ticks, initialized once at
    /// `init_config` time. Week-2 Task 1 M1: on devnet-tee this is the TEE
    /// validator identity (`ER_VALIDATOR`), not the SDK's
    /// `magicblock_magic_program_api::pda::CRANK_SIGNER` PDA — `crank_tick`'s
    /// signer constraint also accepts that PDA as a fallback branch.
    pub scheduler_signer: Pubkey,
    /// Pays for scheduled crank transactions on the ER.
    pub fee_payer: Pubkey,
    /// Magic Program fee vault funding the crank schedule.
    pub magic_fee_vault: Pubkey,
    /// Magic Actions scheduled-task id for the crank. Always `0` on-chain as
    /// of task-6 fix round 3: `Config` is never delegated to the ER, and
    /// `schedule_crank`/`cancel_crank` must keep `config` strictly read-only
    /// in their Magic Program CPI (a writable, non-delegated account there
    /// is rejected — `TransactionError::InvalidWritableAccount`, see
    /// `instructions/crank.rs`'s `ScheduleCrank.config` doc comment), so
    /// neither instruction can write this field. Left in place (not
    /// removed, to avoid an account-layout migration) as a documented
    /// vestigial field; the real task_id lives only in `schedule_crank`'s
    /// logs and its caller's own records, and `cancel_crank` now takes
    /// `task_id` as an explicit argument instead of reading this field.
    pub crank_task_id: i64,
    pub bump: u8,
}
