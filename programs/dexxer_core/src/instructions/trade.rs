use crate::{
    errors::DexxerError,
    instructions::{
        liquidation::{cancel_liquidation_task, liq_crank_signer, schedule_liquidation_task},
        user::assert_trader,
    },
    math,
    oracle::{check_deviation, check_open_quality, read_price},
    risk::{self, Settlement},
    state::*,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;

/// STACK BUDGET — read before adding an account here. Week-5 Task 1's four new
/// fields put `Trade::try_accounts` 8 bytes over the SBF 4096-byte frame
/// (`anchor build`: "Stack offset of 4104 exceeded max offset of 4096", plus
/// five "function call overwrites values in the frame" errors). Boxing `config`
/// bought back a `Config`'s worth of frame, roughly 270 B of headroom. Week-5
/// Task 3 spent some of it on `liq_crank_signer` (an `UncheckedAccount`,
/// cheap); week-6 slots Task 1 gave one account back (the boxed
/// `disclosure_queue`, gone with trade disclosure — 12 accounts now), and
/// slots Task 4 replaced the boxed by-value `Position` with an
/// `AccountLoader<Positions>`, which keeps only an `AccountInfo` reference on
/// the frame (the 3.1 KiB account is read in place, never copied), so it is
/// cheaper than the `Box<Account<Position>>` it replaced. If a future field
/// does not fit, box the next-largest account (`market`, then `market_risk`).
/// The build fails loudly on overflow, so this is a warning, not an invariant
/// to trust blindly.
#[derive(Accounts)]
pub struct Trade<'info> {
    pub signer: Signer<'info>,
    // Boxed: week-5 Task 1 added accounts to this context, which tipped
    // `Trade::try_accounts` 8 bytes past the SBF stack limit (build error, same
    // failure mode as `user_account` below). `Config` is the largest
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
    // SBF limit — moves `UserAccount`'s deserialize buffer off the stack onto
    // the heap.
    #[account(mut, seeds = [USER_SEED, user_account.owner.as_ref()], bump = user_account.bump)]
    pub user_account: Box<Account<'info, UserAccount>>,
    // Every position of this trader, one slot per market (spec §2.9.1). The
    // market is NOT in the address: each handler finds the slot whose `market`
    // equals `market.key()` (`open_index`/`alloc`), so a slot of another
    // market can never be acted on. Zero-copy — `load()`/`load_mut()` read
    // the account in place; every `RefMut` is dropped before a CPI takes it.
    #[account(
        mut,
        seeds = [POSITIONS_SEED, user_account.owner.as_ref()],
        bump = positions.load()?.bump,
        constraint = positions.load()?.owner == user_account.owner @ DexxerError::Unauthorized
    )]
    pub positions: AccountLoader<'info, Positions>,
    /// CHECK: validated in oracle::read_price (key == market.feed, owner == config.oracle_program)
    pub feed: UncheckedAccount<'info>,
    // The per-position liquidation task's payer AND authority (week-5 Task 3):
    // `open_position` registers the task with this PDA as the `ScheduleTask`
    // CPI payer, which is what makes the PROGRAM the task's authority, and
    // `close_position`/`decrease_position`-to-zero cancel with the same PDA as
    // `CancelCrankCpi.authority`. Same delegated escrow `commit_aggregate` and
    // `withdraw` pay their commit CPIs from.
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Box<Account<'info, FeeEscrow>>,
    /// CHECK: Magic Actions task-context account for this position's liquidation
    /// task (week-5 Task 3), passed to `ScheduleTask`/`CancelTask` as account
    /// index 1. No on-chain derivation for it exists in `ephemeral-rollups-sdk`
    /// 0.16.2 and the Magic Program treats it as an inert writable placeholder:
    /// any already-existing writable account is accepted and left byte-identical
    /// (week-5 Task 0, measurement 6).
    ///
    /// PINNED TO `positions` anyway (fix round 1, M-1). "Any writable account"
    /// plus `mut` would let a caller name ANOTHER trader's delegated account
    /// here, write-locking it for the duration of the transaction — a free
    /// contention/DoS handle on someone else's position, which the placeholder's
    /// inertness does nothing to prevent. Pinning it costs nothing (every client
    /// already passes the `Positions` PDA) and additionally guarantees that the
    /// registration and the later cancel name the same account. Anchor permits
    /// the duplicate key because neither field is `init`.
    #[account(mut, constraint = task_context.key() == positions.key() @ DexxerError::InvalidCandidate)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the Task 3 scheduler CPI via `.executable`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: the signer the scheduler will give this position's
    /// `liquidation_check` ticks — `crank_signer_pda(fee_escrow)`, since the
    /// `FeeEscrow` PDA is the `ScheduleTask` CPI payer and therefore the task
    /// authority (week-5 Task 0). Deliberately NOT `Config.scheduler_signer`,
    /// which is `crank_signer_pda(admin)` and belongs to the market-wide
    /// `schedule_crank` task. Verified against the derivation in
    /// `open_position` on the scheduling path only, so the ~1.5k CU
    /// `find_program_address` is not charged to every trade.
    pub liq_crank_signer: UncheckedAccount<'info>,
}

