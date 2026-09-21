use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use super::ROOT_LEAVES;

/// Public, delegated, committed with `Pool` every 5 min (spec §2.4.2).
/// Carries only keccak leaves — never a balance or owner in the clear.
#[account]
#[derive(InitSpace)]
pub struct BalancesRoot {
    pub version: u8,
    /// Slot the current leaf set was computed for; every leaf is bound to it.
    pub root_slot: u64,
    /// Real (non-padding) leaves written so far in the current cycle.
    pub filled: u8,
    pub leaves: [[u8; 32]; ROOT_LEAVES],
    pub bump: u8,
}

/// `keccak(owner ‖ free_margin ‖ exit_salt ‖ root_slot)` — spec §2.4.2 / Global Constraints.
pub fn leaf(owner: &Pubkey, free_margin: u64, exit_salt: &[u8; 32], root_slot: u64) -> [u8; 32] {
    hashv(&[
        owner.as_ref(),
        &free_margin.to_le_bytes(),
        exit_salt,
        &root_slot.to_le_bytes(),
    ])
    .to_bytes()
}

/// Padding leaf for unused slot `i`; `seed` is never stored on-chain, so padding
/// is indistinguishable from real leaves to an outside observer.
pub fn pad(seed: &[u8; 32], i: u8) -> [u8; 32] {
    hashv(&[seed, &[i]]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leaf_is_deterministic_and_slot_bound() {
        let o = Pubkey::new_unique();
        let s = [7u8; 32];
        assert_eq!(leaf(&o, 1_000, &s, 10), leaf(&o, 1_000, &s, 10));
        assert_ne!(
            leaf(&o, 1_000, &s, 10),
            leaf(&o, 1_000, &s, 11),
            "slot binding"
        );
        assert_ne!(
            leaf(&o, 1_000, &s, 10),
            leaf(&o, 1_001, &s, 10),
            "balance binding"
        );
        assert_ne!(
            leaf(&o, 1_000, &s, 10),
            leaf(&o, 1_000, &[8u8; 32], 10),
            "salt binding"
        );
    }
    #[test]
    fn pad_differs_per_index_and_seed() {
        let a = [1u8; 32];
        assert_ne!(pad(&a, 0), pad(&a, 1));
        assert_ne!(pad(&a, 0), pad(&[2u8; 32], 0));
    }
}
