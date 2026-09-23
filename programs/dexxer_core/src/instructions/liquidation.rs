//! Week-5 Task 3: liquidations that do not need the external relayer.
//!
//! Week 4 proved that a single market-wide scheduled task can only ever move
//! `Market.mark`: `ScheduleTask` freezes a task's account list at registration
//! time, and the market task is registered with no candidates, so it can never
//! touch a `Position`. The fix is one task PER POSITION, registered by
//! `open_position` itself and paid for by the program's own `FeeEscrow` PDA
//! (which is therefore the task's authority — week-5 Task 0, measurement 3),
//! calling `liquidation_check` on exactly that position's accounts every
//! `LIQ_TASK_INTERVAL_MS`.
//!
//! `liquidation_check` is deliberately NOT a second crank:
//!   * it never advances `Market.mark`/the EMA — the market-level schedule
//!     owns that, and two writers on one EMA would double-sample the index;
//!   * it reads the oracle only as a FRESHNESS GATE on the mark it is about to
//!     liquidate against (a dead crank freezes `mark`, and `check_deviation`
//!     against a live index is what catches that);
//!   * it runs the very same hysteresis and settlement helpers `crank_tick`
//!     runs (`liq_due`/`liquidate_now` below), so the two paths cannot drift
//!     apart.
use crate::{
    errors::DexxerError,
    instructions::trade::finalize_close,
    oracle::{check_deviation, read_price},
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

/// Shared hysteresis — the ONLY place `Position.liq_ticks` moves.
///
/// Returns `true` when this tick's health check says the position must be
/// liquidated now. Both liquidation paths call it, so their semantics cannot
/// diverge.
///
/// TWO INDEPENDENT CALLERS, ONE COUNTER (fix round 1). `liq_ticks` advances
/// once per CALL, and since week-5 Task 3 there are two callers running at
/// different rates: the relayer's `crank_tick` at ~1 s and this position's
/// scheduled `liquidation_check` at ~3.75 s (`LIQ_TASK_INTERVAL_MS` is 5 s but
/// the scheduler overshoots — week-5 Task 0, measurement 1). They do not
/// coordinate, so a scheduled tick that lands between two crank ticks counts
/// the SAME `Market.mark` sample a second time — the very double-count
/// `crank_tick` already refuses to make within one transaction (its
/// duplicate-candidate check). The counter therefore no longer measures
/// "distinct price samples", only "calls".
///
/// The fix is a parameter, not a layout change: `MarketParams`'s default
/// `liq_hysteresis_ticks` went 2 -> 3 (`state/market.rs`). 3 is the smallest
/// value for which the worst-case interleaving — crank, scheduled, crank —
/// still spans at least two DISTINCT mark samples, which is what the original
/// 2 meant on a single-caller crank. Raising it further would only delay the
/// backstop.
///
/// Wall-clock grace differs per path as a consequence: 3 ticks is ~3 s of
/// crank time but ~11 s of scheduled time. That asymmetry is accepted — see
/// `LIQ_TASK_INTERVAL_MS` in `state/mod.rs`.
pub(crate) fn liq_due(pos: &mut Position, market: &Market, mark: u64) -> Result<bool> {
    if risk::liquidatable_now(pos, market, mark)? {
        pos.liq_ticks = pos
            .liq_ticks
            .checked_add(1)
            .ok_or(DexxerError::MathOverflow)?;
        Ok(pos.liq_ticks >= market.liq_hysteresis_ticks)
    } else {
        pos.liq_ticks = 0;
        Ok(false)
    }
}

/// Shared liquidation settlement — the close itself, once `liq_due` has said
/// so.
///
/// Returns `false` (not an error) when the owner's ring is full: the record is
/// the only copy of the closed trade and must not be dropped, but neither may
/// one such candidate abort the caller — on `crank_tick` that would take every
/// other liquidation in the batch down with it (week-5 Task 1, fix round 1,
/// finding 2). The position stays `Open` with its `liq_ticks` intact and
/// liquidates on the first tick after a `commit_aggregate` reveal drains the
/// ring.
#[allow(clippy::too_many_arguments)]
pub(crate) fn liquidate_now(
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    pos: &mut Position,
    dq: &mut DisclosureQueue,
    mark: u64,
    fee_bps: u32,
    clock: &Clock,
    delay_slots: u64,
) -> Result<bool> {
    if dq.len as usize >= DQ_CAPACITY {
        return Ok(false);
    }
    finalize_close(
        market_key,
        risk_acc,
        pool,
        user,
        pos,
        dq,
        mark,
        fee_bps,
        CloseReason::Liquidated,
        clock,
        delay_slots,
    )?;
    Ok(true)
}

/// Accounts of the scheduled per-position task. This list is frozen at
/// registration time (`open_position`), so nothing may be added to it later
/// without re-registering every live task — keep it minimal.
///
/// `market` is READ-ONLY on purpose: the mark belongs to the market-wide
/// crank schedule. Everything else this instruction can write (`market_risk`,
/// `pool_live`, `position`, `user_account`, `disclosure_queue`) is a delegated
/// account, which is also what lets them be writable in the outer
/// `ScheduleTask` CPI's account list (a writable NON-delegated account there
/// is rejected outright — see `ScheduleCrank.config` in `crank.rs`).
#[derive(Accounts)]
pub struct LiquidationCheck<'info> {
    /// Authorization is asserted in the body rather than here: the accepted set
    /// includes a derived PDA (`liq_crank_signer`), which an account constraint
    /// cannot express without recomputing it on every field validation.
    pub crank: Signer<'info>,
    // Boxed throughout: this context carries a `UserAccount`, a `Position` and
    // a `DisclosureQueue` at once — the same trio that already forced boxing in
    // `Trade` and `UndelegateUser`.
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
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref(), market.key().as_ref()],
        bump = position.bump,
        has_one = market
    )]
    pub position: Box<Account<'info, Position>>,
    // Same owner-consistency checks `crank_tick` runs on a candidate triple,
    // expressed declaratively since this context has exactly one candidate.
    #[account(
        mut,
        seeds = [USER_SEED, user_account.owner.as_ref()],
        bump = user_account.bump,
        constraint = user_account.owner == position.owner @ DexxerError::InvalidCandidate
    )]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(
        mut,
        seeds = [DQ_SEED, disclosure_queue.owner.as_ref()],
        bump = disclosure_queue.bump,
        constraint = disclosure_queue.owner == position.owner @ DexxerError::InvalidCandidate
    )]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
}