/// The account list of this position's scheduled `liquidation_check`, in
/// `ScheduleTask` order: index 0 (the payer) is prepended by the CPI, index 1
/// is the task context, 2.. are the task's own accounts.
///
/// LEAKED ON PURPOSE — for brevity, not out of necessity. `ScheduleCrankCpi`
/// wants `&'a [compat::AccountInfo<'a>]` with ONE lifetime, and
/// `AccountInfo<'a>` is invariant in `'a` (it holds a `RefCell<&'a mut [u8]>`),
/// so a slice borrowed from a local `Vec` can never satisfy THAT type —
/// `schedule_crank` works around it by making the client repeat every account
/// in `remaining_accounts`, acceptable for an admin-only instruction and not
/// for `open_position`. `Box::leak` hands back a genuinely `'info`-scoped slice
/// instead; the "leak" is ~10 `AccountInfo`s on the BPF bump allocator, which
/// is reset at the end of this instruction.
///
/// The alternative, for the record, also works and has no lifetime problem at
/// all: build the CPI instruction by hand —
/// `Instruction::new_with_bincode(MAGIC_PROGRAM_ID,
/// &MagicBlockInstruction::ScheduleTask(args), metas)` — and call
/// `solana_program::program::invoke_signed` with a plain local
/// `Vec<AccountInfo<'info>>`, since that function's slice lifetime and the
/// `AccountInfo` lifetime are independent. It was not chosen because it
/// re-implements the account-meta layout the SDK already owns (payer writable
/// signer at index 0, then each account with its own flags), and a silent
/// divergence there would be a devnet-only failure.
fn liq_task_accounts<'info>(a: &'info Trade<'info>) -> &'info [AccountInfo<'info>] {
    let infos: Vec<AccountInfo<'info>> = vec![
        a.task_context.to_account_info(),
        a.liq_crank_signer.to_account_info(),
        a.config.to_account_info(),
        a.market.to_account_info(),
        a.market_risk.to_account_info(),
        a.pool_live.to_account_info(),
        a.feed.to_account_info(),
        a.positions.to_account_info(),
        a.user_account.to_account_info(),
    ];
    Box::leak(infos.into_boxed_slice())
}

