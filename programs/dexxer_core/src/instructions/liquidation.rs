//! Week-5 Task 3: liquidations that do not need the external relayer.
//!
//! Week 4 proved that a single market-wide scheduled task can only ever move
//! `Market.mark`: `ScheduleTask` freezes a task's account list at registration
//! time, and the market task is registered with no candidates, so it can never
//! touch a `Position`. The fix is one task PER POSITION, registered by
//! `open_position` itself and paid for by the program's own `FeeEscrow` PDA
//! (which is therefore the task's authority — week-5 Task 0, measurement 3),
//! calling `liquidation_check` on exactly that position's accounts every
//! `LIQ_TASK_INTERVAL_MS`. Since slots Task 4 "that position" is the slot of
//! the task's market inside the trader's `Positions` account.
//!
//! `liquidation_check` is deliberately NOT a second crank:
//!   * it never advances `Market.mark`/the EMA or `Market.sample_seq` — the market-level schedule
//!     owns that, and two writers on one EMA would double-sample the index;
//!   * it reads the oracle only as a FRESHNESS GATE on the mark it is about to
//!     liquidate against (a dead crank freezes `mark`, and `check_deviation`
//!     against a live index is what catches that);
//!   * it runs the very same hysteresis and settlement helpers `crank_tick`
//!     runs (`liq_due`/`liquidate_now` below), so the two paths cannot drift
//!     apart.
use crate::{
    errors::DexxerError,
    instructions::trade::{finalize_close, open_core},
    oracle::{check_deviation, check_open_quality, read_price, OraclePrice},
    risk,
    state::*,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use ephemeral_rollups_sdk::crank::{CancelCrankCpi, ScheduleCrankCpi};
use magicblock_magic_program_api::{args::ScheduleTaskArgs, pda::CRANK_SEED, CRANK_PROGRAM_ID};

/// The Magic Program's per-authority crank-executor PDA — the ONLY signer a
/// scheduled instruction is ever given.
///
/// `authority` is the `ScheduleTask` instruction's account index 0, i.e. the
/// CPI payer (week-5 Task 0, "Додаткові виміри"). For these tasks that payer
/// is the program's `FeeEscrow` PDA, NOT `Config.admin` — so the signer of a
/// scheduled `liquidation_check` is `crank_signer_pda(fee_escrow)` and NOT
/// `Config.scheduler_signer` (which is `crank_signer_pda(admin)`, the signer
/// of the market-wide `schedule_crank` task). Both are accepted below; they
/// are different keys and both are legitimate crank identities.
///
/// Derivation mirrors the pinned validator source (see
/// `tests/er/lib/crank-signer.ts` for the full citation); `CRANK_SEED` and
/// `CRANK_PROGRAM_ID` come from the pinned 0.10.1 crate, only the composed
/// helper is newer there.
pub fn liq_crank_signer(task_authority: &Pubkey) -> Pubkey {
    let crank_program = Pubkey::new_from_array(CRANK_PROGRAM_ID.to_bytes());
    Pubkey::find_program_address(&[CRANK_SEED, task_authority.as_ref()], &crank_program).0
}

/// `FeeEscrow`'s address, recomputed rather than passed in: `LiquidationCheck`
/// deliberately carries no `fee_escrow` account (every account in a scheduled
/// task's list is frozen forever at registration, so the list is kept minimal).
pub fn fee_escrow_pda() -> Pubkey {
    Pubkey::find_program_address(&[FEE_ESCROW_SEED], &crate::ID).0
}

/// Shared hysteresis — the ONLY place `PositionSlot.liq_ticks` changes: it
/// advances here, and only a healthy check here resets it to 0.
/// `increase_position` never touches it (final review C1) — an increase on a
/// position liquidatable at the mark is refused outright.
///
/// Returns `true` when this tick's health check says the position must be
/// liquidated now. Both liquidation paths call it, so their semantics cannot
/// diverge.
///
/// `liq_ticks` counts distinct PRICE SAMPLES, not calls (risk #38). A sample is
/// a distinct oracle print that `crank_tick` ACCEPTED — not one on which its
/// deviation breaker tripped. `crank_tick` alone writes `Market.sample_seq`: it
/// advances when the accepted print's `posted_slot` differs from
/// `Market.last_print` (identity, not order). Two callers reach this function
/// at different rates, several times per print — the relayer's `crank_tick` and the position's
/// scheduled `liquidation_check`; a tick counts only when `sample_seq` is newer
/// than `PositionSlot.last_liq_sample`. Crank calls on one print, and any
/// number of checks, therefore count once. A healthy check resets the counter
/// but keeps `last_liq_sample`: `sample_seq` only grows, so any later print
/// counts again.
pub(crate) fn liq_due(pos: &mut PositionSlot, market: &Market, mark: u64) -> Result<bool> {
    if !risk::liquidatable_now(pos, market, mark)? {
        pos.liq_ticks = 0;
        return Ok(false);
    }
    if market.sample_seq > pos.last_liq_sample {
        pos.liq_ticks = pos
            .liq_ticks
            .checked_add(1)
            .ok_or(DexxerError::MathOverflow)?;
        pos.last_liq_sample = market.sample_seq;
    }
    Ok(pos.liq_ticks >= market.liq_hysteresis_ticks)
}

/// Shared liquidation settlement — the close itself, once `liq_due` has said
/// so. Nothing is queued any more (spec §2.9), so a liquidation can never be
/// skipped: it always settles through `finalize_close`, which also writes the
/// owner's history record with `reason = Liquidated`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn liquidate_now(
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    positions: &mut Positions,
    idx: usize,
    mark: u64,
    fee_bps: u32,
    clock: &Clock,
) -> Result<()> {
    finalize_close(
        market_key,
        risk_acc,
        pool,
        user,
        positions,
        idx,
        mark,
        fee_bps,
        CloseReason::Liquidated,
        clock,
    )?;
    Ok(())
}

