// programs/dexxer_core/src/math.rs
use crate::errors::MathError;

pub const PRICE_SCALE: u128 = 1_000_000;
pub const SIZE_SCALE: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Long, Short }

pub fn notional(_size: u64, _price: u64) -> Result<u64, MathError> { unimplemented!() }
pub fn upnl(_side: Side, _size: u64, _entry: u64, _mark: u64) -> Result<i64, MathError> { unimplemented!() }
pub fn fee(_notional: u64, _bps: u16) -> Result<u64, MathError> { unimplemented!() }
pub fn required_margin(_notional: u64, _imr_bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn equity(_margin: u64, _upnl: i64, _close_fee: u64) -> Result<i64, MathError> { unimplemented!() }
pub fn liq_price(_side: Side, _entry: u64, _size: u64, _margin: u64, _mmr_bps: u32) -> Result<u64, MathError> { unimplemented!() }
pub fn is_liquidatable(_equity: i64, _notional: u64, _mmr_bps: u32) -> bool { unimplemented!() }
pub fn vwap_entry(_old_size: u64, _old_entry: u64, _add_size: u64, _add_price: u64) -> Result<u64, MathError> { unimplemented!() }

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
    fn liquidatable_below_mmr() {
        let n = 1_500_000_000u64;
        assert!(is_liquidatable(74_999_999, n, 500));
        assert!(!is_liquidatable(75_000_000, n, 500));
    }

    #[test]
    fn vwap_two_equal_lots() { assert_eq!(vwap_entry(S, P, S, 160_000_000).unwrap(), 155_000_000); }

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
        fn fee_superadditive(a in 0u64..1_000_000_000_000, b in 0u64..1_000_000_000_000, bps in 0u16..1000) {
            prop_assert!(fee(a, bps).unwrap() + fee(b, bps).unwrap() >= fee(a + b, bps).unwrap());
        }
        #[test]
        fn upnl_antisymmetric(size in 1u64..1_000_000_000_000, entry in 1u64..1_000_000_000_000, mark in 1u64..1_000_000_000_000) {
            prop_assert_eq!(upnl(Side::Long, size, entry, mark).unwrap(), -upnl(Side::Short, size, entry, mark).unwrap());
        }
    }
}
