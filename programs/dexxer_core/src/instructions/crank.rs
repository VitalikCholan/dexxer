use crate::{
    errors::DexxerError,
    instructions::liquidation::{liq_due, liquidate_now, run_orders},
    math,
    oracle::read_price,
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
        // tick's index is not trustworthy enough to liquidate anyone on — so
        // it is not a liquidation sample either (final review C3): otherwise
        // `liquidation_check` would count, and liquidate on, the very print
        // this tick refused.
        return Ok(());
    }
    // A liquidation SAMPLE is a distinct oracle print that this tick ACCEPTED,
    // not a crank call (risk #38): two crank sources landing on the same print
    // must not count twice. Identity, not order (final review C2): a feed whose
    // `posted_slot` ever went backwards would otherwise freeze every later
    // sample, and with it every liquidation. Staleness is gated separately, on
    // `publish_time`, in `read_price` (the publish time is in whole seconds
    // and can repeat across prints, so it cannot serve as the identity).
    if px.posted_slot != m.last_print {
        m.last_print = px.posted_slot;
        m.sample_seq = m
            .sample_seq
            .checked_add(1)
            .ok_or(DexxerError::MathOverflow)?;
    }
    let mark = m.mark;
    // (3)-(5) candidates: pairs [positions, user_account]; the slot is the one
    // of THIS market inside the trader's `Positions` (spec §2.9).
    let rem = ctx.remaining_accounts;
    require!(
        rem.len() % 2 == 0 && rem.len() / 2 <= MAX_CANDIDATES,
        DexxerError::InvalidCandidate
    );
    // Reject a duplicate [Positions, UserAccount] pair inside the same
    // remaining_accounts list — without this, the same candidate passed twice
    // would run `liquidatable_now`/hysteresis logic twice in one tx,
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
        // Zero-copy: the 3.1 KiB account is read and written in place (a
        // by-value Borsh copy would not fit the SBF stack). `try_from` checks
        // owner and discriminator: a program-owned first account of a pair
        // that is not a `Positions` aborts the whole tick with Anchor's own
        // error (3002, `AccountDiscriminatorMismatch`), not
        // `InvalidCandidate`. An undecodable SECOND account (`UserAccount`) is
        // skipped just below.
        let loader = AccountLoader::<Positions>::try_from(pos_ai)?;
        // Week-5 Task 2 appended `exited` to `UserAccount` (layout version 2),
        // so a v1 account created before that upgrade is one byte short and
        // cannot be deserialized into the current struct at all. That is not a
        // recoverable state and this skip does not make it one: a v1 account is
        // unreadable by EVERY typed instruction, so its owner can neither close
        // an open position nor be liquidated — the skip only keeps ONE such
        // candidate from taking the whole tick's liquidations down with it.
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
        // One borrow for the struct and the OPTIONAL order tail (a pre-orders
        // account has none; its liquidation then clears no orders).
        let (mut positions, mut orders) = load_positions_mut(&loader)?;
        let (exp_pos, _) =
            Pubkey::find_program_address(&[POSITIONS_SEED, positions.owner.as_ref()], &crate::ID);
        let (exp_user, _) =
            Pubkey::find_program_address(&[USER_SEED, user.owner.as_ref()], &crate::ID);
        // A mismatched pair is a malformed candidate list from the crank,
        // not a state of a trader — rejected, as before slots.
        require!(
            positions.owner == user.owner && pos_ai.key() == exp_pos && user_ai.key() == exp_user,
            DexxerError::InvalidCandidate
        );
        // Neither an open slot nor an order on this market: nothing to do
        // here — a candidate list is built per trader, not per (trader,
        // market).
        let open_idx = positions.find_open(&market_key);
        let has_orders = orders.as_deref().is_some_and(|o| o.has_on(&market_key));
        if open_idx.is_none() && !has_orders {
            continue;
        }
        // Hysteresis is shared with `liquidation_check` (week-5 Task 3) — the
        // one place `liq_ticks` advances, on either path.
        if let Some(idx) = open_idx {
            if liq_due(&mut positions.slots[idx], &a.market, mark)? {
                let fee_bps = a.market.liq_fee_bps as u32;
                liquidate_now(
                    market_key,
                    &mut a.market_risk,
                    &mut a.pool_live,
                    &mut user,
                    &mut positions,
                    orders.as_deref_mut(),
                    idx,
                    mark,
                    fee_bps,
                    &clock,
                )?;
            }
        }
        // Conditional orders run here too, after the liquidation check: the
        // scheduler's `liquidation_check` is the primary executor, this keeps
        // them working while the scheduler is down. An order the other path
        // already executed is simply gone — running twice is harmless.
        if let (true, Some(orders)) = (has_orders, orders.as_deref_mut()) {
            run_orders(
                a.config.paused,
                &a.market,
                market_key,
                &mut a.market_risk,
                &mut a.pool_live,
                &mut user,
                &mut positions,
                orders,
                &px,
                mark,
                &clock,
            )?;
        }
        // `positions` is zero-copy: its bytes were written in place and the
        // `RefMut`s are dropped at the end of this iteration. Only the Borsh
        // `UserAccount` needs serializing back.
        drop(orders);
        drop(positions);
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