/// `open_position`'s tail: register this position's liquidation task.
///
/// Open-time registration (not init-time) is week-5 Task 0's ruling: the task
/// account list is frozen at registration, and at `init_user` time no slot
/// carries a market yet — more importantly, a task registered per user rather
/// than per open could never be cancelled on close. The id is per (trader,
/// market) — `liq_task_id(positions, market)` — so each open slot has its own
/// task, and a tick on a market whose slot is no longer open is a no-op.
/// The task registry is invisible from L1 and from an un-tokened TEE RPC
/// (Task 0, measurement 4), so registering one leaks nothing about the owner.
fn register_liq_task<'info>(a: &'info Trade<'info>) -> Result<()> {
    // The task's account list is frozen at registration, `feed` included, and
    // not every caller has already validated it through `read_price`
    // (`place_order` never reads a price). An unchecked `feed` here would let
    // a trader re-register their own task with a junk account and make every
    // later scheduled `liquidation_check` skip on `WrongFeed` — the scheduler
    // would never liquidate them again. Same two checks `read_price` makes.
    require_keys_eq!(a.feed.key(), a.market.feed, DexxerError::WrongFeed);
    require_keys_eq!(
        *a.feed.owner,
        a.config.oracle_program,
        DexxerError::WrongFeed
    );
    if !a.magic_program.executable {
        msg!("liq task: skipped (no magic program)");
        return Ok(());
    }
    let escrow: &'info Account<'info, FeeEscrow> = &a.fee_escrow;
    let payer: &'info AccountInfo<'info> = escrow.as_ref();
    require!(
        a.liq_crank_signer.key() == liq_crank_signer(&payer.key()),
        DexxerError::Unauthorized
    );
    let inner = Instruction {
        program_id: crate::ID,
        accounts: vec![
            // The scheduler accepts exactly one signer in a scheduled
            // instruction, read-only, and it must be the authority's derived
            // crank-executor PDA.
            AccountMeta::new_readonly(a.liq_crank_signer.key(), true),
            AccountMeta::new_readonly(a.config.key(), false),
            // Read-only: the mark belongs to the market-wide crank schedule.
            AccountMeta::new_readonly(a.market.key(), false),
            AccountMeta::new(a.market_risk.key(), false),
            AccountMeta::new(a.pool_live.key(), false),
            AccountMeta::new_readonly(a.feed.key(), false),
            AccountMeta::new(a.positions.key(), false),
            AccountMeta::new(a.user_account.key(), false),
        ],
        data: anchor_lang::InstructionData::data(&crate::instruction::LiquidationCheck {}),
    };
    schedule_liquidation_task(
        payer,
        &a.magic_program,
        liq_task_accounts(a),
        inner,
        liq_task_id(&a.positions.key(), &a.market.key()),
        a.fee_escrow.bump,
    )
}

/// The mirror of `register_liq_task`, called by every path that takes a
/// position from `Open` back to `Empty` BY USER ACTION: `close_position` and a
/// `decrease_position` that closes the remainder.
///
/// The liquidation paths (`crank_tick`, `liquidation_check`) deliberately do
/// NOT cancel: neither carries a `task_context`/`magic_program`, and a
/// scheduled tick cancelling the task it is running inside is untested. A task
/// left over a liquidated position is a measured-safe no-op (week-5 Task 0) —
/// it ticks, finds no open slot on its market, and returns — until the next
/// `open_position` re-registers it (an update) or `undelegate_user` cancels it.
fn cancel_liq_task<'info>(a: &'info Trade<'info>) -> Result<()> {
    // The same task also drives this market's conditional orders: while any is
    // pending (an entry order waiting on a market with no position, say) it
    // must keep ticking.
    if a.positions.load()?.has_orders_on(&a.market.key()) {
        return Ok(());
    }
    if !a.magic_program.executable {
        msg!("liq task: skipped (no magic program)");
        return Ok(());
    }
    let escrow: &'info Account<'info, FeeEscrow> = &a.fee_escrow;
    cancel_liquidation_task(
        escrow.as_ref(),
        &a.task_context,
        &a.magic_program,
        liq_task_id(&a.positions.key(), &a.market.key()),
        a.fee_escrow.bump,
    )
}

fn seed_mark(market: &mut Market, index: u64, slot: u64) {
    if market.mark == 0 {
        market.mark = index;
        market.mark_slot = slot;
    }
}

/// The state change of opening a position, shared by `open_position` and the
/// scheduled execution of entry orders (`liquidation::run_orders`).
///
/// Every check that can fail runs BEFORE the first write, so a caller that
/// swallows the error (the order executor drops the failing order and carries
/// on) never leaves a half-applied open behind.
#[allow(clippy::too_many_arguments)]
pub(crate) fn open_core(
    market: &Market,
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    positions: &mut Positions,
    side: Side,
    size: u64,
    margin: u64,
    price: u64,
    slot: u64,
) -> Result<()> {
    let idx = positions.alloc(&market_key)?;
    let chk = risk::check_open(market, risk_acc, pool, side, size, margin, price)?;
    let cost = margin
        .checked_add(chk.open_fee)
        .ok_or(DexxerError::MathOverflow)?;
    require!(user.free_margin >= cost, DexxerError::InsufficientMargin);
    let u = &mut *user;
    u.free_margin = u
        .free_margin
        .checked_sub(cost)
        .ok_or(DexxerError::MathOverflow)?;
    u.locked_margin = u
        .locked_margin
        .checked_add(margin)
        .ok_or(DexxerError::MathOverflow)?;
    let pool = &mut *pool;
    pool.locked_total = pool
        .locked_total
        .checked_add(margin)
        .ok_or(DexxerError::MathOverflow)?;
    pool.fees_accrued = pool
        .fees_accrued
        .checked_add(chk.open_fee)
        .ok_or(DexxerError::MathOverflow)?;
    let entry_notional = math::notional(size, price)?;
    let r = &mut *risk_acc;
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
    {
        positions.slots[idx] = PositionSlot {
            market: market_key,
            size,
            entry: price,
            margin,
            liq_price: chk.liq_price,
            opened_slot: slot,
            // Exact at open: entry == price, so notional(size, entry) == entry_notional.
            oi_notional: entry_notional,
            // Only oracle prints seen AFTER the open may count against it.
            last_liq_sample: market.sample_seq,
            state: SLOT_OPEN,
            side: side.as_u8(),
            liq_ticks: 0,
            _pad: [0; 5],
        };
    }

    Ok(())
}

