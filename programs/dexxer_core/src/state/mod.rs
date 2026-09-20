pub mod config;
pub mod disclosure;
pub mod faucet;
pub mod fee_escrow;
pub mod market;
pub mod market_risk;
pub mod permissions;
pub mod pool;
pub mod position;
pub mod user;
pub use config::*;
pub use disclosure::*;
pub use faucet::*;
pub use fee_escrow::*;
pub use market::*;
pub use market_risk::*;
pub use permissions::*;
pub use pool::*;
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
pub const SOL_SYMBOL: [u8; 8] = *b"SOL\0\0\0\0\0";
pub const PERMISSION_MEMBERS: usize = 3; // owner, session, crank
pub const MAX_CANDIDATES: usize = 16;

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
