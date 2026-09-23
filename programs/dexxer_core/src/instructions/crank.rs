use crate::{
    errors::DexxerError, instructions::trade::finalize_close, math, oracle::read_price, risk,
    state::*,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_rollups_sdk::{
    consts::MAGIC_PROGRAM_ID,
    crank::{CancelCrankCpi, ScheduleCrankCpi},
};
use magicblock_magic_program_api::{args::ScheduleTaskArgs, pda::CRANK_SIGNER};

#[derive(Accounts)]
pub struct CrankTick<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = crank.key() == config.crank
            || crank.key() == config.scheduler_signer
            || crank.key().to_bytes() == CRANK_SIGNER.to_bytes() @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Account<'info, MarketRisk>,
    // Live pool counters (week-4 Task 1): liquidation via `finalize_close` writes
    // here, never the public `Pool` snapshot. Self-referential seed, same as `Trade`.
    #[account(mut, seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Account<'info, PoolLive>,
    /// CHECK: validated in oracle::read_price
    pub feed: UncheckedAccount<'info>,
}

/// One candidate's liquidation, split out and `#[inline(never)]` so the
/// `DisclosureQueue` local (up to 1300 B, `state/mod.rs`'s
/// `print_sizes_for_spec_q3` bound) lives in its own call frame instead of
/// `crank_tick`'s, which already carries a `Position` and a `UserAccount` and
/// would blow the SBF 4096-byte stack limit — the same split
/// `commit_aggregate` needed for the same account (`commit.rs`).
///
/// Everything this function touches is work only a candidate that is ACTUALLY
/// being liquidated needs, which is why the queue's PDA derivation and decode
/// live here rather than in `crank_tick`'s per-candidate preamble: a
/// `find_program_address` is ~1.5k CU and a full tick carries up to
/// `MAX_CANDIDATES` of them, almost none of which liquidate (fix round 1,
/// finding 4). The cheap structural checks on `dq_ai` (program-owned,
/// writable) stay in the loop, where they cost nothing.
///
/// Returns `false` when the owner's ring is full: the record is the only copy
/// of the closed trade, so it must not be dropped — but neither may one such
/// candidate abort the whole batch and take every other liquidation in the
/// tick down with it (that would make a market-wide liquidation DoS cost
/// eight open/close pairs — fix round 1, finding 2). The position stays
/// `Open`, keeps accruing `liq_ticks`, and is liquidated on a later tick once
/// a `commit_aggregate` reveal drains the ring. `close_position`'s own
/// `QueueFull` stays a hard, atomic revert: that one is user-facing and the
/// user can wait.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn liquidate_candidate(
    dq_ai: &AccountInfo,
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    pos: &mut Position,
    mark: u64,
    fee_bps: u32,
    clock: &Clock,
    delay_slots: u64,
) -> Result<bool> {
    // The queue's address is derived from the position's own owner, which is
    // what binds it to this candidate; `dq.owner` is re-checked after the
    // decode as defence in depth.
    let (exp_dq, _) = Pubkey::find_program_address(&[DQ_SEED, pos.owner.as_ref()], &crate::ID);
    require!(dq_ai.key() == exp_dq, DexxerError::InvalidCandidate);
    let mut dq = DisclosureQueue::try_deserialize(&mut &dq_ai.try_borrow_data()?[..])?;
    require!(dq.owner == pos.owner, DexxerError::InvalidCandidate);
    if dq.len as usize >= DQ_CAPACITY {
        return Ok(false);
    }
    finalize_close(
        market_key,
        risk_acc,
        pool,
        user,
        pos,
        &mut dq,
        mark,
        fee_bps,
        CloseReason::Liquidated,
        clock,
        delay_slots,
    )?;
    dq.try_serialize(&mut &mut dq_ai.try_borrow_mut_data()?[..])?;
    Ok(true)
}

