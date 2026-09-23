use crate::{
    errors::DexxerError,
    instructions::user::assert_trader,
    math,
    oracle::{check_deviation, check_open_quality, read_price},
    risk::{self, Settlement},
    state::*,
};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use solana_keccak_hasher::hashv;

/// STACK BUDGET — read before adding an account here. Week-5 Task 1's four new
/// fields put `Trade::try_accounts` 8 bytes over the SBF 4096-byte frame
/// (`anchor build`: "Stack offset of 4104 exceeded max offset of 4096", plus
/// five "function call overwrites values in the frame" errors). Boxing `config`
/// bought back a `Config`'s worth of frame — `Config::INIT_SPACE` is 275 B — so
/// roughly 270 B of headroom is left. Week-5 Task 3 adds `scheduler_signer`
/// (an `UncheckedAccount`, cheap) and must stay inside that; if it does not,
/// box the next-largest account (`market`, then `market_risk`). The build fails
/// loudly on overflow, so this is a warning, not an invariant to trust blindly.
#[derive(Accounts)]
pub struct Trade<'info> {
    pub signer: Signer<'info>,
    // Boxed: week-5 Task 1 added four accounts to this context, which tipped
    // `Trade::try_accounts` 8 bytes past the SBF stack limit (build error, same
    // failure mode as `user_account`/`position` below). `Config` is the largest
    // read-only account here, so it is the cheapest one to move to the heap.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Account<'info, MarketRisk>,
    // Live pool counters (week-4 Task 1): every trading instruction writes here,
    // never the public `Pool` (only `commit_aggregate` writes that, as a
    // step-rounded snapshot). Self-referential seed (mirrors `CommitAggregate`'s
    // `pool_live` field) since `Trade` carries no separate `Pool` account to read
    // the mint from.
    #[account(mut, seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Account<'info, PoolLive>,
    // Boxed: week-3 Task 0 grew `UserAccount` by `exit_salt: [u8; 32]`, which
    // tipped this context's account-validation stack frame 8 bytes past the
    // SBF limit (same failure mode `Position` below already worked around) —
    // moves `UserAccount`'s deserialize buffer off the stack onto the heap.
    #[account(mut, seeds = [USER_SEED, user_account.owner.as_ref()], bump = user_account.bump)]
    pub user_account: Box<Account<'info, UserAccount>>,
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
    // Week-5 Task 1: `finalize_close` pushes the `ClosedRecord` straight into
    // the owner's ring, so every trading instruction that can close a position
    // (`close_position`, `decrease_position` to zero) needs it. Boxed for the
    // same SBF stack reason as `user_account`/`position` above — this is the
    // biggest per-user account of the three.
    #[account(mut, seeds = [DQ_SEED, user_account.owner.as_ref()], bump = disclosure_queue.bump)]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
    // Declared for the per-position liquidation task (week-5 Task 3): the
    // delegated PDA that pays the scheduler CPI's fees, exactly as in
    // `commit_aggregate`/`withdraw`. Unused by this task's handlers.
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Box<Account<'info, FeeEscrow>>,
    /// CHECK: Magic Actions task-context account for this position's liquidation
    /// task (week-5 Task 3). Caller-supplied and unconstrained, exactly as in
    /// `ScheduleCrank`/`CancelCrank` (`crank.rs`): no on-chain derivation for it
    /// exists in `ephemeral-rollups-sdk` 0.16.2, and a wrong value can only fail
    /// the scheduler CPI that Task 3 adds. Unused by this task's handlers.
    #[account(mut)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the Task 3 scheduler CPI via `.executable`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
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
    check_deviation(&px, &a.market)?;
    match side {
        Side::Long => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
    }
    let chk = risk::check_open(
        &a.market,
        &a.market_risk,
        &a.pool_live,
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
    let pool = &mut a.pool_live;
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
    // Exact at open: entry == px.price, so notional(size, entry) == entry_notional.
    p.oi_notional = entry_notional;
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
    a.pool_live.locked_total = a
        .pool_live
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
        &mut a.pool_live,
        &mut a.user_account,
        &mut a.position,
        &mut a.disclosure_queue,
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
    check_deviation(&px, &a.market)?;
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
    // Use the position's own tracked `oi_notional`, not a recompute of
    // `notional(size, entry)` off the stored (VWAP, rounds-up) entry — the same
    // double-rounding class fixed in `finalize_close`/`decrease_position`: after
    // a prior increase, that recompute can exceed the ledger's true remaining
    // contribution and underflow `checked_sub` here, spuriously rejecting a
    // perfectly legitimate increase with MathOverflow.
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
                .checked_sub(a.position.oi_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            risk_view.oi_short = risk_view
                .oi_short
                .checked_sub(a.position.oi_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    let chk = risk::check_open(
        &a.market,
        &risk_view,
        &a.pool_live,
        side,
        new_size,
        new_margin,
        new_entry,
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
    let pool = &mut a.pool_live;
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
    // Track the exact OI contribution in lock-step with the ledger above
    // (delta_notional, not a recompute off the rounded VWAP entry).
    p.oi_notional = p
        .oi_notional
        .checked_add(delta_notional)
        .ok_or(DexxerError::MathOverflow)?;
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
            &mut a.pool_live,
            &mut a.user_account,
            &mut a.position,
            &mut a.disclosure_queue,
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
    risk::settle_into_pool(&mut a.pool_live, released, &s, false)?;
    let u = &mut a.user_account;
    u.free_margin = u
        .free_margin
        .checked_add(s.to_user)
        .ok_or(DexxerError::MathOverflow)?;
    u.locked_margin = u
        .locked_margin
        .checked_sub(released)
        .ok_or(DexxerError::MathOverflow)?;
    // Pro-rata share of the position's own tracked OI contribution (floor,
    // pool-favouring, same direction as `released` margin above) — not a
    // recompute off the stored entry, which would suffer the same VWAP
    // double-rounding underflow risk as `finalize_close` (see Position::oi_notional).
    let closed_oi = ((a.position.oi_notional as u128)
        .checked_mul(close_size as u128)
        .ok_or(DexxerError::MathOverflow)?)
    .checked_div(a.position.size as u128)
    .ok_or(DexxerError::MathOverflow)? as u64;
    let r = &mut a.market_risk;
    match a.position.side {
        Side::Long => {
            r.oi_long = r
                .oi_long
                .checked_sub(closed_oi)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            r.oi_short = r
                .oi_short
                .checked_sub(closed_oi)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    let p = &mut a.position;
    p.size = remaining;
    p.margin = p
        .margin
        .checked_sub(released)
        .ok_or(DexxerError::MathOverflow)?;
    p.oi_notional = p
        .oi_notional
        .checked_sub(closed_oi)
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
///
/// Queue-first (week-5 Task 1): the `ClosedRecord` is pushed into `dq` and the
/// `Position` is reset to `Empty` in this same instruction, so a trader can
/// reopen immediately and no crank round-trip (`mark_committed`, now gone) sits
/// between a close and the next trade. `dq.push` is fallible (`QueueFull`), and
/// it is the LAST thing that can fail here — a full ring reverts the entire
/// close rather than settling the money and losing the record.
#[allow(clippy::too_many_arguments)]
pub fn finalize_close(
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    pos: &mut Position,
    dq: &mut DisclosureQueue,
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
    // OI is decremented by the position's own tracked contribution
    // (`pos.oi_notional`, maintained in lock-step at open/increase/decrease),
    // NOT by recomputing `notional(pos.size, pos.entry)`: `entry` is a VWAP
    // that rounds up on every `increase_position`, and re-rounding `notional`
    // on top of that can produce a value larger than what is actually left in
    // the ledger, underflowing `checked_sub` and failing the whole crank tx
    // (every candidate in the batch, not just this one) even though nothing
    // is actually wrong. `oi_notional` is exact by construction, so this
    // subtraction can only fail on a genuine accounting bug.
    match pos.side {
        Side::Long => {
            risk_acc.oi_long = risk_acc
                .oi_long
                .checked_sub(pos.oi_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            risk_acc.oi_short = risk_acc
                .oi_short
                .checked_sub(pos.oi_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
    }
    pos.oi_notional = 0;
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
    dq.push(ClosedRecord {
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
    })?;
    // Fully `Empty`, field by field: the next `open_position` overwrites
    // `state`/`side`/`size`/`entry`/`margin`/`liq_price`/`opened_slot`, but
    // leaving any of them set in between would show a phantom trade to the
    // owner's client, so nothing is left behind. `closed` stays in the layout
    // (no account migration) and is now always `None`.
    pos.state = PositionState::Empty;
    pos.closed = None;
    pos.side = Side::Long;
    pos.size = 0;
    pos.entry = 0;
    pos.margin = 0;
    pos.liq_price = 0;
    pos.opened_slot = 0;
    pos.liq_ticks = 0;
    Ok(s)
}