pub fn open_position<'info>(
    mut ctx: Context<'info, Trade<'info>>,
    side: Side,
    size: u64,
    margin: u64,
    limit_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(!a.config.paused, DexxerError::Paused);
    require!(!a.market.paused_open, DexxerError::OpenPaused);
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let market_key = a.market.key();
    // Pick the slot before any money moves: `PositionNotEmpty` if this market
    // already has a position, `NoFreeSlot` when all sixteen are taken. The
    // slot itself is written only after every computation below succeeded.
    a.positions.load()?.alloc(&market_key)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    check_open_quality(&px, &a.market)?;
    check_deviation(&px, &a.market)?;
    match side {
        Side::Long => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
    }
    open_core(
        &a.market,
        market_key,
        &mut a.market_risk,
        &mut a.pool_live,
        &mut a.user_account,
        &mut *a.positions.load_mut()?,
        side,
        size,
        margin,
        px.price,
        clock.slot,
    )?;
    seed_mark(&mut a.market, px.price, clock.slot);
    // Every mutation above is done: hand the accounts over as a shared,
    // `'info`-scoped reference so the scheduler CPI can borrow them (see
    // `liq_task_accounts`).
    register_liq_task(ctx.accounts)
}

pub fn add_margin(mut ctx: Context<Trade>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(amount > 0, DexxerError::AmountZero);
    let market_key = a.market.key();
    let idx = a.positions.load()?.open_index(&market_key)?;
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
    let mut positions = a.positions.load_mut()?;
    let p = &mut positions.slots[idx];
    p.margin = p
        .margin
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    // margin > notional (leverage below 1x) has no liquidation price
    p.liq_price =
        math::liq_price(p.side(), p.entry, p.size, p.margin, a.market.mmr_bps).unwrap_or(0);
    Ok(())
}

pub fn close_position<'info>(
    mut ctx: Context<'info, Trade<'info>>,
    limit_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let market_key = a.market.key();
    let (idx, side) = {
        let positions = a.positions.load()?;
        let idx = positions.open_index(&market_key)?;
        (idx, positions.slots[idx].side())
    };
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    match side {
        Side::Long => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
    }
    let fee_bps = a.market.close_fee_bps as u32;
    {
        let mut positions = a.positions.load_mut()?;
        finalize_close(
            market_key,
            &mut a.market_risk,
            &mut a.pool_live,
            &mut a.user_account,
            &mut positions,
            idx,
            px.price,
            fee_bps,
            CloseReason::User,
            &clock,
        )?;
    } // RefMut dropped before the cancel CPI borrows the account
    cancel_liq_task(ctx.accounts)
}