// anchor-lang 1.0.2's `Context<'info, T>` carries a single lifetime (not the
// 4-lifetime `Context<'a, 'b, 'c, 'info, T>` of older Anchor versions), so the
// wrapper below forwards just `'info` — matching how `remaining_accounts:
// &'info [AccountInfo<'info>]` is declared on `Context` itself.
pub fn crank_tick<'info>(mut ctx: Context<'info, CrankTick<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let market_key = a.market.key();
    // (1) oracle
    let px = match read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock) {
        Ok(p) => p,
        Err(_) => {
            let m = &mut a.market;
            m.stale_ticks = m
                .stale_ticks
                .checked_add(1)
                .ok_or(DexxerError::MathOverflow)?;
            if m.stale_ticks >= m.max_stale_ticks {
                m.paused_open = true;
            }
            return Ok(()); // stale -> no mark update, no liquidations (spec §3.5)
        }
    };
    // (2) mark EMA + deviation guard. Snapshot the mark from *before* this
    // tick's EMA update: measuring deviation against a mark the EMA has
    // already absorbed this same index sample into would understate drift
    // (the mark chases the index within the same tick) and could let a
    // liquidation run on a tick whose index was itself the deviating outlier.
    let m = &mut a.market;
    m.stale_ticks = 0;
    let prev_mark = m.mark;
    // First tick ever (no mark seeded yet): seed mark = index, no deviation
    // check possible (nothing to compare against) and opens stay unpaused.
    let tripped = if prev_mark == 0 {
        m.mark = px.price;
        false
    } else {
        m.mark = math::ema(prev_mark, px.price, m.ema_alpha_bps as u32)?;
        let dev_bps = (px.price.abs_diff(prev_mark) as u128)
            .checked_mul(10_000)
            .ok_or(DexxerError::MathOverflow)?
            .checked_div(prev_mark as u128)
            .ok_or(DexxerError::MathOverflow)?;
        dev_bps > m.max_deviation_bps as u128
    };
    m.mark_slot = clock.slot;
    m.paused_open = tripped;
    if tripped {
        // Index deviated from the previous mark: the EMA still absorbed the
        // sample (so the guard self-clears as the mark converges), but this
        // tick's index is not trustworthy enough to liquidate anyone on.
        return Ok(());
    }
    let mark = m.mark;
    // (3)-(5) candidates: triples [position, user_account, disclosure_queue].
    // The queue joined the tuple in week-5 Task 1: a liquidation is a close,
    // and a close now pushes its `ClosedRecord` straight into the owner's ring
    // (`finalize_close`), so the crank must carry that account for every
    // candidate it might liquidate this tick.
    let rem = ctx.remaining_accounts;
    require!(
        rem.len() % 3 == 0 && rem.len() / 3 <= MAX_CANDIDATES,
        DexxerError::InvalidCandidate
    );
    // Reject a duplicate [Position, UserAccount, DisclosureQueue] triple inside
    // the same remaining_accounts list — without this, the same candidate passed
    // twice would run `liquidatable_now`/hysteresis logic twice in one tx,
    // double-incrementing `liq_ticks` and being able to trip liquidation a
    // tick early.
    let mut seen: [Pubkey; MAX_CANDIDATES] = [Pubkey::default(); MAX_CANDIDATES];
    let mut seen_len: usize = 0;
    for triple in rem.chunks(3) {
        let (pos_ai, user_ai, dq_ai) = (&triple[0], &triple[1], &triple[2]);
        require!(
            pos_ai.owner == &crate::ID
                && user_ai.owner == &crate::ID
                && dq_ai.owner == &crate::ID
                && pos_ai.is_writable
                && user_ai.is_writable
                && dq_ai.is_writable,
            DexxerError::InvalidCandidate
        );
        require!(
            !seen[..seen_len].contains(&pos_ai.key()),
            DexxerError::InvalidCandidate
        );
        seen[seen_len] = pos_ai.key();
        seen_len = seen_len.checked_add(1).ok_or(DexxerError::MathOverflow)?;
        let mut pos = Position::try_deserialize(&mut &pos_ai.try_borrow_data()?[..])?;
        // Week-5 Task 2 appended `exited` to `UserAccount` (layout version 2),
        // so a v1 account created before that upgrade is one byte short and
        // cannot be deserialized into the current struct at all. That is not a
        // recoverable state and this skip does not make it one: a v1 account is
        // unreadable by EVERY typed instruction, so its owner can neither close
        // an open position nor be liquidated — the skip only keeps ONE such
        // candidate from taking the whole tick's liquidations down with it
        // (same containment rule as the full-ring skip below).
        //
        // No program-side migration exists, deliberately (fix round 1,
        // controller ruling IMPORTANT 3): devnet's legacy accounts are test
        // wallets, and the devnet policy is to close their positions on the OLD
        // program before this upgrade is deployed (inventoried in Task 4). A
        // production upgrade would need a real realloc migration instead.
        let mut user = match UserAccount::try_deserialize(&mut &user_ai.try_borrow_data()?[..]) {
            Ok(u) => u,
            Err(_) => {
                msg!("liq skipped: undecodable user account {}", user_ai.key());
                continue;
            }
        };
        require!(
            pos.market == market_key && pos.owner == user.owner,
            DexxerError::InvalidCandidate
        );
        let (exp_pos, _) = Pubkey::find_program_address(
            &[POSITION_SEED, pos.owner.as_ref(), market_key.as_ref()],
            &crate::ID,
        );
        let (exp_user, _) =
            Pubkey::find_program_address(&[USER_SEED, user.owner.as_ref()], &crate::ID);
        // `dq_ai`'s address is checked inside `liquidate_candidate`, not here:
        // it is only ever read on the liquidation path, and deriving it for
        // every candidate costs ~1.5k CU each (fix round 1, finding 4).
        require!(
            pos_ai.key() == exp_pos && user_ai.key() == exp_user,
            DexxerError::InvalidCandidate
        );
        if pos.state != PositionState::Open {
            continue;
        }
        if risk::liquidatable_now(&pos, &a.market, mark)? {
            pos.liq_ticks = pos
                .liq_ticks
                .checked_add(1)
                .ok_or(DexxerError::MathOverflow)?;
            if pos.liq_ticks >= a.market.liq_hysteresis_ticks {
                let fee_bps = a.market.liq_fee_bps as u32;
                let delay = a.config.disclosure_delay_slots;
                let done = liquidate_candidate(
                    dq_ai,
                    market_key,
                    &mut a.market_risk,
                    &mut a.pool_live,
                    &mut user,
                    &mut pos,
                    mark,
                    fee_bps,
                    &clock,
                    delay,
                )?;
                if !done {
                    // Ring full — skipped, not failed (see `liquidate_candidate`).
                    // `liq_ticks` above is still written back below, so the
                    // position stays hot and liquidates on the first tick after
                    // a reveal drains the ring.
                    msg!("liq skipped: queue full {}", pos_ai.key());
                }
            }
        } else {
            pos.liq_ticks = 0;
        }
        pos.try_serialize(&mut &mut pos_ai.try_borrow_mut_data()?[..])?;
        user.try_serialize(&mut &mut user_ai.try_borrow_mut_data()?[..])?;
    }
    Ok(())
}

