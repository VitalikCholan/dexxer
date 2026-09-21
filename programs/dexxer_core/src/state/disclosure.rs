use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use super::{CloseReason, ClosedRecord, Side};

pub const DQ_CAPACITY: usize = 8;

#[account]
#[derive(InitSpace)]
pub struct DisclosureQueue {
    pub version: u8,
    pub owner: Pubkey,
    pub head: u8,
    pub len: u8,
    pub records: [ClosedRecord; DQ_CAPACITY],
    pub bump: u8,
}

/// L1 `[b"commit", nonce]` — written by the `write_commitment` Magic Action on the Pool commit.
#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub version: u8,
    pub hash: [u8; 32],
    pub slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Disclosure {
    pub version: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub size: u64,
    pub entry: u64,
    pub exit: u64,
    pub pnl: i64,
    pub fees: u64,
    pub reason: CloseReason,
    pub opened_slot: u64,
    pub closed_slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

/// Public fields of a closed trade — the `write_disclosure` instruction argument
/// and the on-chain `Disclosure` body. Deliberately excludes `salt` (argument on
/// its own) and `commitment_written` (mutable bookkeeping) — see `commitment_hash`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct DisclosureArgs {
    pub market: Pubkey,
    pub side: Side,
    pub size: u64,
    pub entry: u64,
    pub exit: u64,
    pub pnl: i64,
    pub fees: u64,
    pub reason: CloseReason,
    pub opened_slot: u64,
    pub closed_slot: u64,
    pub nonce: u64,
    pub reveal_after_slot: u64,
}

impl From<&ClosedRecord> for DisclosureArgs {
    fn from(r: &ClosedRecord) -> Self {
        Self {
            market: r.market,
            side: r.side,
            size: r.size,
            entry: r.entry,
            exit: r.exit,
            pnl: r.pnl,
            fees: r.fees,
            reason: r.reason,
            opened_slot: r.opened_slot,
            closed_slot: r.closed_slot,
            nonce: r.nonce,
            reveal_after_slot: r.reveal_after_slot,
        }
    }
}

/// Canonical commitment: keccak over the fixed field order in Global Constraints, then `salt`.
pub fn commitment_hash(a: &DisclosureArgs, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[
        a.market.as_ref(),
        &[a.side as u8],
        &a.size.to_le_bytes(),
        &a.entry.to_le_bytes(),
        &a.exit.to_le_bytes(),
        &a.pnl.to_le_bytes(),
        &a.fees.to_le_bytes(),
        &[a.reason as u8],
        &a.opened_slot.to_le_bytes(),
        &a.closed_slot.to_le_bytes(),
        &a.nonce.to_le_bytes(),
        &a.reveal_after_slot.to_le_bytes(),
        salt,
    ])
    .to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commitment_hash_ignores_written_flag_and_binds_salt() {
        let mut rec = ClosedRecord {
            nonce: 5,
            salt: [3u8; 32],
            ..ClosedRecord::default()
        };
        let a = DisclosureArgs::from(&rec);
        let h1 = commitment_hash(&a, &rec.salt);
        rec.commitment_written = true;
        assert_eq!(
            h1,
            commitment_hash(&DisclosureArgs::from(&rec), &rec.salt),
            "flag must not affect hash"
        );
        assert_ne!(h1, commitment_hash(&a, &[4u8; 32]), "salt must affect hash");
    }
}