/// Accounts of the scheduled per-position task. This list is frozen at
/// registration time (`open_position`), so nothing may be added to it later
/// without re-registering every live task — keep it minimal.
///
/// `market` is READ-ONLY on purpose: the mark belongs to the market-wide
/// crank schedule. Everything else this instruction can write (`market_risk`,
/// `pool_live`, `positions`, `user_account`) is a delegated
/// account, which is also what lets them be writable in the outer
/// `ScheduleTask` CPI's account list (a writable NON-delegated account there
/// is rejected outright — see `ScheduleCrank.config` in `crank.rs`).
#[derive(Accounts)]
pub struct LiquidationCheck<'info> {
    /// Authorization is asserted in the body rather than here: the accepted set
    /// includes a derived PDA (`liq_crank_signer`), which an account constraint
    /// cannot express without recomputing it on every field validation.
    pub crank: Signer<'info>,
    // Boxed throughout: this context carries several Borsh accounts at once —
    // the same shape that already forced boxing in `Trade` and
    // `UndelegateUser`. `positions` is zero-copy and needs no box.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Box<Account<'info, MarketRisk>>,
    #[account(mut, seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Box<Account<'info, PoolLive>>,
    /// CHECK: validated in oracle::read_price (key == market.feed, owner == config.oracle_program)
    pub feed: UncheckedAccount<'info>,
    // The slot is found by `market.key()` in the body; a market with no open
    // slot makes the tick a no-op.
    #[account(
        mut,
        seeds = [POSITIONS_SEED, user_account.owner.as_ref()],
        bump = positions.load()?.bump
    )]
    pub positions: AccountLoader<'info, Positions>,
    // Same owner-consistency checks `crank_tick` runs on a candidate pair,
    // expressed declaratively since this context has exactly one candidate.
    #[account(
        mut,
        seeds = [USER_SEED, user_account.owner.as_ref()],
        bump = user_account.bump,
        constraint = user_account.owner == positions.load()?.owner @ DexxerError::InvalidCandidate
    )]
    pub user_account: Box<Account<'info, UserAccount>>,
}