// spec §8 Q2 / week-2 controller ruling task-4 #2: register `crank_tick` as a
// Magic Actions scheduled task so the crank runs unattended inside the ER
// (no external fallback scripts needed once this succeeds). ER-only,
// admin-gated. The scheduled inner instruction carries NO remaining_accounts
// (liquidation candidates are supplied by the fallback script's own
// `crank_tick` calls, not by the scheduler) — accounts here mirror
// `CrankTick` exactly: `crank` is whatever `Config.scheduler_signer`
// currently holds (task-6 fix round 3 — see the function body's comment),
// the rest are the market/pool state the tick reads and writes.
#[derive(Accounts)]
pub struct ScheduleCrank<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    // NOT `mut` (task-6 fix round 3, real on-chain evidence — see the function
    // body's comment on the writable-account rejection): `Config` is never
    // delegated to the ER (only Market/MarketRisk/Pool/FeeEscrow are), and the
    // validator rejects the whole schedule transaction with
    // `TransactionError::InvalidWritableAccount` ("Account N: <config> was
    // illegally used as writable") when a non-delegated account other than
    // `task_context` (which the Magic Program manages itself) shows up
    // writable anywhere in `ScheduleCrankCpi`'s `instruction_accounts`. Since
    // `config` must also appear there (the scheduled `crank_tick` reads it),
    // it has to stay strictly read-only through this whole instruction —
    // meaning `Config.crank_task_id` can't actually be persisted by this call
    // (see the body comment for what replaces it).
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Box<Account<'info, MarketRisk>>,
    // Same swap as `CrankTick.pool_live` above — the scheduled inner `crank_tick`
    // call now reads/writes `PoolLive`, not `Pool`.
    #[account(mut, seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Box<Account<'info, PoolLive>>,
    /// CHECK: validated in oracle::read_price when the scheduled crank_tick executes
    pub feed: UncheckedAccount<'info>,
    /// CHECK: the scheduled task's crank signer, validated in the function body
    /// below against `config.scheduler_signer` (task-6 fix round 3 — the
    /// client must have already called `set_scheduler_signer` on base with
    /// `crank_signer_pda(admin)` before this; see that ix's doc comment in
    /// `admin.rs` and the function body below for the full story).
    pub crank: UncheckedAccount<'info>,
    // Caller-supplied, same as `CancelCrank`'s: neither `ephemeral-rollups-sdk` 0.16.2
    // nor `magicblock-magic-program-api` 0.10.1 expose an on-chain PDA derivation for
    // this account (see task-4 report, "task_context" finding). Named here (rather than
    // left implicit in `remaining_accounts`) purely for IDL self-documentation and
    // identity-checking below; admin-gated so a wrong value here only fails the CPI.
    /// CHECK: Magic Actions task-context account for the newly scheduled `task_id`
    #[account(mut)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
