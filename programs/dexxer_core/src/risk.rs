use crate::{errors::DexxerError, math, state::*};
use anchor_lang::prelude::*;

pub struct OpenCheck {
    pub notional: u64,
    pub open_fee: u64,
    pub liq_price: u64,
}

pub struct Settlement {
    pub to_user: u64,
    pub fee_taken: u64,
    pub bad_debt: u64,
}

/// Effective OI cap: explicit cap from market, or 30% of pool capital if cap is 0.
/// Reads `PoolLive` (week-4 Task 1): OI checks must see real-time capital, not the
/// step-rounded `Pool` snapshot `commit_aggregate` publishes every 5 minutes.
pub fn effective_oi_cap(market: &Market, pool: &PoolLive) -> Result<u64> {
    if market.oi_cap > 0 {
        Ok(market.oi_cap)
    } else {
        let cap = (pool.capital_total as u128)
            .checked_mul(3000)
            .ok_or(DexxerError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(DexxerError::MathOverflow)? as u64;
        Ok(cap)
    }
}

/// Check conditions for opening a position: min/max size, leverage, IMR, OI cap.
pub fn check_open(
    market: &Market,
    risk: &MarketRisk,
    pool: &PoolLive,
    side: Side,
    size: u64,
    margin: u64,
    index: u64,
) -> Result<OpenCheck> {
    // Minimum position size
    require!(size >= market.min_size, DexxerError::PositionTooSmall);

    // Notional value
    let notional = math::notional(size, index)?;

    // Maximum position size
    require!(
        notional <= market.max_position,
        DexxerError::PositionTooLarge
    );

    // Initial margin requirement (IMR)
    let required = math::required_margin(notional, market.imr_bps)?;
    require!(margin >= required, DexxerError::InsufficientMargin);

    // Leverage check: notional / margin <= max_lev_bps / 10_000
    // Equivalently: notional * 10_000 <= margin * max_lev_bps
    let notional_scaled = (notional as u128)
        .checked_mul(10_000)
        .ok_or(DexxerError::MathOverflow)?;
    let margin_scaled = (margin as u128)
        .checked_mul(market.max_lev_bps as u128)
        .ok_or(DexxerError::MathOverflow)?;
    require!(
        notional_scaled <= margin_scaled,
        DexxerError::LeverageTooHigh
    );

    // OI cap: current OI + notional <= effective cap
    let oi_side = match side {
        Side::Long => risk.oi_long,
        Side::Short => risk.oi_short,
    };
    let cap = effective_oi_cap(market, pool)?;
    let new_oi = oi_side
        .checked_add(notional)
        .ok_or(DexxerError::MathOverflow)?;
    require!(new_oi <= cap, DexxerError::OiCapExceeded);

    // Calculate open fee and liquidation price
    let open_fee = math::fee(notional, market.open_fee_bps as u32)?;
    let liq_price = math::liq_price(side, index, size, margin, market.mmr_bps)?;

    Ok(OpenCheck {
        notional,
        open_fee,
        liq_price,
    })
}

/// Settlement computes what the user gets back and what pool/insurance/bad_debt account for.
/// User gets (margin + pnl - fee), pool gets fee + (fee doesn't cover), bad_debt is excess loss.
pub fn settle(margin: u64, pnl: i64, fee: u64) -> Result<Settlement> {
    // Gross = margin + pnl (can be negative)
    let gross = (margin as i128)
        .checked_add(pnl as i128)
        .ok_or(DexxerError::MathOverflow)?;

    // If gross <= 0: user gets nothing, bad_debt = |gross|, fee_taken = 0
    if gross <= 0 {
        let bad_debt = u64::try_from(gross.checked_neg().ok_or(DexxerError::MathOverflow)?)
            .map_err(|_| DexxerError::MathOverflow)?;
        return Ok(Settlement {
            to_user: 0,
            fee_taken: 0,
            bad_debt,
        });
    }

    let gross = u64::try_from(gross).map_err(|_| DexxerError::MathOverflow)?;

    // If fee >= gross: pool takes all, user gets nothing
    if gross <= fee {
        return Ok(Settlement {
            to_user: 0,
            fee_taken: gross,
            bad_debt: 0,
        });
    }

    // Normal case: user gets (gross - fee)
    let to_user = gross.checked_sub(fee).ok_or(DexxerError::MathOverflow)?;
    Ok(Settlement {
        to_user,
        fee_taken: fee,
        bad_debt: 0,
    })
}

/// Check if a position is liquidatable now (at current mark price).
pub fn liquidatable_now(pos: &Position, market: &Market, mark: u64) -> Result<bool> {
    let notional = math::notional(pos.size, mark)?;
    let upnl = math::upnl(pos.side, pos.size, pos.entry, mark)?;
    let close_fee = math::fee(notional, market.close_fee_bps as u32)?;
    let eq = math::equity(pos.margin, upnl, close_fee)?;
    Ok(math::is_liquidatable(eq, notional, market.mmr_bps))
}

/// Settle position into pool: release locked margin, move PnL and fees.
/// Pool is the counterparty: user profit comes out of protocol_liquidity (pool loss).
/// Writes `PoolLive` (week-4 Task 1) — the public `Pool` is a rounded snapshot,
/// written only by `commit_aggregate`.
pub fn settle_into_pool(
    pool: &mut PoolLive,
    margin: u64,
    s: &Settlement,
    liquidation: bool,
) -> Result<()> {
    // Release locked margin
    pool.locked_total = pool
        .locked_total
        .checked_sub(margin)
        .ok_or(DexxerError::MathOverflow)?;

    // Calculate pool's net change:
    // Pool receives back: (margin - to_user - fee_taken)
    // If positive: pool gains
    // If negative: pool loses from protocol_liquidity
    let delta_received = (margin as i128)
        .checked_sub(s.to_user as i128)
        .ok_or(DexxerError::MathOverflow)?
        .checked_sub(s.fee_taken as i128)
        .ok_or(DexxerError::MathOverflow)?;

    if delta_received >= 0 {
        pool.protocol_liquidity = pool
            .protocol_liquidity
            .checked_add(u64::try_from(delta_received).map_err(|_| DexxerError::MathOverflow)?)
            .ok_or(DexxerError::MathOverflow)?;
    } else {
        // Pool loss: reduce protocol_liquidity
        let loss =
            u64::try_from(delta_received.unsigned_abs()).map_err(|_| DexxerError::MathOverflow)?;
        pool.protocol_liquidity = pool
            .protocol_liquidity
            .checked_sub(loss)
            .ok_or(DexxerError::PoolInsolvent)?;
    }

    // Fee handling: liquidation fee goes to insurance, otherwise to fees_accrued
    if liquidation {
        pool.insurance = pool
            .insurance
            .checked_add(s.fee_taken)
            .ok_or(DexxerError::MathOverflow)?;
    } else {
        pool.fees_accrued = pool
            .fees_accrued
            .checked_add(s.fee_taken)
            .ok_or(DexxerError::MathOverflow)?;
    }

    // Track bad debt
    pool.bad_debt_total = pool
        .bad_debt_total
        .checked_add(s.bad_debt)
        .ok_or(DexxerError::MathOverflow)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market() -> Market {
        let p = MarketParams::sol_perp_defaults();
        Market {
            version: 1,
            symbol: SOL_SYMBOL,
            feed: Pubkey::default(),
            max_lev_bps: p.max_lev_bps,
            imr_bps: p.imr_bps,
            mmr_bps: p.mmr_bps,
            open_fee_bps: p.open_fee_bps,
            close_fee_bps: p.close_fee_bps,
            liq_fee_bps: p.liq_fee_bps,
            oi_cap: p.oi_cap,
            max_position: p.max_position,
            min_size: p.min_size,
            max_staleness_secs: 2,
            max_conf_bps: 50,
            max_deviation_bps: 200,
            mark: 150_000_000,
            mark_slot: 1,
            ema_alpha_bps: 3000,
            liq_hysteresis_ticks: 2,
            max_stale_ticks: 30,
            paused_open: false,
            stale_ticks: 0,
            bump: 0,
        }
    }

    fn pool(cap: u64) -> PoolLive {
        PoolLive {
            version: 1,
            mint: Pubkey::default(),
            capital_total: cap,
            protocol_liquidity: cap,
            locked_total: 0,
            fees_accrued: 0,
            insurance: 0,
            bad_debt_total: 0,
            bump: 0,
        }
    }

    fn risk() -> MarketRisk {
        MarketRisk {
            version: 1,
            market: Pubkey::default(),
            oi_long: 0,
            oi_short: 0,
            open_positions: 0,
            bump: 0,
        }
    }

    const S: u64 = 10_000_000_000;
    const P: u64 = 150_000_000;

    #[test]
    fn open_10x_ok() {
        let c = check_open(
            &market(),
            &risk(),
            &pool(100_000_000_000),
            Side::Long,
            S,
            150_000_000,
            P,
        )
        .unwrap();
        assert_eq!(c.notional, 1_500_000_000);
        assert_eq!(c.open_fee, 900_000);
        assert_eq!(c.liq_price, 142_500_000);
    }

    #[test]
    fn open_11x_rejected() {
        assert!(check_open(
            &market(),
            &risk(),
            &pool(100_000_000_000),
            Side::Long,
            S,
            136_000_000,
            P
        )
        .is_err());
    }

    #[test]
    fn open_below_min_size_rejected() {
        assert!(check_open(
            &market(),
            &risk(),
            &pool(100_000_000_000),
            Side::Long,
            1_000_000,
            1_000_000,
            P
        )
        .is_err());
    }

    #[test]
    fn open_over_oi_cap_rejected() {
        // cap = 30% of 1000 = 300 $; notional 1500 $
        assert!(check_open(
            &market(),
            &risk(),
            &pool(1_000_000_000),
            Side::Long,
            S,
            150_000_000,
            P
        )
        .is_err());
    }

    #[test]
    fn settle_profit() {
        let s = settle(150, 50, 10).unwrap();
        assert_eq!((s.to_user, s.fee_taken, s.bad_debt), (190, 10, 0));
    }

    #[test]
    fn settle_fee_eats_remainder() {
        let s = settle(100, -95, 10).unwrap();
        assert_eq!((s.to_user, s.fee_taken, s.bad_debt), (0, 5, 0));
    }

    #[test]
    fn settle_bad_debt() {
        let s = settle(100, -130, 10).unwrap();
        assert_eq!((s.to_user, s.fee_taken, s.bad_debt), (0, 0, 30));
    }

    fn locked(mut p: PoolLive, m: u64) -> PoolLive {
        p.locked_total = m;
        p
    }

    #[test]
    fn pool_pays_user_profit() {
        let mut p = locked(pool(1000), 150);
        settle_into_pool(&mut p, 150, &settle(150, 50, 10).unwrap(), false).unwrap();
        assert_eq!(
            (p.protocol_liquidity, p.fees_accrued, p.locked_total),
            (950, 10, 0)
        );
    }

    #[test]
    fn pool_absorbs_user_loss() {
        let mut p = locked(pool(1000), 100);
        settle_into_pool(&mut p, 100, &settle(100, -95, 10).unwrap(), false).unwrap();
        assert_eq!((p.protocol_liquidity, p.fees_accrued), (1095, 5));
    }

    #[test]
    fn liquidation_fee_goes_to_insurance_and_bad_debt_is_counted() {
        let mut p = locked(pool(1000), 100);
        settle_into_pool(&mut p, 100, &settle(100, -130, 10).unwrap(), true).unwrap();
        assert_eq!(
            (p.protocol_liquidity, p.insurance, p.bad_debt_total),
            (1100, 0, 30)
        );
    }

    #[test]
    fn pool_insolvent_on_big_profit() {
        let mut p = locked(pool(10), 100);
        assert!(settle_into_pool(&mut p, 100, &settle(100, 200, 0).unwrap(), false).is_err());
    }
}
