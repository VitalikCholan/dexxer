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
pub use crate::state::Side;

pub const PRICE_SCALE: u128 = 1_000_000;
pub const SIZE_SCALE: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;

fn div_ceil(a: u128, b: u128) -> Result<u128, MathError> {
    if b == 0 {
        return Err(MathError::DivisionByZero);
    }
    a.checked_add(b.checked_sub(1).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)
        .map(|x| x / b)
}
fn to_u64(x: u128) -> Result<u64, MathError> {
    u64::try_from(x).map_err(|_| MathError::Overflow)
}
fn to_i64(x: i128) -> Result<i64, MathError> {
    i64::try_from(x).map_err(|_| MathError::Overflow)
}

// Notional rounds up: larger notional means larger fees and requirements, in the pool's favour.
// (Test `notional_10_sol_at_150` divides evenly.)
pub fn notional(size: u64, price: u64) -> Result<u64, MathError> {
    let raw = (size as u128)
        .checked_mul(price as u128)
        .ok_or(MathError::Overflow)?;
    to_u64(div_ceil(raw, SIZE_SCALE)?)
}

pub fn upnl(side: Side, size: u64, entry: u64, mark: u64) -> Result<i64, MathError> {
    let diff: i128 = match side {
        Side::Long => (mark as i128)
            .checked_sub(entry as i128)
            .ok_or(MathError::Overflow)?,
        Side::Short => (entry as i128)
            .checked_sub(mark as i128)
            .ok_or(MathError::Overflow)?,
    };
    let raw = (size as i128)
        .checked_mul(diff)
        .ok_or(MathError::Overflow)?;
    // Pure formula: truncate toward zero so long/short stay antisymmetric; pool-favouring rounding is at settlement (fee subtracts) and position initialization (notional/fee round up).
    to_i64(raw / SIZE_SCALE as i128)
}

pub fn fee(notional: u64, bps: u32) -> Result<u64, MathError> {
    let raw = (notional as u128)
        .checked_mul(bps as u128)
        .ok_or(MathError::Overflow)?;
    to_u64(div_ceil(raw, BPS)?)
}

pub fn required_margin(notional: u64, imr_bps: u32) -> Result<u64, MathError> {
    fee(notional, imr_bps)
}

pub fn equity(margin: u64, upnl: i64, close_fee: u64) -> Result<i64, MathError> {
    to_i64(
        (margin as i128)
            .checked_add(upnl as i128)
            .ok_or(MathError::Overflow)?
            .checked_sub(close_fee as i128)
            .ok_or(MathError::Overflow)?,
    )
}

/// `margin > notional` (leverage below 1x) has no liquidation price — `Err(InvalidInput)`.
pub fn liq_price(
    side: Side,
    entry: u64,
    size: u64,
    margin: u64,
    mmr_bps: u32,
) -> Result<u64, MathError> {
    let n = notional(size, entry)? as u128;
    if n == 0 {
        return Err(MathError::DivisionByZero);
    }
    if (margin as u128) > n {
        return Err(MathError::InvalidInput);
    }
    // 1/lev_eff = margin / notional; liq_long = entry * (1 - margin/n + mmr); liq_short = entry * (1 + margin/n - mmr)
    // All in bps via u128: term = entry * (BPS*n - margin*BPS + mmr*n) / (BPS*n)
    let e = entry as u128;
    let m_bps = (margin as u128)
        .checked_mul(BPS)
        .ok_or(MathError::Overflow)?; // margin * BPS
    let mmr_n = (mmr_bps as u128)
        .checked_mul(n)
        .ok_or(MathError::Overflow)?; // mmr * n
    let base = BPS.checked_mul(n).ok_or(MathError::Overflow)?; // BPS * n
    let num = match side {
        Side::Long => base
            .checked_sub(m_bps)
            .ok_or(MathError::Overflow)?
            .checked_add(mmr_n)
            .ok_or(MathError::Overflow)?,
        Side::Short => base
            .checked_add(m_bps)
            .ok_or(MathError::Overflow)?
            .checked_sub(mmr_n)
            .ok_or(MathError::InvalidInput)?,
    };
    let raw = e.checked_mul(num).ok_or(MathError::Overflow)?;
    // Long: liquidation price higher (sooner) = ceil; short: lower (sooner) = floor — in the pool's favour.
    let out = match side {
        Side::Long => div_ceil(raw, base)?,
        Side::Short => raw / base,
    };
    to_u64(out)
}

pub fn is_liquidatable(equity: i64, notional: u64, mmr_bps: u32) -> bool {
    match fee(notional, mmr_bps) {
        Ok(req) => (equity as i128) < req as i128,
        Err(_) => true,
    }
}

pub fn vwap_entry(
    old_size: u64,
    old_entry: u64,
    add_size: u64,
    add_price: u64,
) -> Result<u64, MathError> {
    let total = (old_size as u128)
        .checked_add(add_size as u128)
        .ok_or(MathError::Overflow)?;
    if total == 0 {
        return Err(MathError::DivisionByZero);
    }
    let a = (old_size as u128)
        .checked_mul(old_entry as u128)
        .ok_or(MathError::Overflow)?;
    let b = (add_size as u128)
        .checked_mul(add_price as u128)
        .ok_or(MathError::Overflow)?;
    to_u64(div_ceil(
        a.checked_add(b).ok_or(MathError::Overflow)?,
        total,
    )?) // Entry rounds up — smaller uPnL for long; for short, policy in risk.rs (here: ceil always)
}

