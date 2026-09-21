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
    /// Signer of scheduled Magic Actions crank ticks — read directly by
    /// `crank_tick`'s own signer constraint (its `config.scheduler_signer`
    /// branch) and by `schedule_crank` (which embeds it, read-only, as the
    /// scheduled instruction's signer meta). Must equal
    /// `crank_signer_pda(Config.admin)` — the Magic Program's per-authority
    /// crank-executor PDA (see `tests/er/lib/crank-signer.ts` for the
    /// derivation and its pinned validator source) — for scheduled ticks to
    /// actually execute; `init_config` seeds it with that value directly for
    /// a fresh bootstrap, and `set_scheduler_signer` (task-6 fix round 3,
    /// `instructions/admin.rs`) updates it later for an existing `Config`.
    /// `set_scheduler_signer` is a plain base-layer admin write — unlike
    /// `schedule_crank`, which can never write any `Config` field itself
    /// (see `instructions/crank.rs`'s `ScheduleCrank.config` doc comment for
    /// why: a writable, non-delegated account is unconditionally rejected in
    /// `ScheduleCrankCpi`'s `instruction_accounts`, and `config` must be in
    /// that list).
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
