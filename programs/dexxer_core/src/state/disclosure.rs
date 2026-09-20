use anchor_lang::prelude::*;

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

#[account]
#[derive(InitSpace)]
pub struct DisclosureCommitment {
    pub hash: [u8; 32],
    pub batch_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Disclosure {
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
}