/// Mark EMA over index (spec §3.4): `prev + alpha * (sample - prev)`, alpha in bps.
pub fn ema(prev: u64, sample: u64, alpha_bps: u32) -> Result<u64, MathError> {
    if alpha_bps as u128 > BPS {
        return Err(MathError::InvalidInput);
    }
    let a = alpha_bps as u128;
    let raw = (prev as u128)
        .checked_mul(BPS.checked_sub(a).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?
        .checked_add((sample as u128).checked_mul(a).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?;
    to_u64(raw / BPS)
}

/// Realised PnL of a partial close: the share of the position's uPnL that
/// `size_close` out of `size_total` carries. Full close (`size_close == size_total`)
/// must equal `upnl(side, size_total, entry, exit)`.
pub fn decrease_pnl(
    side: Side,
    size_total: u64,
    size_close: u64,
    entry: u64,
    exit: u64,
) -> Result<i64, MathError> {
    if size_close > size_total {
        return Err(MathError::InvalidInput);
    }
    upnl(side, size_close, entry, exit)
}

/// Round down to a multiple of `step` (pool-favouring for assets in the public snapshot).
/// `step == 0` errors (division/remainder by zero).
pub fn floor_step(x: u64, step: u64) -> Result<u64, MathError> {
    let r = x.checked_rem(step).ok_or(MathError::Overflow)?;
    x.checked_sub(r).ok_or(MathError::Overflow)
}
/// Round up to a multiple of `step` (conservative for liabilities). Errors on overflow.
/// `step == 0` errors (division/remainder by zero).
pub fn ceil_step(x: u64, step: u64) -> Result<u64, MathError> {
    let r = x.checked_rem(step).ok_or(MathError::Overflow)?;
    if r == 0 {
        return Ok(x);
    }
    let pad = step.checked_sub(r).ok_or(MathError::Overflow)?;
    x.checked_add(pad).ok_or(MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const P: u64 = 150_000_000; // $150.000000
    const S: u64 = 10_000_000_000; // 10 SOL

    #[test]
    fn step_rounding() {
        const S: u64 = 100_000_000;
        assert_eq!(floor_step(0, S).unwrap(), 0);
        assert_eq!(floor_step(99_999_999, S).unwrap(), 0);
        assert_eq!(floor_step(250_000_000, S).unwrap(), 200_000_000);
        assert_eq!(ceil_step(0, S).unwrap(), 0);
        assert_eq!(ceil_step(1, S).unwrap(), 100_000_000);
        assert_eq!(ceil_step(200_000_000, S).unwrap(), 200_000_000);
        assert!(ceil_step(u64::MAX, S).is_err());
        assert!(floor_step(5, 0).is_err());
        assert!(ceil_step(5, 0).is_err());
    }

    #[test]
    fn notional_10_sol_at_150() {
        assert_eq!(notional(S, P).unwrap(), 1_500_000_000);
    } // $1500

    #[test]
    fn upnl_long_up_10pct() {
        assert_eq!(upnl(Side::Long, S, P, 165_000_000).unwrap(), 150_000_000);
    }
    #[test]
    fn upnl_short_up_10pct() {
        assert_eq!(upnl(Side::Short, S, P, 165_000_000).unwrap(), -150_000_000);
    }

    #[test]
    fn fee_rounds_up() {
        assert_eq!(fee(1_000_001, 6).unwrap(), 601);
    } // 1_000_001*6/10_000 = 600.0006 → 601

    #[test]
    fn required_margin_10x() {
        assert_eq!(required_margin(1_500_000_000, 1000).unwrap(), 150_000_000);
    }

    #[test]
    fn required_margin_rounds_up() {
        // 1_000_001 * 10% = 100_000.1 → 100_001
        assert_eq!(required_margin(1_000_001, 1000).unwrap(), 100_001);
    }

    #[test]
    fn equity_adds_upnl_subtracts_fee() {
        // margin 150 + upnl 150 - close fee 0.6 = 299.4 (all 1e6)
        assert_eq!(
            equity(150_000_000, 150_000_000, 600_000).unwrap(),
            299_400_000
        );
    }

    #[test]
    fn equity_can_be_negative() {
        assert_eq!(equity(100, -250, 10).unwrap(), -160);
    }

    #[test]
    fn liq_price_long_10x_mmr5() {
        // entry 150, lev 10 → 1/lev = 0.10, mmr 0.05 → liq = 150 * (1 - 0.10 + 0.05) = 142.5
        assert_eq!(
            liq_price(Side::Long, P, S, 150_000_000, 500).unwrap(),
            142_500_000
        );
    }
    #[test]
    fn liq_price_short_10x_mmr5() {
        assert_eq!(
            liq_price(Side::Short, P, S, 150_000_000, 500).unwrap(),
            157_500_000
        );
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
    fn vwap_two_equal_lots() {
        assert_eq!(vwap_entry(S, P, S, 160_000_000).unwrap(), 155_000_000);
    }

    #[test]
    fn ema_half_alpha_is_midpoint() {
        // alpha 0.5: 100 + 0.5*(110 - 100) = 105
        assert_eq!(ema(100_000_000, 110_000_000, 5000).unwrap(), 105_000_000);
    }

    #[test]
    fn decrease_pnl_long_partial() {
        // long 10 SOL @ 150, close 4 SOL @ 165 → 4 * 15 = +60
        assert_eq!(
            decrease_pnl(Side::Long, S, 4_000_000_000, P, 165_000_000).unwrap(),
            60_000_000
        );
    }
    #[test]
    fn decrease_pnl_short_partial() {
        assert_eq!(
            decrease_pnl(Side::Short, S, 4_000_000_000, P, 165_000_000).unwrap(),
            -60_000_000
        );
    }

    #[test]
    fn overflow_is_error() {
        assert_eq!(notional(u64::MAX, u64::MAX), Err(MathError::Overflow));
    }

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