/// Read-only on `market`: it never advances the price sample. Liquidation
/// without the relayer therefore still needs a live `crank_tick` source (the
/// market's scheduled crank) to see new prints — with no crank at all nothing
/// is liquidated, deliberately: a frozen mark is not liquidated on.
pub fn liquidation_check(mut ctx: Context<LiquidationCheck>) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;

    // Authorization (week-5 final review M3). The SCHEDULED identity is checked
    // FIRST because it is the normal path: almost every tick here arrives from
    // the per-position scheduled task, signed by `liq_crank_signer`. Comparing
    // the two cheap `Config` fields first only meant paying two
    // `find_program_address` calls after two comparisons that never match.
    // `Config.scheduler_signer` (the MARKET-schedule identity) is deliberately
    // NOT accepted: it has no business on a per-position liquidation path, and
    // `ScheduleCrank` registers the market task without `remaining_accounts`
    // anyway, so it can never legitimately reach this instruction.
    let signer = a.crank.key();
    let authorized = signer == liq_crank_signer(&fee_escrow_pda()) || signer == a.config.crank;
    require!(authorized, DexxerError::Unauthorized);

    // A liquidated or user-closed position leaves its task registered until
    // the next open on this market or the owner's exit (nothing cancels it
    // from inside a scheduled tick): a tick on a market with no open slot is a
    // no-op, never an error (spec §2.9.2; week-5 Task 0, "Тік по «закритій
    // позиції»"). The borrow is scoped: nothing below issues a CPI, but the
    // write happens in its own `load_mut` further down.
    let market_key = a.market.key();
    // With conditional orders pending the task has work to do on a market with
    // no open slot too: its entry orders.
    let (open_idx, has_orders) = {
        let p = a.positions.load()?;
        (p.find_open(&market_key), p.has_orders_on(&market_key))
    };
    if open_idx.is_none() && !has_orders {
        return Ok(());
    }

    // Freshness gate. Two independent ways the mark can be untrustworthy:
    // the oracle itself is stale/too wide (spec §3.5 — skip, never liquidate
    // on an old price), or the mark has drifted away from a perfectly healthy
    // index because the market-wide crank that maintains it has stopped. The
    // deviation check catches the second: this path reads `Market.mark` but
    // never updates it, so without it a frozen mark would keep liquidating
    // forever against reality.
    let px = match read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock) {
        Ok(p) => p,
        Err(_) => {
            msg!("liq check: skipped (stale oracle)");
            return Ok(());
        }
    };
    if check_deviation(&px, &a.market).is_err() {
        msg!("liq check: skipped (mark deviates from index)");
        return Ok(());
    }
    let mark = a.market.mark;
    if mark == 0 {
        return Ok(()); // market never marked; nothing to liquidate against
    }

    let fee_bps = a.market.liq_fee_bps as u32;
    let mut positions = a.positions.load_mut()?;
    if let Some(idx) = open_idx {
        if liq_due(&mut positions.slots[idx], &a.market, mark)? {
            liquidate_now(
                market_key,
                &mut a.market_risk,
                &mut a.pool_live,
                &mut a.user_account,
                &mut positions,
                idx,
                mark,
                fee_bps,
                &clock,
            )?;
        }
    }
    // Liquidation always goes first: a position that is liquidatable this tick
    // must not be rescued by a stop that happens to share the tick.
    if has_orders {
        run_orders(
            a.config.paused,
            &a.market,
            market_key,
            &mut a.market_risk,
            &mut a.pool_live,
            &mut a.user_account,
            &mut positions,
            &px,
            mark,
            &clock,
        )?;
    }
    Ok(())
}

/// Execute this market's triggered conditional orders against `mark`.
///
/// Runs on every scheduled tick after the liquidation check, and never fails
/// the tick on a bad order: one that can no longer be filled (no margin, risk
/// limit hit) is dropped rather than retried forever, and transient conditions
/// (paused, poor oracle quality) leave the order in place.
#[allow(clippy::too_many_arguments)]
fn run_orders(
    paused: bool,
    market: &Market,
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    positions: &mut Positions,
    px: &OraclePrice,
    mark: u64,
    clock: &Clock,
) -> Result<()> {
    if let Some(idx) = positions.find_open(&market_key) {
        let side = positions.slots[idx].side();
        // Trailing orders chase the best price first, so a single tick that
        // both makes a new high and reverses uses the new high.
        let mut hit = false;
        for o in positions.orders.iter_mut() {
            if o.market != market_key || !o.kind().is_reduce_only() {
                continue;
            }
            let trigger = if o.kind() == OrderKind::TrailingStop {
                o.extreme = trail_extreme(side, o.extreme, mark);
                match trailing_stop_price(side, o.extreme, o.trail_bps) {
                    Ok(t) => t,
                    Err(_) => continue,
                }
            } else {
                o.trigger
            };
            if is_triggered(o.kind(), side, trigger, mark) {
                hit = true;
            }
        }
        if !hit {
            return Ok(());
        }
        // Reported as a user close on purpose: nothing about this exit says it
        // was a resting order.
        finalize_close(
            market_key,
            risk_acc,
            pool,
            user,
            positions,
            idx,
            mark,
            market.close_fee_bps as u32,
            CloseReason::User,
            clock,
        )?;
        msg!("orders: closed");
        return Ok(());
    }
    // No open position: entry orders.
    if paused || market.paused_open || check_open_quality(px, market).is_err() {
        return Ok(());
    }
    for i in 0..ORDER_SLOTS {
        let o = positions.orders[i];
        if o.market != market_key
            || !o.kind().is_entry()
            || !is_triggered(o.kind(), o.side(), o.trigger, mark)
        {
            continue;
        }
        let opened = open_core(
            market,
            market_key,
            risk_acc,
            pool,
            user,
            positions,
            o.side(),
            o.size,
            o.margin,
            mark,
            clock.slot,
        );
        match opened {
            Ok(()) => {
                // One position per market: the sibling entries are moot.
                positions.clear_entry_orders(&market_key);
                attach_exits(positions, &o);
                msg!("orders: opened");
                return Ok(());
            }
            Err(_) => {
                positions.orders[i] = bytemuck::Zeroable::zeroed();
                msg!("orders: dropped slot {}", i);
            }
        }
    }
    Ok(())
}

