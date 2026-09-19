use crate::{
    errors::DexxerError,
    instructions::user::assert_trader,
    math,
    oracle::{check_open_quality, read_price},
    risk::{self, Settlement},
    state::*,
};
use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

#[derive(Accounts)]
pub struct Trade<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Account<'info, MarketRisk>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [USER_SEED, user_account.owner.as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,
    // Boxed: with all the other accounts in this context inline, Position
    // pushes the account-validation stack frame past the SBF limit (same
    // failure mode as InitUser's Position/DisclosureQueue in instructions/user.rs).
    #[account(
        mut,
        seeds = [POSITION_SEED, user_account.owner.as_ref(), market.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user_account.owner @ DexxerError::Unauthorized,
        has_one = market
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: validated in oracle::read_price (key == market.feed, owner == config.oracle_program)
    pub feed: UncheckedAccount<'info>,
}

fn seed_mark(market: &mut Market, index: u64, slot: u64) {
    if market.mark == 0 {
        market.mark = index;
        market.mark_slot = slot;
    }
}

pub fn open_position(
    mut ctx: Context<Trade>,
    side: Side,
    size: u64,
    margin: u64,
    limit_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(!a.config.paused, DexxerError::Paused);
    require!(!a.market.paused_open, DexxerError::OpenPaused);
    require!(
        a.position.state == PositionState::Empty,
        DexxerError::PositionNotEmpty
    );
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    check_open_quality(&px, &a.market)?;
    match side {
        Side::Long => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
    }
    let chk = risk::check_open(
        &a.market,
        &a.market_risk,
        &a.pool,
        side,
        size,
        margin,
        px.price,
    )?;
    let cost = margin
        .checked_add(chk.open_fee)
        .ok_or(DexxerError::MathOverflow)?;
    require!(
        a.user_account.free_margin >= cost,
        DexxerError::InsufficientMargin
    );
    let u = &mut a.user_account;
    u.free_margin = u
        .free_margin
        .checked_sub(cost)
        .ok_or(DexxerError::MathOverflow)?;
    u.locked_margin = u
        .locked_margin
        .checked_add(margin)
        .ok_or(DexxerError::MathOverflow)?;
    let pool = &mut a.pool;
    pool.locked_total = pool
        .locked_total
        .checked_add(margin)
        .ok_or(DexxerError::MathOverflow)?;
    pool.fees_accrued = pool
        .fees_accrued
        .checked_add(chk.open_fee)
        .ok_or(DexxerError::MathOverflow)?;
    let entry_notional = math::notional(size, px.price)?;
    let r = &mut a.market_risk;
    match side {
        Side::Long => {
            r.oi_long = r
                .oi_long
                .checked_add(entry_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            r.oi_short = r
                .oi_short
                .checked_add(entry_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    r.open_positions = r
        .open_positions
        .checked_add(1)
        .ok_or(DexxerError::MathOverflow)?;
    let p = &mut a.position;
    p.state = PositionState::Open;
    p.side = side;
    p.size = size;
    p.entry = px.price;
    p.margin = margin;
    p.liq_price = chk.liq_price;
    p.opened_slot = clock.slot;
    p.liq_ticks = 0;
    p.closed = None;
    seed_mark(&mut a.market, px.price, clock.slot);
    Ok(())
}

pub fn add_margin(mut ctx: Context<Trade>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(amount > 0, DexxerError::AmountZero);
    require!(
        a.position.state == PositionState::Open,
        DexxerError::PositionNotOpen
    );
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    require!(
        a.user_account.free_margin >= amount,
        DexxerError::InsufficientMargin
    );
    let u = &mut a.user_account;
    u.free_margin = u
        .free_margin
        .checked_sub(amount)
        .ok_or(DexxerError::MathOverflow)?;
    u.locked_margin = u
        .locked_margin
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    a.pool.locked_total = a
        .pool
        .locked_total
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    let p = &mut a.position;
    p.margin = p
        .margin
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    // margin > notional (leverage below 1x) has no liquidation price
    p.liq_price = math::liq_price(p.side, p.entry, p.size, p.margin, a.market.mmr_bps).unwrap_or(0);
    Ok(())
}

pub fn close_position(mut ctx: Context<Trade>, limit_price: u64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(
        a.position.state == PositionState::Open,
        DexxerError::PositionNotOpen
    );
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    match a.position.side {
        Side::Long => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
    }
    let fee_bps = a.market.close_fee_bps as u32;
    let delay = a.config.disclosure_delay_slots;
    let market_key = a.market.key();
    finalize_close(
        market_key,
        &mut a.market_risk,
        &mut a.pool,
        &mut a.user_account,
        &mut a.position,
        px.price,
        fee_bps,
        CloseReason::User,
        &clock,
        delay,
    )?;
    Ok(())
}

pub fn increase_position(
    mut ctx: Context<Trade>,
    add_size: u64,
    add_margin: u64,
    limit_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(!a.config.paused, DexxerError::Paused);
    require!(!a.market.paused_open, DexxerError::OpenPaused);
    require!(
        a.position.state == PositionState::Open,
        DexxerError::PositionNotOpen
    );
    require!(add_size > 0, DexxerError::AmountZero);
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    check_open_quality(&px, &a.market)?;
    let side = a.position.side;
    match side {
        Side::Long => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
    }
    let new_size = a
        .position
        .size
        .checked_add(add_size)
        .ok_or(DexxerError::MathOverflow)?;
    let new_margin = a
        .position
        .margin
        .checked_add(add_margin)
        .ok_or(DexxerError::MathOverflow)?;
    let new_entry = math::vwap_entry(a.position.size, a.position.entry, add_size, px.price)?;
    // OI check on the delta only: pretend the existing exposure is not there.
    let old_notional = math::notional(a.position.size, a.position.entry)?;
    let r0 = &a.market_risk;
    let mut risk_view = MarketRisk {
        version: r0.version,
        market: r0.market,
        oi_long: r0.oi_long,
        oi_short: r0.oi_short,
        open_positions: r0.open_positions,
        bump: r0.bump,
    };
    match side {
        Side::Long => {
            risk_view.oi_long = risk_view
                .oi_long
                .checked_sub(old_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            risk_view.oi_short = risk_view
                .oi_short
                .checked_sub(old_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    let chk = risk::check_open(
        &a.market, &risk_view, &a.pool, side, new_size, new_margin, new_entry,
    )?;
    let delta_notional = math::notional(add_size, px.price)?;
    let fee = math::fee(delta_notional, a.market.open_fee_bps as u32)?;
    let cost = add_margin
        .checked_add(fee)
        .ok_or(DexxerError::MathOverflow)?;
    require!(
        a.user_account.free_margin >= cost,
        DexxerError::InsufficientMargin
    );
    let u = &mut a.user_account;
    u.free_margin = u
        .free_margin
        .checked_sub(cost)
        .ok_or(DexxerError::MathOverflow)?;
    u.locked_margin = u
        .locked_margin
        .checked_add(add_margin)
        .ok_or(DexxerError::MathOverflow)?;
    let pool = &mut a.pool;
    pool.locked_total = pool
        .locked_total
        .checked_add(add_margin)
        .ok_or(DexxerError::MathOverflow)?;
    pool.fees_accrued = pool
        .fees_accrued
        .checked_add(fee)
        .ok_or(DexxerError::MathOverflow)?;
    let r = &mut a.market_risk;
    match side {
        Side::Long => {
            r.oi_long = r
                .oi_long
                .checked_add(delta_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            r.oi_short = r
                .oi_short
                .checked_add(delta_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    let p = &mut a.position;
    p.size = new_size;
    p.margin = new_margin;
    p.entry = new_entry;
    p.liq_price = chk.liq_price;
    p.liq_ticks = 0;
    Ok(())
}

pub fn decrease_position(mut ctx: Context<Trade>, close_size: u64, limit_price: u64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(
        a.position.state == PositionState::Open,
        DexxerError::PositionNotOpen
    );
    require!(
        close_size > 0 && close_size <= a.position.size,
        DexxerError::InvalidInput
    );
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    match a.position.side {
        Side::Long => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
    }
    let market_key = a.market.key();
    if close_size == a.position.size {
        let fee_bps = a.market.close_fee_bps as u32;
        let delay = a.config.disclosure_delay_slots;
        finalize_close(
            market_key,
            &mut a.market_risk,
            &mut a.pool,
            &mut a.user_account,
            &mut a.position,
            px.price,
            fee_bps,
            CloseReason::User,
            &clock,
            delay,
        )?;
        return Ok(());
    }
    let remaining = a
        .position
        .size
        .checked_sub(close_size)
        .ok_or(DexxerError::MathOverflow)?;
    require!(
        remaining >= a.market.min_size,
        DexxerError::PositionTooSmall
    );
    // Floor: the remainder keeps the rounding, in the pool's favour.
    let released = ((a.position.margin as u128)
        .checked_mul(close_size as u128)
        .ok_or(DexxerError::MathOverflow)?)
    .checked_div(a.position.size as u128)
    .ok_or(DexxerError::MathOverflow)? as u64;
    let pnl = math::decrease_pnl(
        a.position.side,
        a.position.size,
        close_size,
        a.position.entry,
        px.price,
    )?;
    let fee = math::fee(
        math::notional(close_size, px.price)?,
        a.market.close_fee_bps as u32,
    )?;
    let s = risk::settle(released, pnl, fee)?;
    risk::settle_into_pool(&mut a.pool, released, &s, false)?;
    let u = &mut a.user_account;
    u.free_margin = u
        .free_margin
        .checked_add(s.to_user)
        .ok_or(DexxerError::MathOverflow)?;
    u.locked_margin = u
        .locked_margin
        .checked_sub(released)
        .ok_or(DexxerError::MathOverflow)?;
    let closed_notional = math::notional(close_size, a.position.entry)?;
    let r = &mut a.market_risk;
    match a.position.side {
        Side::Long => {
            r.oi_long = r
                .oi_long
                .checked_sub(closed_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            r.oi_short = r
                .oi_short
                .checked_sub(closed_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    let p = &mut a.position;
    p.size = remaining;
    p.margin = p
        .margin
        .checked_sub(released)
        .ok_or(DexxerError::MathOverflow)?;
    // IMR is an *initial* margin requirement: check the remainder at entry, so a
    // pro-rata release keeps leverage unchanged; mark-based health is crank_tick's job (MMR).
    let rem_notional = math::notional(p.size, p.entry)?;
    require!(
        p.margin >= math::required_margin(rem_notional, a.market.imr_bps)?,
        DexxerError::InsufficientMargin
    );
    p.liq_price = math::liq_price(p.side, p.entry, p.size, p.margin, a.market.mmr_bps).unwrap_or(0);
    Ok(())
}

/// Shared by close_position, decrease_position (full) and crank liquidation.
#[allow(clippy::too_many_arguments)]
pub fn finalize_close(
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut Pool,
    user: &mut UserAccount,
    pos: &mut Position,
    exit: u64,
    fee_bps: u32,
    reason: CloseReason,
    clock: &Clock,
    delay_slots: u64,
) -> Result<Settlement> {
    let notional_exit = math::notional(pos.size, exit)?;
    let pnl = math::upnl(pos.side, pos.size, pos.entry, exit)?;
    let fee = math::fee(notional_exit, fee_bps)?;
    let s = risk::settle(pos.margin, pnl, fee)?;
    risk::settle_into_pool(pool, pos.margin, &s, reason == CloseReason::Liquidated)?;
    user.free_margin = user
        .free_margin
        .checked_add(s.to_user)
        .ok_or(DexxerError::MathOverflow)?;
    user.locked_margin = user
        .locked_margin
        .checked_sub(pos.margin)
        .ok_or(DexxerError::MathOverflow)?;
    let entry_notional = math::notional(pos.size, pos.entry)?;
    // OI is decremented by the same entry-notional it was incremented with at
    // open; underflow here means an accounting bug and must fail loudly, not
    // clamp silently.
    match pos.side {
        Side::Long => {
            risk_acc.oi_long = risk_acc
                .oi_long
                .checked_sub(entry_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            risk_acc.oi_short = risk_acc
                .oi_short
                .checked_sub(entry_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    risk_acc.open_positions = risk_acc
        .open_positions
        .checked_sub(1)
        .ok_or(DexxerError::MathOverflow)?;
    user.nonce = user.nonce.checked_add(1).ok_or(DexxerError::MathOverflow)?;
    // week 3 may replace this salt source with VRF/TEE randomness
    let salt = hashv(&[
        pos.owner.as_ref(),
        &user.nonce.to_le_bytes(),
        &clock.slot.to_le_bytes(),
    ])
    .to_bytes();
    pos.closed = Some(ClosedRecord {
        market: market_key,
        side: pos.side,
        size: pos.size,
        entry: pos.entry,
        exit,
        pnl,
        fees: s.fee_taken,
        reason,
        opened_slot: pos.opened_slot,
        closed_slot: clock.slot,
        salt,
        nonce: user.nonce,
        reveal_after_slot: clock
            .slot
            .checked_add(delay_slots)
            .ok_or(DexxerError::MathOverflow)?,
        commitment_written: false,
    });
    pos.state = PositionState::Closed;
    pos.size = 0;
    pos.margin = 0;
    pos.liq_price = 0;
    pos.liq_ticks = 0;
    Ok(s)
}
