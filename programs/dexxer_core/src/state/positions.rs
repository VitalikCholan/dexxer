// programs/dexxer_core/src/state/positions.rs
//
// A trader's positions on every market, in ONE account (spec §2.9.1). The
// market lives in the slot's DATA, not in the account's address: a PDA seeded
// by market would put which markets a trader uses on L1, where nothing filters
// reads, and would need a new L1 account per trader for every new market.
// Here a new market costs the trader nothing — a free slot is already there.
//
// `zero_copy`, accessed only through `AccountLoader`: a by-value Borsh
// deserialization of 3.1 KiB overflows the SBF stack (the `BalancesRoot`
// lesson, week 3). Field order is `repr(C)`-significant and padded by hand so
// `bytemuck::Pod` needs no implicit padding.
use anchor_lang::prelude::*;

use crate::errors::DexxerError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Side {
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CloseReason {
    User,
    Liquidated,
}

impl Side {
    pub fn as_u8(self) -> u8 {
        match self {
            Side::Long => 0,
            Side::Short => 1,
        }
    }
    /// Only ever called on a byte this program wrote with `as_u8`.
    pub fn from_u8(v: u8) -> Self {
        if v == 1 {
            Side::Short
        } else {
            Side::Long
        }
    }
}

impl CloseReason {
    pub fn as_u8(self) -> u8 {
        match self {
            CloseReason::User => 0,
            CloseReason::Liquidated => 1,
        }
    }
}

pub const MAX_SLOTS: usize = 16;
pub const HISTORY_LEN: usize = 16;
pub const SLOT_EMPTY: u8 = 0;
pub const SLOT_OPEN: u8 = 1;

#[zero_copy]
#[repr(C)]
pub struct PositionSlot {
    pub market: Pubkey,
    pub size: u64,
    pub entry: u64,
    pub margin: u64,
    pub liq_price: u64,
    pub opened_slot: u64,
    /// Exact notional this position contributes to `MarketRisk.oi_long` /
    /// `oi_short` — the OI ledger moves only through this field, never through
    /// a recompute off the VWAP `entry` (double rounding can underflow).
    pub oi_notional: u64,
    /// `Market.mark_slot` of the last price sample that counted toward
    /// `liq_ticks` (risk #38): one sample, one tick.
    pub last_liq_mark_slot: u64,
    pub state: u8,
    pub side: u8,
    pub liq_ticks: u8,
    pub _pad: [u8; 5],
}

impl PositionSlot {
    pub fn is_open(&self) -> bool {
        self.state == SLOT_OPEN
    }
    pub fn side(&self) -> Side {
        Side::from_u8(self.side)
    }
}

/// One closed trade, kept only for the owner's own History screen. Private
/// (the account is permissioned `[owner, session, crank]`), overwritten in a
/// ring, and scrubbed before the account ever leaves the ER.
#[zero_copy]
#[repr(C)]
pub struct HistoryRecord {
    pub market: Pubkey,
    pub size: u64,
    pub entry: u64,
    pub exit: u64,
    pub pnl: i64,
    pub fees: u64,
    pub opened_slot: u64,
    pub closed_slot: u64,
    pub side: u8,
    pub reason: u8,
    pub _pad: [u8; 6],
}

#[account(zero_copy)]
#[repr(C)]
pub struct Positions {
    pub owner: Pubkey,
    pub slots: [PositionSlot; MAX_SLOTS],
    pub history: [HistoryRecord; HISTORY_LEN],
    /// Index the NEXT record is written to.
    pub history_head: u8,
    pub history_len: u8,
    pub version: u8,
    pub bump: u8,
    pub _pad: [u8; 4],
    pub _reserved: [u8; 64],
}

impl Positions {
    pub const SPACE: usize = 8 + core::mem::size_of::<Positions>();

    /// The open position on `market`, if any. `state` is checked first, so an
    /// all-zero slot can never match the zero key.
    pub fn find_open(&self, market: &Pubkey) -> Option<usize> {
        self.slots
            .iter()
            .position(|s| s.is_open() && s.market == *market)
    }

    pub fn open_index(&self, market: &Pubkey) -> Result<usize> {
        self.find_open(market)
            .ok_or_else(|| error!(DexxerError::PositionNotOpen))
    }

    /// Slot for a NEW position on `market`: one position per market, first
    /// empty slot. The caller fills the slot; this only picks it.
    pub fn alloc(&mut self, market: &Pubkey) -> Result<usize> {
        require!(
            self.find_open(market).is_none(),
            DexxerError::PositionNotEmpty
        );
        self.slots
            .iter()
            .position(|s| !s.is_open())
            .ok_or_else(|| error!(DexxerError::NoFreeSlot))
    }

    /// Every byte back to zero, `market` included: an emptied slot must show
    /// the owner's client no phantom trade and carry nothing out of the ER.
    pub fn clear_slot(&mut self, idx: usize) {
        self.slots[idx] = bytemuck::Zeroable::zeroed();
    }

    pub fn open_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_open()).count()
    }

    /// Infallible by design: a full ring overwrites its oldest record, so a
    /// close or a liquidation can never be blocked by history.
    pub fn push_history(&mut self, rec: HistoryRecord) {
        let head = self.history_head as usize % HISTORY_LEN;
        self.history[head] = rec;
        self.history_head = ((head + 1) % HISTORY_LEN) as u8;
        if (self.history_len as usize) < HISTORY_LEN {
            self.history_len += 1;
        }
    }

    pub fn scrub_history(&mut self) {
        self.history = bytemuck::Zeroable::zeroed();
        self.history_head = 0;
        self.history_len = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::DexxerError;
    use crate::state::liq_task_id;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }
    fn blank() -> Positions {
        bytemuck::Zeroable::zeroed()
    }
    fn is(err: anchor_lang::error::Error, want: DexxerError) -> bool {
        err == anchor_lang::error::Error::from(want)
    }

    #[test]
    fn layout_is_exactly_the_spec() {
        assert_eq!(core::mem::size_of::<PositionSlot>(), 96);
        assert_eq!(core::mem::size_of::<HistoryRecord>(), 96);
        assert_eq!(core::mem::size_of::<Positions>(), 3176);
        assert_eq!(Positions::SPACE, 3184);
    }

    #[test]
    fn alloc_takes_the_first_empty_slot_and_refuses_a_second_position_on_a_market() {
        let mut p = blank();
        assert_eq!(p.alloc(&key(1)).unwrap(), 0);
        p.slots[0].state = SLOT_OPEN;
        p.slots[0].market = key(1);
        assert_eq!(p.alloc(&key(2)).unwrap(), 1);
        assert!(is(
            p.alloc(&key(1)).unwrap_err(),
            DexxerError::PositionNotEmpty
        ));
    }

    #[test]
    fn a_seventeenth_market_gets_no_free_slot() {
        let mut p = blank();
        for i in 0..MAX_SLOTS {
            let idx = p.alloc(&key(i as u8 + 1)).unwrap();
            p.slots[idx].state = SLOT_OPEN;
            p.slots[idx].market = key(i as u8 + 1);
        }
        assert_eq!(p.open_count(), MAX_SLOTS);
        assert!(is(p.alloc(&key(99)).unwrap_err(), DexxerError::NoFreeSlot));
    }

    #[test]
    fn find_open_ignores_empty_slots_and_other_markets() {
        let mut p = blank();
        p.slots[3].state = SLOT_OPEN;
        p.slots[3].market = key(7);
        assert_eq!(p.find_open(&key(7)), Some(3));
        assert_eq!(p.find_open(&key(8)), None);
        // An all-zero slot must never match the zero key.
        assert_eq!(p.find_open(&Pubkey::default()), None);
        assert!(is(
            p.open_index(&key(8)).unwrap_err(),
            DexxerError::PositionNotOpen
        ));
    }

    #[test]
    fn clear_slot_zeroes_every_byte_and_frees_it() {
        let mut p = blank();
        p.slots[2] = PositionSlot {
            market: key(5),
            size: 1,
            entry: 2,
            margin: 3,
            liq_price: 4,
            opened_slot: 5,
            oi_notional: 6,
            last_liq_mark_slot: 7,
            state: SLOT_OPEN,
            side: 1,
            liq_ticks: 2,
            _pad: [0; 5],
        };
        p.clear_slot(2);
        assert_eq!(bytemuck::bytes_of(&p.slots[2]), &[0u8; 96][..]);
        assert_eq!(p.alloc(&key(5)).unwrap(), 0);
    }

    fn rec(n: u64) -> HistoryRecord {
        HistoryRecord {
            closed_slot: n,
            ..bytemuck::Zeroable::zeroed()
        }
    }

    #[test]
    fn history_overwrites_the_oldest_record_on_the_seventeenth_push() {
        let mut p = blank();
        for n in 1..=16 {
            p.push_history(rec(n));
        }
        assert_eq!(p.history_len as usize, HISTORY_LEN);
        assert_eq!(p.history[0].closed_slot, 1);
        p.push_history(rec(17));
        assert_eq!(p.history_len as usize, HISTORY_LEN, "len saturates");
        assert_eq!(
            p.history[0].closed_slot, 17,
            "slot of the oldest record is reused"
        );
        assert_eq!(p.history[1].closed_slot, 2);
        assert_eq!(p.history_head, 1, "head = next write index");
    }

    #[test]
    fn scrub_history_leaves_no_byte_behind() {
        let mut p = blank();
        for n in 1..=5 {
            p.push_history(rec(n));
        }
        p.scrub_history();
        assert_eq!(p.history_head, 0);
        assert_eq!(p.history_len, 0);
        assert!(bytemuck::bytes_of(&p.history).iter().all(|b| *b == 0));
    }

    #[test]
    fn liq_task_id_is_per_market() {
        let pos = key(9);
        assert_eq!(liq_task_id(&pos, &key(1)), liq_task_id(&pos, &key(1)));
        assert_ne!(liq_task_id(&pos, &key(1)), liq_task_id(&pos, &key(2)));
        assert_ne!(liq_task_id(&pos, &key(1)), liq_task_id(&key(8), &key(1)));
    }
}
