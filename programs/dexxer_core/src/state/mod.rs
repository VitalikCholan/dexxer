pub mod balances_root;
pub mod config;
pub mod disclosure;
pub mod faucet;
pub mod fee_escrow;
pub mod market;
pub mod market_risk;
pub mod permissions;
pub mod pool;
pub mod pool_live;
pub mod position;
pub mod user;
pub use balances_root::*;
pub use config::*;
pub use disclosure::*;
pub use faucet::*;
pub use fee_escrow::*;
pub use market::*;
pub use market_risk::*;
pub use permissions::*;
pub use pool::*;
pub use pool_live::*;
pub use position::*;
pub use user::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const RISK_SEED: &[u8] = b"risk";
pub const POOL_SEED: &[u8] = b"pool";
pub const USER_SEED: &[u8] = b"user";
pub const POSITION_SEED: &[u8] = b"position";
pub const DQ_SEED: &[u8] = b"dq";
pub const FAUCET_SEED: &[u8] = b"faucet";
pub const MINT_AUTH_SEED: &[u8] = b"mint_auth";
pub const FEE_ESCROW_SEED: &[u8] = b"fee_escrow";
pub const COMMIT_SEED: &[u8] = b"commit";
pub const DISCLOSURE_SEED: &[u8] = b"disclosure";
pub const BALANCES_ROOT_SEED: &[u8] = b"balances_root";
pub const POOL_LIVE_SEED: &[u8] = b"pool_live";
/// Public `Pool` snapshot granularity: 100 dUSDC (6 decimals). Assets round down, liabilities round up (spec §2.5.1).
pub const SNAPSHOT_STEP: u64 = 100_000_000;
/// Fixed leaf count — hides the real user count (spec §2.4.2). Merkle upgrade when N > 64.
pub const ROOT_LEAVES: usize = 64;
/// UserAccounts per `set_balances_root` call (tx size / CU budget).
pub const ROOT_BATCH: usize = 16;
/// Post-commit actions per `commit_aggregate` bundle. Kept at 4 on purpose: M-C measured the
/// bridge cap at 28 PASS / 29 FAIL on a fresh account with a 5-account spike action (week 3,
/// Task 1); the real write_commitment/write_disclosure shape is heavier and was not re-probed.
pub const MAX_ACTIONS_PER_COMMIT: usize = 4;
/// `ActionArgs::new` default escrow index (magic-actions.md).
pub const ACTION_ESCROW_INDEX: u8 = 255;
pub const SOL_SYMBOL: [u8; 8] = *b"SOL\0\0\0\0\0";
pub const PERMISSION_MEMBERS: usize = 3; // owner, session, crank
pub const MAX_CANDIDATES: usize = 16;
// Week-2 Task 5 fix round 2 (controller ruling): guards against a sybil
// griefing the shared `FeeEscrow`'s commit budget via a `withdraw(1)`-per-tx
// drain loop — each `withdraw` call's commit CPI spends the same escrow
// `commit_aggregate` relies on for the spec-critical 5-min `Pool` commit.
/// Minimum `withdraw` amount (1 dUSDC, 6 decimals) — below this, `InvalidParams`.
pub const MIN_WITHDRAW: u64 = 1_000_000;
/// Minimum slots between successful `withdraw` calls for the same `UserAccount`.
pub const WITHDRAW_COOLDOWN_SLOTS: u64 = 300;

#[cfg(test)]
mod size_tests {
    use super::*;
    use anchor_lang::Space;
    use ephemeral_rollups_sdk::{
        access_control::structs::EphemeralPermission, ephemeral_accounts::rent,
    };

    // Rent::default(): 3480 lamports/byte-year x 2 years
    fn l1_rent(space: usize) -> u64 {
        ((space as u64) + 128) * 6960
    }

    #[test]
    fn print_sizes_for_spec_q3() {
        let u = 8 + UserAccount::INIT_SPACE;
        let p = 8 + Position::INIT_SPACE;
        let d = 8 + DisclosureQueue::INIT_SPACE;
        let m = 8 + Market::INIT_SPACE;
        let perm = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
        println!("UserAccount {u} B, Position {p} B, DisclosureQueue {d} B; L1 rent total {} lamports; ER permission prefund {perm} lamports x3",
            l1_rent(u) + l1_rent(p) + l1_rent(d));
        assert!(p < 400, "Position must stay under 400 B (spec §8 Q3)");
        assert!(d < 1300, "DisclosureQueue must stay under 1300 B");
        // Bound through a `let` (not the bare const expression) so clippy's
        // `assertions_on_constants` lint doesn't fire on a compile-time-true assert.
        assert!(m < 300, "Market must stay under 300 B");
    }
}