pub fn increase_position(
    mut ctx: Context<Trade>,
    add_size: u64,
    add_margin: u64,
    limit_price: u64,
) -> Result<()> {
    // No task work here: the position stays open, so its task stays
    // registered and keeps ticking against the updated size/entry.

    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(!a.config.paused, DexxerError::Paused);
    require!(!a.market.paused_open, DexxerError::OpenPaused);
    let market_key = a.market.key();
    // A copy of the slot: every read below uses it, the write-back happens in
    // one place at the end.
    let (idx, pos) = {
        let positions = a.positions.load()?;
        let idx = positions.open_index(&market_key)?;
        (idx, positions.slots[idx])
    };
    require!(add_size > 0, DexxerError::AmountZero);
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    check_open_quality(&px, &a.market)?;
    check_deviation(&px, &a.market)?;
    let side = pos.side();
    match side {
        Side::Long => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
    }
    let new_size = pos
        .size
        .checked_add(add_size)
        .ok_or(DexxerError::MathOverflow)?;
    let new_margin = pos
        .margin
        .checked_add(add_margin)
        .ok_or(DexxerError::MathOverflow)?;
    let new_entry = math::vwap_entry(pos.size, pos.entry, add_size, px.price)?;
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
                .checked_sub(pos.oi_notional)
                .ok_or(DexxerError::MathOverflow)?
        }
        Side::Short => {
            risk_view.oi_short = risk_view
                .oi_short
                .checked_sub(pos.oi_notional)
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
    // Final review C1: an increase may never touch a position that is
    // liquidatable at the current mark. It used to reset `liq_ticks`, so a
    // dust increase after every print kept a liquidatable position alive
    // forever. The check runs on the WOULD-BE slot (new size, margin, VWAP
    // entry, liq price) before any state is written or money moves, against
    // the stored `Market.mark` — the price both liquidation paths use. An
    // unmarked market (`mark == 0`) has nothing to liquidate against.
    if a.market.mark != 0 {
        let would_be = PositionSlot {
            size: new_size,
            margin: new_margin,
            entry: new_entry,
            liq_price: chk.liq_price,
            ..pos
        };
        require!(
            !risk::liquidatable_now(&would_be, &a.market, a.market.mark)?,
            DexxerError::PositionLiquidatable
        );
    }
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
    let mut positions = a.positions.load_mut()?;
    let p = &mut positions.slots[idx];
    p.size = new_size;
    p.margin = new_margin;
    p.entry = new_entry;
    p.liq_price = chk.liq_price;
    // `liq_ticks` is deliberately left alone (C1): only a healthy check in
    // `liq_due` resets it.
    // Track the exact OI contribution in lock-step with the ledger above
    // (delta_notional, not a recompute off the rounded VWAP entry).
    p.oi_notional = p
        .oi_notional
        .checked_add(delta_notional)
        .ok_or(DexxerError::MathOverflow)?;
    Ok(())
}

pub fn decrease_position<'info>(
    mut ctx: Context<'info, Trade<'info>>,
    close_size: u64,
    limit_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let market_key = a.market.key();
    // A copy of the slot for every read; writes go through `load_mut` below.
    let (idx, pos) = {
        let positions = a.positions.load()?;
        let idx = positions.open_index(&market_key)?;
        (idx, positions.slots[idx])
    };
    require!(
        close_size > 0 && close_size <= pos.size,
        DexxerError::InvalidInput
    );
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let px = read_price(&a.feed.to_account_info(), &a.market, &a.config, &clock)?;
    let side = pos.side();
    match side {
        Side::Long => require!(px.price >= limit_price, DexxerError::SlippageExceeded),
        Side::Short => require!(px.price <= limit_price, DexxerError::SlippageExceeded),
    }
    if close_size == pos.size {
        let fee_bps = a.market.close_fee_bps as u32;
        {
            let mut positions = a.positions.load_mut()?;
            finalize_close(
                market_key,
                &mut a.market_risk,
                &mut a.pool_live,
                &mut a.user_account,
                &mut positions,
                idx,
                px.price,
                fee_bps,
                CloseReason::User,
                &clock,
            )?;
        } // RefMut dropped before the cancel CPI borrows the account

        // A decrease that takes the size to zero IS a close — same task
        // teardown as `close_position`.
        return cancel_liq_task(ctx.accounts);
    }
    let remaining = pos
        .size
        .checked_sub(close_size)
        .ok_or(DexxerError::MathOverflow)?;
    require!(
        remaining >= a.market.min_size,
        DexxerError::PositionTooSmall
    );
    // Floor: the remainder keeps the rounding, in the pool's favour.
    let released = ((pos.margin as u128)
        .checked_mul(close_size as u128)
        .ok_or(DexxerError::MathOverflow)?)
    .checked_div(pos.size as u128)
    .ok_or(DexxerError::MathOverflow)? as u64;
    let pnl = math::decrease_pnl(side, pos.size, close_size, pos.entry, px.price)?;
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
    // double-rounding underflow risk as `finalize_close` (see
    // `PositionSlot::oi_notional`).
    let closed_oi = ((pos.oi_notional as u128)
        .checked_mul(close_size as u128)
        .ok_or(DexxerError::MathOverflow)?)
    .checked_div(pos.size as u128)
    .ok_or(DexxerError::MathOverflow)? as u64;
    let r = &mut a.market_risk;
    match side {
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
    let mut positions = a.positions.load_mut()?;
    let p = &mut positions.slots[idx];
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
    p.liq_price = math::liq_price(side, p.entry, p.size, p.margin, a.market.mmr_bps).unwrap_or(0);
    // Final review I3: the realised part goes into the owner's history, like
    // a close — otherwise its PnL would never show. The slot stays open, so
    // this is its own kind, `HISTORY_REASON_DECREASE`, not a `CloseReason`.
    // No CPI follows on this path; the `RefMut` ends with the function.
    positions.push_history(HistoryRecord {
        market: market_key,
        size: close_size,
        entry: pos.entry,
        exit: px.price,
        pnl,
        fees: s.fee_taken,
        opened_slot: pos.opened_slot,
        closed_slot: clock.slot,
        side: pos.side,
        reason: HISTORY_REASON_DECREASE,
        _pad: [0; 6],
    });
    Ok(())
}

