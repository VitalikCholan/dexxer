// programs/dexxer_core/src/math.rs
//
// Pure formulas only (spec §3.2, §4.4): notional, uPnL, fees, margin, liq_price,
// mark EMA, partial-close PnL. No Anchor types, no account reads, no policy.
// IMR/MMR checks, liquidation buckets and candidate selection live in `risk.rs`
// on top of these.
//
// All rate parameters are `u32` bps. Intermediates are `u128`, every step
// `checked_*`, rounding always in favour of the pool.
use crate::errors::MathError;

pub const PRICE_SCALE: u128 = 1_000_000;
pub const SIZE_SCALE: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Long, Short }

pub fn notional(_size: u64, _price: u64) -> Result<u64, MathError> { unimplemented!() }
pub fn upnl(_side: Side, _size: u64, _entry: u64, _mark: u64) -> Result<i64, MathError> { unimplemented!() }
pub fn fee(_notional: u64, _bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn required_margin(_notional: u64, _imr_bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn equity(_margin: u64, _upnl: i64, _close_fee: u64) -> Result<i64, MathError> { unimplemented!() }
/// `margin > notional` (leverage below 1x) has no liquidation price — `Err(InvalidInput)`.
pub fn liq_price(_side: Side, _entry: u64, _size: u64, _margin: u64, _mmr_bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn is_liquidatable(_equity: i64, _notional: u64, _mmr_bps: u32) -> bool { unimplemented!() }
pub fn vwap_entry(_old_size: u64, _old_entry: u64, _add_size: u64, _add_price: u64) -> Result<u64, MathError> { unimplemented!() }
/// Mark EMA over index (spec §3.4): `prev + alpha * (sample - prev)`, alpha in bps.
pub fn ema(_prev: u64, _sample: u64, _alpha_bps: u32) -> Result<u64, MathError> { unimplemented!() }
/// Realised PnL of a partial close: the share of the position's uPnL that
/// `size_close` out of `size_total` carries. Full close (`size_close == size_total`)
/// must equal `upnl(side, size_total, entry, exit)`.
pub fn decrease_pnl(_side: Side, _size_total: u64, _size_close: u64, _entry: u64, _exit: u64) -> Result<i64, MathError> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const P: u64 = 150_000_000;      // $150.000000
    const S: u64 = 10_000_000_000;   // 10 SOL

    #[test]
    fn notional_10_sol_at_150() { assert_eq!(notional(S, P).unwrap(), 1_500_000_000); } // $1500

    #[test]
    fn upnl_long_up_10pct() { assert_eq!(upnl(Side::Long, S, P, 165_000_000).unwrap(), 150_000_000); }
    #[test]
    fn upnl_short_up_10pct() { assert_eq!(upnl(Side::Short, S, P, 165_000_000).unwrap(), -150_000_000); }

    #[test]
    fn fee_rounds_up() { assert_eq!(fee(1_000_001, 6).unwrap(), 601); } // 1_000_001*6/10_000 = 600.0006 → 601

    #[test]
    fn required_margin_10x() { assert_eq!(required_margin(1_500_000_000, 1000).unwrap(), 150_000_000); }

    #[test]
    fn required_margin_rounds_up() {
        // 1_000_001 * 10% = 100_000.1 → 100_001
        assert_eq!(required_margin(1_000_001, 1000).unwrap(), 100_001);
    }

    #[test]
    fn equity_adds_upnl_subtracts_fee() {
        // margin 150 + upnl 150 - close fee 0.6 = 299.4 (all 1e6)
        assert_eq!(equity(150_000_000, 150_000_000, 600_000).unwrap(), 299_400_000);
    }

    #[test]
    fn equity_can_be_negative() {
        assert_eq!(equity(100, -250, 10).unwrap(), -160);
    }

    #[test]
    fn liq_price_long_10x_mmr5() {
        // entry 150, lev 10 → 1/lev = 0.10, mmr 0.05 → liq = 150 * (1 - 0.10 + 0.05) = 142.5
        assert_eq!(liq_price(Side::Long, P, S, 150_000_000, 500).unwrap(), 142_500_000);
    }
    #[test]
    fn liq_price_short_10x_mmr5() {
        assert_eq!(liq_price(Side::Short, P, S, 150_000_000, 500).unwrap(), 157_500_000);
    }

    #[test]
    fn liq_price_margin_above_notional_is_invalid() {
        // notional = 1500, margin = 2000 → leverage < 1x, no liquidation price exists
        assert_eq!(
            liq_price(Side::Long, P, S, 2_000_000_000, 500),
            Err(MathError::InvalidInput)
        );
    }

    #[test]
    fn liquidatable_below_mmr() {
        let n = 1_500_000_000u64;
        assert!(is_liquidatable(74_999_999, n, 500));
        assert!(!is_liquidatable(75_000_000, n, 500));
    }

    #[test]
    fn vwap_two_equal_lots() { assert_eq!(vwap_entry(S, P, S, 160_000_000).unwrap(), 155_000_000); }

    #[test]
    fn ema_half_alpha_is_midpoint() {
        // alpha 0.5: 100 + 0.5*(110 - 100) = 105
        assert_eq!(ema(100_000_000, 110_000_000, 5000).unwrap(), 105_000_000);
    }

    #[test]
    fn decrease_pnl_long_partial() {
        // long 10 SOL @ 150, close 4 SOL @ 165 → 4 * 15 = +60
        assert_eq!(decrease_pnl(Side::Long, S, 4_000_000_000, P, 165_000_000).unwrap(), 60_000_000);
    }
    #[test]
    fn decrease_pnl_short_partial() {
        assert_eq!(decrease_pnl(Side::Short, S, 4_000_000_000, P, 165_000_000).unwrap(), -60_000_000);
    }

    #[test]
    fn overflow_is_error() { assert_eq!(notional(u64::MAX, u64::MAX), Err(MathError::Overflow)); }

    proptest! {
        #[test]
        fn liq_long_below_entry_short_above(entry in 1_000_000u64..1_000_000_000_000, size in 1_000_000u64..1_000_000_000_000, lev_bps in 10_000u32..100_000) {
            let n = notional(size, entry).unwrap();
            let margin = (n as u128 * BPS / lev_bps as u128) as u64;
            prop_assume!(margin > 0);
            let l = liq_price(Side::Long, entry, size, margin, 500).unwrap();
            let s = liq_price(Side::Short, entry, size, margin, 500).unwrap();
            prop_assert!(l < entry && entry < s);
        }
        #[test]
        fn fee_round_up_subadditive(a in 0u64..1_000_000_000_000, b in 0u64..1_000_000_000_000, bps in 0u32..1000) {
            prop_assert!(fee(a, bps).unwrap() + fee(b, bps).unwrap() >= fee(a + b, bps).unwrap());
        }
        #[test]
        fn upnl_antisymmetric(size in 1u64..1_000_000_000_000, entry in 1u64..1_000_000_000_000, mark in 1u64..1_000_000_000_000) {
            prop_assert_eq!(upnl(Side::Long, size, entry, mark).unwrap(), -upnl(Side::Short, size, entry, mark).unwrap());
        }
        #[test]
        fn ema_fixed_point(x in 1u64..1_000_000_000_000, alpha_bps in 0u32..10_000) {
            prop_assert_eq!(ema(x, x, alpha_bps).unwrap(), x);
        }
        #[test]
        fn decrease_pnl_full_close_equals_upnl(size in 1u64..1_000_000_000_000, entry in 1u64..1_000_000_000_000, exit in 1u64..1_000_000_000_000) {
            prop_assert_eq!(decrease_pnl(Side::Long, size, size, entry, exit).unwrap(), upnl(Side::Long, size, entry, exit).unwrap());
            prop_assert_eq!(decrease_pnl(Side::Short, size, size, entry, exit).unwrap(), upnl(Side::Short, size, entry, exit).unwrap());
        }
    }
}
