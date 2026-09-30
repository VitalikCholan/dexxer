use anchor_lang::prelude::Pubkey;

pub mod balances_root;
pub mod config;
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
pub const FAUCET_SEED: &[u8] = b"faucet";
pub const MINT_AUTH_SEED: &[u8] = b"mint_auth";
pub const FEE_ESCROW_SEED: &[u8] = b"fee_escrow";
pub const BALANCES_ROOT_SEED: &[u8] = b"balances_root";
pub const POOL_LIVE_SEED: &[u8] = b"pool_live";
/// Public `Pool` snapshot granularity: 100 dUSDC (6 decimals). Assets round down, liabilities round up (spec §2.5.1).
pub const SNAPSHOT_STEP: u64 = 100_000_000;
/// Fixed leaf count — hides the real user count (spec §2.4.2). Merkle upgrade when N > 64.
pub const ROOT_LEAVES: usize = 64;
/// UserAccounts per `set_balances_root` call (tx size / CU budget).
pub const ROOT_BATCH: usize = 16;
pub const SOL_SYMBOL: [u8; 8] = *b"SOL\0\0\0\0\0";
pub const PERMISSION_MEMBERS: usize = 3; // owner, session, crank
/// Upper bound on `crank_tick` candidates the PROGRAM accepts in one call.
///
/// A candidate is a `[Position, UserAccount]` pair (week-6 slots Task 1; it
/// was a triple with the `DisclosureQueue` before trade disclosure was
/// removed). The client-side legacy-transaction chunk size
/// (`CRANK_TX_MAX_CANDIDATES` in `services/relayer/src/crank.ts`) was measured
/// on triples and is not re-measured here; the program cap stays 16 so a v0
/// transaction with an address-lookup table can use the whole budget.
pub const MAX_CANDIDATES: usize = 16;
// Week-2 Task 5 fix round 2 (controller ruling): guards against a sybil
// griefing the shared `FeeEscrow`'s commit budget via a `withdraw(1)`-per-tx
// drain loop — each `withdraw` call's commit CPI spends the same escrow
// `commit_aggregate` relies on for the spec-critical 5-min `Pool` commit.
/// Minimum `withdraw` amount (1 dUSDC, 6 decimals) — below this, `InvalidParams`.
pub const MIN_WITHDRAW: u64 = 1_000_000;
/// Minimum slots between successful `withdraw` calls for the same `UserAccount`.
pub const WITHDRAW_COOLDOWN_SLOTS: u64 = 300;

// ------------------------------------------------------------- week-5 Task 3
/// How often the per-position Magic Actions task calls `liquidation_check`.
///
/// 5 s, not the market crank's 1 s: the scheduler was measured to overshoot
/// the requested interval (16 ticks per 60 s at `interval 5000` — week-5
/// Task 0, measurement 1), and every position carries its own task, so the
/// tick rate is multiplied by the number of open positions. `liq_ticks`
/// hysteresis is counted in TICKS, not wall time, which means the same
/// `Market.liq_hysteresis_ticks` is ~3 s of grace on the crank path and ~11 s
/// on this one. That is deliberate and this constant is NOT adjusted for it:
/// the scheduled path is the backstop, the crank is the fast path, and a
/// backstop that fires later is the safe direction.
///
/// What DID have to be adjusted is the tick budget itself: both callers share
/// one `Position.liq_ticks`, so the default `liq_hysteresis_ticks` went 2 -> 3
/// to keep the gate spanning more than one distinct mark sample — the full
/// reasoning is on `liq_due` in `instructions/liquidation.rs`.
pub const LIQ_TASK_INTERVAL_MS: i64 = 5_000;

/// Magic Actions `task_id` for one position's liquidation task.
///
/// `task_id` is VALIDATOR-GLOBAL, not per-program (week-5 Task 0, open item
/// 1), so it must be derived from something globally unique to this position —
/// its own PDA. keccak256 is the project's hash primitive everywhere else
/// (week-3 rule), and the first 8 bytes are plenty: a collision would need two
/// positions whose PDAs share a 64-bit keccak prefix.
pub fn liq_task_id(position: &Pubkey) -> i64 {
    let h = solana_keccak_hasher::hashv(&[position.as_ref()]).to_bytes();
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[..8]);
    i64::from_le_bytes(b)
}

#[cfg(test)]
mod liq_task_tests {
    use super::*;

    #[test]
    fn liq_task_id_is_deterministic_and_position_specific() {
        let a = Pubkey::new_from_array([7u8; 32]);
        let b = Pubkey::new_from_array([8u8; 32]);
        assert_eq!(liq_task_id(&a), liq_task_id(&a), "same input, same id");
        assert_ne!(liq_task_id(&a), liq_task_id(&b));
    }

    /// Golden vector — pins the byte layout (keccak256 of the raw 32 pubkey
    /// bytes, first 8 bytes read little-endian) so a client that recomputes
    /// the id off-chain can be checked against the same number.
    #[test]
    fn liq_task_id_golden_vector() {
        let p = Pubkey::new_from_array([0u8; 32]);
        let h = solana_keccak_hasher::hashv(&[p.as_ref()]).to_bytes();
        let expected = i64::from_le_bytes(h[..8].try_into().unwrap());
        assert_eq!(liq_task_id(&p), expected);
        // keccak256(32 zero bytes) = 290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563
        assert_eq!(&h[..8], &[0x29, 0x0d, 0xec, 0xd9, 0x54, 0x8b, 0x62, 0xa8]);
        assert_eq!(
            liq_task_id(&p),
            i64::from_le_bytes([0x29, 0x0d, 0xec, 0xd9, 0x54, 0x8b, 0x62, 0xa8])
        );
    }
}

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
        let m = 8 + Market::INIT_SPACE;
        let perm = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
        println!("UserAccount {u} B, Position {p} B; L1 rent total {} lamports; ER permission prefund {perm} lamports x2",
            l1_rent(u) + l1_rent(p));
        assert!(p < 400, "Position must stay under 400 B (spec §8 Q3)");
        // Bound through a `let` (not the bare const expression) so clippy's
        // `assertions_on_constants` lint doesn't fire on a compile-time-true assert.
        assert!(m < 300, "Market must stay under 300 B");
    }
}