/// Shared by close_position, decrease_position (full) and both liquidation
/// paths (`crank_tick`, `liquidation_check`).
///
/// Settles the money on the slot `idx` of `positions` — which every caller
/// found by `market_key` (`open_index`/`find_open`), so it is always this
/// market's open slot — records the close in the owner's private history
/// ring, and clears the slot to all-zero bytes in one step, so a trader can
/// reopen immediately. Trades are not disclosed (spec §2.9), so nothing is
/// queued; the history ring overwrites its oldest record, so nothing here can
/// fail on a full buffer — only on a genuine accounting error.
#[allow(clippy::too_many_arguments)]
pub fn finalize_close(
    market_key: Pubkey,
    risk_acc: &mut MarketRisk,
    pool: &mut PoolLive,
    user: &mut UserAccount,
    positions: &mut Positions,
    idx: usize,
    exit: u64,
    fee_bps: u32,
    reason: CloseReason,
    clock: &Clock,
) -> Result<Settlement> {
    let pos = positions.slots[idx];
    // Defence in depth: every caller already resolved `idx` from `market_key`.
    require!(
        pos.is_open() && pos.market == market_key,
        DexxerError::PositionNotOpen
    );
    let side = pos.side();
    let notional_exit = math::notional(pos.size, exit)?;
    let pnl = math::upnl(side, pos.size, pos.entry, exit)?;
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
    match side {
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
    risk_acc.open_positions = risk_acc
        .open_positions
        .checked_sub(1)
        .ok_or(DexxerError::MathOverflow)?;
    positions.push_history(HistoryRecord {
        market: market_key,
        size: pos.size,
        entry: pos.entry,
        exit,
        pnl,
        fees: s.fee_taken,
        opened_slot: pos.opened_slot,
        closed_slot: clock.slot,
        side: pos.side,
        reason: reason.as_u8(),
        _pad: [0; 6],
    });
    // Every byte back to zero, `market` included: leaving any field set would
    // show a phantom trade to the owner's client.
    positions.clear_slot(idx);
    // Reduce-only orders protect THIS position; they die with it (OCO).
    positions.clear_reduce_only(&market_key);
    Ok(s)
}

// ------------------------------------------------------------ conditional orders

/// Place (or, for reduce-only kinds, replace) a conditional order on this
/// market.
///
/// * Entry orders (`Limit`, `Stop`) need NO open position on the market;
///   `size`/`margin` are what will be opened, `tp`/`sl` (0 = none) are
///   attached on fill.
/// * Reduce-only orders (`TakeProfit`, `StopLoss`, `TrailingStop`) need an
///   open position on the market, always close all of it, and live one per
///   kind and market — placing another replaces the old one. `side`, `size`
///   and `margin` are ignored.
///
/// No margin is reserved at placement: the order is checked against the
/// owner's free margin and the risk limits when it fires, and dropped if it
/// no longer fits. Any placement (re-)registers the (trader, market)
/// scheduled task, which is also what executes the orders; registering an
/// existing task id is an update, not an error (week-5 Task 0).
#[allow(clippy::too_many_arguments)]
pub fn place_order<'info>(
    mut ctx: Context<'info, Trade<'info>>,
    kind: OrderKind,
    side: Side,
    size: u64,
    margin: u64,
    trigger: u64,
    trail_bps: u16,
    tp: u64,
    sl: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    require!(!a.config.paused, DexxerError::Paused);
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    require!(kind != OrderKind::None, DexxerError::InvalidOrder);
    let market_key = a.market.key();
    let mark = a.market.mark;
    {
        let mut positions = a.positions.load_mut()?;
        let open = positions.find_open(&market_key);
        let order = if kind.is_entry() {
            require!(open.is_none(), DexxerError::PositionNotEmpty);
            require!(
                trigger > 0 && size >= a.market.min_size && margin > 0,
                DexxerError::InvalidOrder
            );
            // Attached exits must sit on the correct side of the entry trigger.
            match side {
                Side::Long => require!(
                    (tp == 0 || tp > trigger) && (sl == 0 || sl < trigger),
                    DexxerError::InvalidOrder
                ),
                Side::Short => require!(
                    (tp == 0 || tp < trigger) && (sl == 0 || sl > trigger),
                    DexxerError::InvalidOrder
                ),
            }
            OrderSlot {
                market: market_key,
                trigger,
                size,
                margin,
                extreme: 0,
                tp,
                sl,
                kind: kind.as_u8(),
                side: side.as_u8(),
                trail_bps: 0,
                _pad: [0; 4],
            }
        } else {
            let idx = open.ok_or(DexxerError::PositionNotOpen)?;
            let pside = positions.slots[idx].side();
            let mut o = OrderSlot {
                market: market_key,
                trigger: 0,
                size: 0,
                margin: 0,
                extreme: 0,
                tp: 0,
                sl: 0,
                kind: kind.as_u8(),
                side: pside.as_u8(),
                trail_bps: 0,
                _pad: [0; 4],
            };
            if kind == OrderKind::TrailingStop {
                require!(
                    (MIN_TRAIL_BPS..=MAX_TRAIL_BPS).contains(&trail_bps) && mark > 0,
                    DexxerError::InvalidOrder
                );
                o.trail_bps = trail_bps;
                o.extreme = mark;
            } else {
                require!(trigger > 0, DexxerError::InvalidOrder);
                // A TP/SL that is already past the mark would fire on the next
                // tick — almost certainly a fat-fingered price, so refuse it.
                if mark > 0 {
                    require!(
                        !is_triggered(kind, pside, trigger, mark),
                        DexxerError::InvalidOrder
                    );
                }
                o.trigger = trigger;
            }
            o
        };
        let idx = if kind.is_reduce_only() {
            positions
                .find_order(&market_key, kind)
                .or_else(|| positions.free_order_slot())
        } else {
            positions.free_order_slot()
        }
        .ok_or(DexxerError::OrderBookFull)?;
        positions.orders[idx] = order;
    } // RefMut dropped before the scheduler CPI borrows the account
    register_liq_task(ctx.accounts)
}

/// Cancel the order in `slot`. When the last order on a market with no open
/// position goes, that market's scheduled task is cancelled with it.
pub fn cancel_order<'info>(mut ctx: Context<'info, Trade<'info>>, slot: u8) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    assert_trader(&a.signer.key(), &mut a.user_account, clock.unix_timestamp)?;
    let market_key = a.market.key();
    let idle = {
        let mut positions = a.positions.load_mut()?;
        let o = positions
            .orders
            .get_mut(slot as usize)
            .ok_or(DexxerError::OrderNotFound)?;
        // Only this market's orders: the account is shared by every market.
        require!(
            !o.is_empty() && o.market == market_key,
            DexxerError::OrderNotFound
        );
        *o = bytemuck::Zeroable::zeroed();
        positions.find_open(&market_key).is_none()
    }; // RefMut dropped before the cancel CPI borrows the account
    if idle {
        // `cancel_liq_task` keeps the task alive while any order remains; an
        // open position keeps it for liquidation regardless.
        return cancel_liq_task(ctx.accounts);
    }
    Ok(())
}
