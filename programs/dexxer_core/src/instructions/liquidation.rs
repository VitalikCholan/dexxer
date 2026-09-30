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

/// Shared hysteresis — the ONLY place `PositionSlot.liq_ticks` advances (a
/// healthy check, or `increase_position`, resets it to 0).
///
/// Returns `true` when this tick's health check says the position must be
/// liquidated now. Both liquidation paths call it, so their semantics cannot
/// diverge.
///
/// `liq_ticks` counts distinct PRICE SAMPLES, not calls (risk #38). A sample is
/// a distinct oracle print seen by `crank_tick`, which alone writes
/// `Market.sample_seq` (it advances when the feed's `posted_slot` is newer than
/// `Market.last_print`). Two callers reach this function at different rates,
/// several times per print — the relayer's `crank_tick` and the position's
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
    let Some(idx) = a.positions.load()?.find_open(&market_key) else {
        return Ok(());
    };

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