pub fn liquidation_check(mut ctx: Context<LiquidationCheck>) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;

    // Authorization. The cheap comparisons come first; the derived
    // `crank_signer_pda(fee_escrow)` — the identity a SCHEDULED tick actually
    // carries — costs two `find_program_address` calls and is only reached
    // when the signer is not one of the two configured crank keys.
    let signer = a.crank.key();
    let authorized = signer == a.config.crank
        || signer == a.config.scheduler_signer
        || signer == liq_crank_signer(&fee_escrow_pda());
    require!(authorized, DexxerError::Unauthorized);

    // A task keeps ticking after its position closes (nothing cancels it from
    // inside a scheduled tick) — measured safe, and this is where it becomes a
    // no-op (week-5 Task 0, "Тік по «закритій позиції»").
    if a.position.state != PositionState::Open {
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

    let market_key = a.market.key();
    let fee_bps = a.market.liq_fee_bps as u32;
    let delay = a.config.disclosure_delay_slots;
    if liq_due(&mut a.position, &a.market, mark)? {
        let done = liquidate_now(
            market_key,
            &mut a.market_risk,
            &mut a.pool_live,
            &mut a.user_account,
            &mut a.position,
            &mut a.disclosure_queue,
            mark,
            fee_bps,
            &clock,
            delay,
        )?;
        if !done {
            // Ring full — skipped, not failed (see `liquidate_now`). The
            // accrued `liq_ticks` stays, so the next tick retries.
            msg!("liq check: queue full {}", a.position.key());
        }
    }
    Ok(())
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
/// Task 0, measurement 1): a second `open_position` on the same position PDA
/// simply refreshes the task.
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
/// KNOWN UNMEASURED (Task 4, M-I): what the validator does when the
/// `task_id` does not exist. `ephemeral-rollups-sdk` 0.16.2 just forwards a
/// `MagicBlockInstruction::CancelTask { task_id }` CPI, and a failing CPI
/// cannot be caught from inside a program — so if an unknown id errors, a
/// cancel on a never-registered task aborts the whole caller. Every call site
/// is placed where a task is expected to exist, and each is gated on
/// `magic_program.executable`.
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