// Single explicit `'info` (not the elided two-lifetime default), matching
// `crank_tick` above: `ScheduleCrankCpi`'s `compat::AccountInfo<'a>` is
// invariant in `'a`, so `&ctx.accounts.admin` etc. below need the Context's
// outer lifetime and the accounts struct's own lifetime unified into one.
//
// `instruction_accounts` needs a genuinely `'info`-scoped `&[AccountInfo]`.
// A freshly built local array cannot provide one — its own backing memory
// only lives for this function's stack frame, shorter than the generic
// `'info` the invariant `compat::AccountInfo<'info>` type demands (verified
// against the real 0.16.2 API; see task-4 report). `ctx.remaining_accounts`
// is already `&'info [AccountInfo<'info>]` (Anchor's own guarantee — see the
// comment on `crank_tick` above), so the client repeats the same seven
// accounts there (`task_context` first — matching `ScheduleTask`'s own
// documented account layout in `magicblock-magic-program-api`: 0 = payer,
// 1 = task context account, 2..n = accounts included in the task; `payer`
// itself is prepended by `ScheduleCrankCpi::invoke()`, so `remaining_accounts`
// supplies everything from index 1 onward), then the same six `crank_tick`
// accounts as before; check identity against the validated named fields
// below before trusting them for the CPI.
pub fn schedule_crank<'info>(
    ctx: Context<'info, ScheduleCrank<'info>>,
    task_id: i64,
    interval_ms: i64,
    iterations: i64,
) -> Result<()> {
    // Task-6 fix round 3 (controller ruling, supersedes round 2): fix round 2
    // tried computing `crank_signer_pda(admin)` in THIS instruction and
    // writing it into `Config.scheduler_signer` before the CPI below — proven
    // structurally impossible on real devnet-tee, twice independently
    // (`TransactionError::InvalidWritableAccount` — a writable, non-delegated
    // account other than `task_context` is unconditionally rejected in
    // `ScheduleCrankCpi`'s `instruction_accounts`, and `config` must be in
    // that list for the scheduled `crank_tick` to read it). Fix round 3 moves
    // the write to a NEW base-layer admin ix instead
    // (`admin::set_scheduler_signer`, `instructions/admin.rs`) — base-layer
    // writes to `Config` have no such restriction, only THIS specific ER CPI
    // does. This instruction goes back to doing what it did before fix round
    // 2 ever touched it: read `Config.scheduler_signer` (set on base,
    // beforehand, to `crank_signer_pda(admin)` — same derivation fix round 2
    // confirmed against the pinned validator source,
    // `magicblock-magic-program-api/src/pda.rs` at commit
    // `9c7a94470af1785d88f4c671571f87c146a93779`, mirrored client-side in
    // `tests/er/lib/crank-signer.ts`) and use it as-is — no computation, no
    // write, `config` stays read-only here exactly like fix round 1 left it.
    let crank_signer = ctx.accounts.config.scheduler_signer;
    require!(
        ctx.accounts.crank.key() == crank_signer,
        DexxerError::Unauthorized
    );

    let rem = ctx.remaining_accounts;
    require!(rem.len() == 7, DexxerError::InvalidInput);
    let expected = [
        ctx.accounts.task_context.key(),
        ctx.accounts.crank.key(),
        ctx.accounts.config.key(),
        ctx.accounts.market.key(),
        ctx.accounts.market_risk.key(),
        ctx.accounts.pool_live.key(),
        ctx.accounts.feed.key(),
    ];
    for (ai, key) in rem.iter().zip(expected.iter()) {
        require!(ai.key() == *key, DexxerError::InvalidInput);
    }

    let crank_tick_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![
            // `crank_signer` == `Config.scheduler_signer` (checked above,
            // read once already) — see the comment above.
            AccountMeta::new_readonly(crank_signer, true),
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.market_risk.key(), false),
            AccountMeta::new(ctx.accounts.pool_live.key(), false),
            AccountMeta::new_readonly(ctx.accounts.feed.key(), false),
        ],
        data: anchor_lang::InstructionData::data(&crate::instruction::CrankTick {}),
    };
    ScheduleCrankCpi {
        payer: &ctx.accounts.admin,
        magic_program: &ctx.accounts.magic_program,
        instruction_accounts: rem,
        args: ScheduleTaskArgs {
            task_id,
            execution_interval_millis: interval_ms,
            iterations,
            instructions: vec![crank_tick_ix],
        },
    }
    .invoke()?;
    // `config` is read-only in this instruction (see the CHECK comment on
    // `ScheduleCrank.config` above), so `Config.crank_task_id` cannot be
    // written here — logged instead, the only durable record of which
    // task_id this call registered.
    msg!("schedule_crank: registered task_id={}", task_id);
    Ok(())
}