/// Turn an entry order's `tp`/`sl` into live reduce-only orders on the
/// position it just opened (a free slot is needed; without one the exit is
/// simply not attached).
fn attach_exits(positions: &mut Positions, entry: &OrderSlot) {
    for (kind, trigger) in [
        (OrderKind::TakeProfit, entry.tp),
        (OrderKind::StopLoss, entry.sl),
    ] {
        if trigger == 0 {
            continue;
        }
        if let Some(i) = positions.free_order_slot() {
            positions.orders[i] = OrderSlot {
                market: entry.market,
                trigger,
                size: 0,
                margin: 0,
                extreme: 0,
                tp: 0,
                sl: 0,
                kind: kind.as_u8(),
                side: entry.side,
                trail_bps: 0,
                _pad: [0; 4],
            };
        }
    }
}

// ------------------------------------------------------------ task lifecycle

/// Register (or re-register) one position's liquidation task.
///
/// Every argument that reaches `ScheduleCrankCpi` must be `'info`-scoped:
/// `compat::AccountInfo<'a>` is invariant in `'a` (it holds `RefCell<&'a mut
/// [u8]>`), so a `&'b [AccountInfo<'info>]` borrowed from a local `Vec` can
/// never coerce to the `&'a [AccountInfo<'a>]` the CPI struct demands. The
/// callers get around that by leaking the account slice (see
/// `trade::liq_task_accounts`) rather than by routing it through
/// `remaining_accounts` the way `schedule_crank` does — an open is a
/// user-facing instruction and should not make every client repeat ten
/// accounts it already passes.
///
/// Re-registering an existing `task_id` is an UPDATE, not an error (week-5
/// Task 0, measurement 1): a second `open_position` on the same market of the
/// same `Positions` PDA simply refreshes the task.
pub(crate) fn schedule_liquidation_task<'info>(
    payer: &'info AccountInfo<'info>,
    magic_program: &'info AccountInfo<'info>,
    instruction_accounts: &'info [AccountInfo<'info>],
    inner_ix: Instruction,
    task_id: i64,
    escrow_bump: u8,
) -> Result<()> {
    let bump = [escrow_bump];
    let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &bump];
    ScheduleCrankCpi {
        payer,
        magic_program,
        instruction_accounts,
        args: ScheduleTaskArgs {
            task_id,
            execution_interval_millis: LIQ_TASK_INTERVAL_MS,
            // Finite iteration counts were measured to simply stop (week 3,
            // M-D), and a liquidation backstop that expires is no backstop.
            iterations: i64::MAX,
            instructions: vec![inner_ix],
        },
    }
    .invoke_signed(&[seeds])
    .map_err(Into::into)
}

/// Cancel one position's liquidation task. The authority is the `FeeEscrow`
/// PDA that paid for the registration — a program PDA can own and cancel a
/// task with no human signer anywhere (week-5 Task 0, measurement 3).
///
/// Cancelling a `task_id` that does not exist (never registered, or already
/// cancelled) was measured on devnet to be a safe no-op, not an error (week 5,
/// M-I) — which is what lets `undelegate_user` cancel for every market the
/// client names. Every call site is gated on `magic_program.executable`.
pub(crate) fn cancel_liquidation_task<'info>(
    authority: &'info AccountInfo<'info>,
    task_context: &'info AccountInfo<'info>,
    magic_program: &'info AccountInfo<'info>,
    task_id: i64,
    escrow_bump: u8,
) -> Result<()> {
    let bump = [escrow_bump];
    let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &bump];
    CancelCrankCpi {
        authority,
        task_context,
        magic_program,
        crank_id: task_id,
    }
    .invoke_signed(&[seeds])
    .map_err(Into::into)
}
