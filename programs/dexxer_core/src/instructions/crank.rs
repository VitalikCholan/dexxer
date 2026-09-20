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
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: validated in oracle::read_price
    pub feed: UncheckedAccount<'info>,
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
    // (3)-(5) candidates: pairs [position, user_account]
    let rem = ctx.remaining_accounts;
    require!(
        rem.len() % 2 == 0 && rem.len() / 2 <= MAX_CANDIDATES,
        DexxerError::InvalidCandidate
    );
    // Reject a duplicate [Position, UserAccount] pair inside the same
    // remaining_accounts list — without this, the same candidate passed
    // twice would run `liquidatable_now`/hysteresis logic twice in one tx,
    // double-incrementing `liq_ticks` and being able to trip liquidation a
    // tick early.
    let mut seen: [Pubkey; MAX_CANDIDATES] = [Pubkey::default(); MAX_CANDIDATES];
    let mut seen_len: usize = 0;
    for pair in rem.chunks(2) {
        let (pos_ai, user_ai) = (&pair[0], &pair[1]);
        require!(
            pos_ai.owner == &crate::ID
                && user_ai.owner == &crate::ID
                && pos_ai.is_writable
                && user_ai.is_writable,
            DexxerError::InvalidCandidate
        );
        require!(
            !seen[..seen_len].contains(&pos_ai.key()),
            DexxerError::InvalidCandidate
        );
        seen[seen_len] = pos_ai.key();
        seen_len = seen_len.checked_add(1).ok_or(DexxerError::MathOverflow)?;
        let mut pos = Position::try_deserialize(&mut &pos_ai.try_borrow_data()?[..])?;
        let mut user = UserAccount::try_deserialize(&mut &user_ai.try_borrow_data()?[..])?;
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
                finalize_close(
                    market_key,
                    &mut a.market_risk,
                    &mut a.pool,
                    &mut user,
                    &mut pos,
                    mark,
                    fee_bps,
                    CloseReason::Liquidated,
                    &clock,
                    delay,
                )?;
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
// `CrankTick` exactly: `crank` is `Config.scheduler_signer` (matches the
// signer-set change above), the rest are the market/pool state the tick
// reads and writes.
#[derive(Accounts)]
pub struct ScheduleCrank<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Box<Account<'info, MarketRisk>>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: validated in oracle::read_price when the scheduled crank_tick executes
    pub feed: UncheckedAccount<'info>,
    /// CHECK: the scheduled task's crank signer; must be Config.scheduler_signer so
    /// crank_tick's own signer-set constraint accepts it at execution time
    #[account(address = config.scheduler_signer @ DexxerError::Unauthorized)]
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
    let rem = ctx.remaining_accounts;
    require!(rem.len() == 7, DexxerError::InvalidInput);
    let expected = [
        ctx.accounts.task_context.key(),
        ctx.accounts.crank.key(),
        ctx.accounts.config.key(),
        ctx.accounts.market.key(),
        ctx.accounts.market_risk.key(),
        ctx.accounts.pool.key(),
        ctx.accounts.feed.key(),
    ];
    for (ai, key) in rem.iter().zip(expected.iter()) {
        require!(ai.key() == *key, DexxerError::InvalidInput);
    }

    let crank_tick_ix = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.crank.key(), true),
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.market_risk.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
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
    ctx.accounts.config.crank_task_id = task_id;
    Ok(())
}

// spec §8 Q2 / week-2 controller ruling task-4 #3: stop the scheduled crank
// (e.g. before pausing the market for maintenance, or to replace it with a
// new interval/iteration count via a fresh `schedule_crank` call). ER-only,
// admin-gated.
#[derive(Accounts)]
pub struct CancelCrank<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    // Caller-supplied: neither `ephemeral-rollups-sdk` 0.16.2 nor
    // `magicblock-magic-program-api` 0.10.1 expose an on-chain PDA derivation
    // for this account (see task-4 report, "task_context" finding) — unlike
    // `magic_context`/`magic_fee_vault`, which have fixed/derivable addresses.
    /// CHECK: Magic Actions per-task context account for `config.crank_task_id`
    #[account(mut)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
pub fn cancel_crank<'info>(ctx: Context<'info, CancelCrank<'info>>) -> Result<()> {
    CancelCrankCpi {
        authority: &ctx.accounts.admin,
        task_context: &ctx.accounts.task_context,
        magic_program: &ctx.accounts.magic_program,
        crank_id: ctx.accounts.config.crank_task_id,
    }
    .invoke()?;
    ctx.accounts.config.crank_task_id = 0;
    Ok(())
}
