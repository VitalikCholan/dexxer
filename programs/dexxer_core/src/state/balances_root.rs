use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use super::ROOT_LEAVES;

/// Public, delegated, committed with `Pool` every 5 min (spec §2.4.2).
/// Carries only keccak leaves — never a balance or owner in the clear.
///
/// `zero_copy` (controller ruling 5, week 3 task 5): a by-value Borsh
/// `Account<BalancesRoot>` — 2 KiB dominated by `leaves: [[u8; 32]; 64]` —
/// blew the SBF 4096-byte stack frame in both `InitBalancesRoot::try_accounts`
/// (912 B over) and the `init_balances_root` global dispatch handler (672 B
/// over), confirmed by a LiteSVM probe (`tests/litesvm/tests/root.rs`) that
/// faulted with "Access violation in stack frame 3" before this conversion —
/// `Box` at the call site cannot fix a by-value deserialize, only the
/// zero-copy accessor (`AccountLoader::load*`, no stack copy) does. Field
/// order below is `repr(C)`-significant and chosen so `bytemuck::Pod` needs no
/// padding holes: `root_slot` (8-byte aligned) first, then the leaf array
/// (1-byte aligned, any size), then the three `u8` scalars, then an explicit
/// 5-byte pad to round the struct to a multiple of 8. No consumer of the old
/// Borsh layout exists yet (Task 7 TS only hashes leaves; Task 9 decoders are
/// unwritten) — Task 9's brief must be updated to this `repr(C)` layout.
#[account(zero_copy)]
#[repr(C)]
pub struct BalancesRoot {
    /// Slot the current leaf set was computed for; every leaf is bound to it.
    pub root_slot: u64,
    pub leaves: [[u8; 32]; ROOT_LEAVES],
    pub version: u8,
    /// Real (non-padding) leaves written so far in the current cycle.
    pub filled: u8,
    pub bump: u8,
    _pad: [u8; 5],
}

impl BalancesRoot {
    /// `8` (Anchor discriminator) + `size_of::<Self>()` — `zero_copy` has no
    /// `InitSpace` derive (Borsh-only), so this is the `space` value every
    /// `init` context below passes directly.
    pub const SIZE: usize = 8 + std::mem::size_of::<BalancesRoot>();
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

    /// Golden vectors (Task 7, week 3): fixed inputs / fixed expected hex, so the
    /// TS client's `leaf`/`pad` (tests/er/lib/program.ts) can assert byte-for-byte
    /// agreement with this Rust implementation without spinning up a validator.
    /// Expected hex computed by running this test once and pasting its output —
    /// see `tests/er/lib/hashes.selftest.ts`.
    #[test]
    fn leaf_and_pad_golden_vectors() {
        let owner = Pubkey::new_from_array([3u8; 32]);
        let exit_salt = [4u8; 32];
        let leaf_hash = leaf(&owner, 42, &exit_salt, 99);
        let leaf_hex = leaf_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        println!("leaf_golden_vector hex: {leaf_hex}");

        let pad_hash = pad(&[5u8; 32], 7);
        let pad_hex = pad_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        println!("pad_golden_vector hex: {pad_hex}");
        assert_eq!(
            leaf_hex,
            "79107674f9ef863f98a85fdbc056ddf1121f71870dffb8628f206b6c82f31572",
            "keccak256 golden vector regressed — mirror any intentional change in tests/er/lib/hashes.selftest.ts"
        );
        assert_eq!(
            pad_hex,
            "ee5497d0b6b70660e0c594f242962c673db850a86ce614f3706820cf5b19dfb3",
            "keccak256 golden vector regressed — mirror any intentional change in tests/er/lib/hashes.selftest.ts"
        );
    }
}
