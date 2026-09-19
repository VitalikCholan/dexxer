use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Side {
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum PositionState {
    Empty,
    Open,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CloseReason {
    User,
    Liquidated,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct ClosedRecord {
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
    pub salt: [u8; 32],
    pub nonce: u64,
    pub reveal_after_slot: u64,
    pub commitment_written: bool,
}

impl Default for ClosedRecord {
    fn default() -> Self {
        Self {
            market: Pubkey::default(),
            side: Side::Long,
            size: 0,
            entry: 0,
            exit: 0,
            pnl: 0,
            fees: 0,
            reason: CloseReason::User,
            opened_slot: 0,
            closed_slot: 0,
            salt: [0; 32],
            nonce: 0,
            reveal_after_slot: 0,
            commitment_written: false,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub version: u8,
    pub owner: Pubkey,
    pub market: Pubkey,
    pub state: PositionState,
    pub side: Side,
    pub size: u64,
    pub entry: u64,
    pub margin: u64,
    pub liq_price: u64,
    pub opened_slot: u64,
    pub liq_ticks: u8,
    pub closed: Option<ClosedRecord>,
    pub bump: u8,
}
