use anchor_lang::prelude::*;

/// Layout version of `UserAccount`. Bumped to 3 by the slots plan Task 7
/// (`rent_payer` + `_reserved`). Bumped to 2 by week-5 Task 2, which
/// appended `exited`. A v1 account (one byte shorter) can no longer be
/// deserialized into this struct at all — `crank_tick` skips such a candidate
/// instead of aborting its batch, and the app offers re-onboarding. No read
/// path asserts this value; it is written on (re-)initialization and carried
/// for off-chain readers.
pub const USER_ACCOUNT_VERSION: u8 = 3;

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
    // Week-2 Task 5 fix round 2 (controller ruling): per-account withdraw
    // cooldown, guarding the shared `FeeEscrow`'s commit budget against a
    // sybil griefing a withdraw(1)-per-tx drain loop (see instructions/user.rs).
    pub last_withdraw_slot: u64,
    /// Week 3 (spec §2.4.2): per-user secret that salts this account's leaf in
    /// the public `BalancesRoot`. Supplied by the client at `init_user`; lives
    /// only in this private account, so nobody can brute-force `free_margin`
    /// from the published leaf hash.
    pub exit_salt: [u8; 32],
    pub bump: u8,
    /// Week-5 Task 2 (spec §2.6.3): set by `undelegate_user`. Marks an account
    /// that has left the ER and is sitting scrubbed and dormant on L1 — the
    /// gate for `close_exited_user` (and against re-delegating it in
    /// `delegate_user`).
    pub exited: bool,
    /// Who funded this owner's rent at `init_user` — `Config.fee_payer` for a
    /// sponsored onboarding, the owner for a self-funded one. `close_exited_user`
    /// returns the lamports here, not to whoever signs the close (risk #39).
    pub rent_payer: Pubkey,
    pub _reserved: [u8; 32],
}