// spec §8 Q2 / week-2 controller ruling task-4 #3: stop the scheduled crank
// (e.g. before pausing the market for maintenance, or to replace it with a
// new interval/iteration count via a fresh `schedule_crank` call). ER-only,
// admin-gated.
#[derive(Accounts)]
pub struct CancelCrank<'info> {
    pub admin: Signer<'info>,
    // NOT `mut` — same reasoning as `ScheduleCrank.config` above; nothing
    // here writes to `config` any more (see `cancel_crank`'s `task_id` arg).
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    // Caller-supplied: neither `ephemeral-rollups-sdk` 0.16.2 nor
    // `magicblock-magic-program-api` 0.10.1 expose an on-chain PDA derivation
    // for this account (see task-4 report, "task_context" finding) — unlike
    // `magic_context`/`magic_fee_vault`, which have fixed/derivable addresses.
    /// CHECK: Magic Actions per-task context account for the task being cancelled
    #[account(mut)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
// `task_id` is now a caller-supplied argument, not read from
// `Config.crank_task_id` (task-6 fix round 3): `ScheduleCrank.config` can no
// longer persist that field (see its CHECK comment), so it would always read
// back `0` here — the caller (the same client that ran `schedule_crank`,
// which already knows/computed the task_id) passes it directly instead.
pub fn cancel_crank<'info>(ctx: Context<'info, CancelCrank<'info>>, task_id: i64) -> Result<()> {
    CancelCrankCpi {
        authority: &ctx.accounts.admin,
        task_context: &ctx.accounts.task_context,
        magic_program: &ctx.accounts.magic_program,
        crank_id: task_id,
    }
    .invoke()?;
    msg!("cancel_crank: cancelled task_id={}", task_id);
    Ok(())
}
