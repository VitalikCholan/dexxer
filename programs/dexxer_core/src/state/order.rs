//! Conditional orders (Limit / Stop / Take-profit / Stop-loss / Trailing stop).
//!
//! Orders live in `Position.orders`, a fixed array of slots, so they inherit
//! the position's privacy model for free: the account is a delegated PDA with
//! an `EphemeralPermission { owner, session, crank }`, which means nobody but
//! the owner (and the crank) can read what a trader is waiting for. There is
//! no separate order account to onboard, delegate or permission.
//!
//! Orders are executed by the per-position scheduled task that already runs
//! `liquidation_check` — see `instructions/liquidation.rs::run_orders`. Every
//! trigger is evaluated against `Market.mark`, the same price liquidations use.
use super::position::Side;
use crate::errors::MathError;
use anchor_lang::prelude::*;

/// Order slots per position. Small on purpose: an order costs account space in
/// the ER and a few thousand CU on every scheduled tick.
pub const ORDER_SLOTS: usize = 4;
/// Trailing distance bounds, in basis points of the extreme price.
pub const MIN_TRAIL_BPS: u16 = 10;
pub const MAX_TRAIL_BPS: u16 = 5_000;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum OrderKind {
    /// Empty slot.
    #[default]
    None,
    /// Open a position when mark moves to the trigger from the unfavourable
    /// side: long buys at or below it, short sells at or above it.
    Limit,
    /// Open a position when mark breaks through the trigger: long buys at or
    /// above it, short sells at or below it.
    Stop,
    /// Close the position in profit (reduce-only).
    TakeProfit,
    /// Close the position at a loss (reduce-only).
    StopLoss,
    /// Stop-loss whose trigger follows the best price seen (reduce-only).
    TrailingStop,
}

impl OrderKind {
    pub fn is_entry(self) -> bool {
        matches!(self, OrderKind::Limit | OrderKind::Stop)
    }
    pub fn is_reduce_only(self) -> bool {
        matches!(
            self,
            OrderKind::TakeProfit | OrderKind::StopLoss | OrderKind::TrailingStop
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Order {
    pub kind: OrderKind,
    /// Entry orders: the side to open. Reduce-only orders: the side of the
    /// position they protect (copied from it at placement).
    pub side: Side,
    /// Trigger price (mark units). Unused (0) for `TrailingStop`.
    pub trigger: u64,
    /// Entry orders only.
    pub size: u64,
    pub margin: u64,
    /// `TrailingStop` only: distance from `extreme`, in bps.
    pub trail_bps: u16,
    /// `TrailingStop` only: best mark seen since placement (highest for a
    /// long, lowest for a short).
    pub extreme: u64,
    /// Entry orders only: take-profit / stop-loss to attach on fill (0 = none).
    pub tp: u64,
    pub sl: u64,
}

impl Default for Order {
    fn default() -> Self {
        Self {
            kind: OrderKind::None,
            side: Side::Long,
            trigger: 0,
            size: 0,
            margin: 0,
            trail_bps: 0,
            extreme: 0,
            tp: 0,
            sl: 0,
        }
    }
}

impl Order {
    pub fn is_empty(&self) -> bool {
        self.kind == OrderKind::None
    }
}

/// Current stop level of a trailing order, rounded so the trader is never
/// stopped out earlier than the configured distance.
pub fn trailing_stop_price(
    side: Side,
    extreme: u64,
    trail_bps: u16,
) -> std::result::Result<u64, MathError> {
    let e = extreme as u128;
    let t = trail_bps as u128;
    let v = match side {
        Side::Long => e * (10_000 - t) / 10_000,
        Side::Short => (e * (10_000 + t)).div_ceil(10_000),
    };
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// Move a trailing order's extreme with the mark. Returns the new extreme.
pub fn trail_extreme(side: Side, extreme: u64, mark: u64) -> u64 {
    match side {
        Side::Long => extreme.max(mark),
        Side::Short => {
            if extreme == 0 {
                mark
            } else {
                extreme.min(mark)
            }
        }
    }
}

/// Does `mark` satisfy this order's trigger? For `TrailingStop` the caller
/// passes the already-computed stop level as `trigger`.
pub fn is_triggered(kind: OrderKind, side: Side, trigger: u64, mark: u64) -> bool {
    match (kind, side) {
        (OrderKind::Limit, Side::Long) => mark <= trigger,
        (OrderKind::Limit, Side::Short) => mark >= trigger,
        (OrderKind::Stop, Side::Long) => mark >= trigger,
        (OrderKind::Stop, Side::Short) => mark <= trigger,
        (OrderKind::TakeProfit, Side::Long) => mark >= trigger,
        (OrderKind::TakeProfit, Side::Short) => mark <= trigger,
        (OrderKind::StopLoss | OrderKind::TrailingStop, Side::Long) => mark <= trigger,
        (OrderKind::StopLoss | OrderKind::TrailingStop, Side::Short) => mark >= trigger,
        (OrderKind::None, _) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_and_stop_are_mirror_images() {
        assert!(is_triggered(OrderKind::Limit, Side::Long, 100, 99));
        assert!(!is_triggered(OrderKind::Limit, Side::Long, 100, 101));
        assert!(is_triggered(OrderKind::Stop, Side::Long, 100, 101));
        assert!(!is_triggered(OrderKind::Stop, Side::Long, 100, 99));
        assert!(is_triggered(OrderKind::Limit, Side::Short, 100, 101));
        assert!(is_triggered(OrderKind::Stop, Side::Short, 100, 99));
    }

    #[test]
    fn tp_sl_directions() {
        assert!(is_triggered(OrderKind::TakeProfit, Side::Long, 110, 110));
        assert!(!is_triggered(OrderKind::TakeProfit, Side::Long, 110, 109));
        assert!(is_triggered(OrderKind::StopLoss, Side::Long, 90, 90));
        assert!(!is_triggered(OrderKind::StopLoss, Side::Long, 90, 91));
        assert!(is_triggered(OrderKind::TakeProfit, Side::Short, 90, 90));
        assert!(is_triggered(OrderKind::StopLoss, Side::Short, 110, 110));
        assert!(!is_triggered(OrderKind::None, Side::Long, 0, 0));
    }

    #[test]
    fn trailing_follows_extreme_only_in_favourable_direction() {
        assert_eq!(trail_extreme(Side::Long, 100, 120), 120);
        assert_eq!(trail_extreme(Side::Long, 120, 110), 120);
        assert_eq!(trail_extreme(Side::Short, 100, 80), 80);
        assert_eq!(trail_extreme(Side::Short, 80, 90), 80);
        assert_eq!(trail_extreme(Side::Short, 0, 90), 90);
    }

    #[test]
    fn trailing_stop_price_rounding() {
        // 5% below / above
        assert_eq!(trailing_stop_price(Side::Long, 200, 500).unwrap(), 190);
        assert_eq!(trailing_stop_price(Side::Short, 200, 500).unwrap(), 210);
        // rounding: long floors, short ceils
        assert_eq!(trailing_stop_price(Side::Long, 101, 500).unwrap(), 95);
        assert_eq!(trailing_stop_price(Side::Short, 101, 500).unwrap(), 107);
    }
}
