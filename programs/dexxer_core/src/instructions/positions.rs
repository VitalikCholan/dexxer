// programs/dexxer_core/src/instructions/positions.rs
//
// An owner's `Position` on every market beyond the SOL one `init_user` creates
// (spec §2.8.2): enable a market (`init_position` + `delegate_position` on L1,
// `init_position_permission` in the ER), and take an extra position back out
// on exit (`undelegate_position` in the ER, `close_exited_position` on L1).
//
// Every owner gets a position on EVERY market, created together and never at
// trade time (spec §2.8, "Приватність"): the PDA `[position, owner, market]`
// lives on L1, where nothing filters reads, so creating it at the first trade
// would publish which markets a trader uses and when they started.
use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
        structs::{EphemeralMembersArgs, EphemeralPermission, PERMISSION_SEED},
    },
    anchor::delegate,
    consts::{
        DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
        PERMISSION_PROGRAM_ID,
    },
    cpi::DelegateConfig,
    ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder},
    ephemeral_accounts::rent,
};

use crate::{
    errors::DexxerError,
    instructions::{liquidation::cancel_liquidation_task, user::close_permission_if_present},
    state::*,
};

/// The owner is onboarded and has not exited. On L1 an active `UserAccount` is
/// delegated — owned by the Delegation Program, bytes frozen at delegation, so
/// `exited` is unreadable there, but an exited account is always handed back to
/// this program first. Owned by this program means mid-onboarding (or LiteSVM,
/// which has no delegation program) or exited: read it.
pub(crate) fn require_user_active(ua: &AccountInfo) -> Result<()> {
    require!(!ua.data_is_empty(), DexxerError::NotOnboarded);
    if ua.owner == &crate::ID {
        let u = UserAccount::try_deserialize(&mut &ua.try_borrow_data()?[..])?;
        require!(!u.exited, DexxerError::UserExited);
        return Ok(());
    }
    require!(
        ua.owner == &DELEGATION_PROGRAM_ID,
        DexxerError::NotOnboarded
    );
    Ok(())
}

/// The owner has left: their `UserAccount` is gone, or present under this
/// program with `exited`. Anything else — live, still delegated, foreign — is
/// "not left": the conservative answer for instructions that act on an
/// owner's position without the owner's signature.
pub(crate) fn user_has_left(ua: &AccountInfo) -> Result<bool> {
    if ua.data_is_empty() {
        return Ok(true);
    }
    if ua.owner != &crate::ID {
        return Ok(false);
    }
    let u = UserAccount::try_deserialize(&mut &ua.try_borrow_data()?[..])?;
    Ok(u.exited)
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct InitPosition<'info> {
    pub owner: Signer<'info>,
    /// Funds the rent and the permission prefund — `fee_payer` via `/sponsor`
    /// for a 0-SOL owner, or the owner.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: pinned by the symbol seed; a live market is delegated on L1, so
    /// it cannot be a typed `Account<Market>` (same reason as
    /// `InitUser.market`). Existence is checked in the handler.
    #[account(seeds = [MARKET_SEED, &symbol], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: read by `require_user_active` — delegated on L1 for an active
    /// owner, so it cannot be typed.
    #[account(seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    // Boxed like every `Position` in an init context (SBF stack frame).
    #[account(
        init,
        payer = payer,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    pub system_program: Program<'info, System>,
}

pub fn init_position(ctx: Context<InitPosition>, _symbol: [u8; 8]) -> Result<()> {
    require!(
        !ctx.accounts.market.data_is_empty(),
        DexxerError::MarketNotFound
    );
    require_user_active(&ctx.accounts.user_account.to_account_info())?;
    let p = &mut ctx.accounts.position;
    p.version = 1;
    p.owner = ctx.accounts.owner.key();
    p.market = ctx.accounts.market.key();
    p.state = PositionState::Empty;
    p.side = Side::Long;
    p.bump = ctx.bumps.position;
    // Same prefund as `init_user`: inside the ER the permission's rent is paid
    // by the permissioned PDA itself (spike 01 pattern).
    let extra = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.position.to_account_info(),
            },
        ),
        extra,
    )
}

#[delegate]
#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct DelegatePosition<'info> {
    pub owner: Signer<'info>,
    /// Funds the delegation records (as `DelegateUser.payer`).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: market key for the position seed
    #[account(seeds = [MARKET_SEED, &symbol], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: read by `require_user_active`
    #[account(seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
}

pub fn delegate_position(ctx: Context<DelegatePosition>, symbol: [u8; 8]) -> Result<()> {
    // The SOL position is delegated by `delegate_user`; doing it here first
    // would make that call fail and strand the onboarding.
    require!(symbol != SOL_SYMBOL, DexxerError::PrimaryPositionMismatch);
    require_user_active(&ctx.accounts.user_account.to_account_info())?;
    let o = ctx.accounts.owner.key();
    let m = ctx.accounts.market.key();
    ctx.accounts.delegate_position(
        &ctx.accounts.payer,
        &[POSITION_SEED, o.as_ref(), m.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

/// Owner, or the owner's live session key (not consuming `actions_left` —
/// making one's own position private is not a trade).
fn is_owner_or_live_session(signer: &Pubkey, u: &UserAccount, now: i64) -> bool {
    *signer == u.owner
        || (u.session_key != Pubkey::default()
            && *signer == u.session_key
            && now < u.session_expiry)
}

// ER: make a freshly delegated position private, `[owner, session, crank]`
// (session from `UserAccount.session_key`) — the per-market twin of
// `init_permissions`. Signable by the session key, so the app can enable new
// markets in the ER without a wallet prompt.
#[derive(Accounts)]
pub struct InitPositionPermission<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(seeds = [USER_SEED, position.owner.as_ref()], bump = user_account.bump)]
    pub user_account: Box<Account<'info, UserAccount>>,
    /// CHECK: permission PDA of `position`, under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK:
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn init_position_permission(ctx: Context<InitPositionPermission>) -> Result<()> {
    let a = &ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    require!(
        is_owner_or_live_session(&a.signer.key(), &a.user_account, now),
        DexxerError::Unauthorized
    );
    require!(!a.user_account.exited, DexxerError::UserExited);
    // LiteSVM and L1 have no permission program — authorization above still ran.
    if !a.permission_program.to_account_info().executable {
        return Ok(());
    }
    let o = a.position.owner;
    let m = a.position.market;
    let pb = [a.position.bump];
    let seeds: &[&[u8]] = &[POSITION_SEED, o.as_ref(), m.as_ref(), &pb];
    let args = EphemeralMembersArgs {
        is_private: true,
        members: build_members(o, a.user_account.session_key, a.config.crank),
    };
    let acc = a.position.to_account_info();
    let perm = a.position_permission.to_account_info();
    // Ownership, not lamports, detects an existing permission (a fresh one has
    // 0 lamports — its rent lives in the shared vault; see `init_permissions`).
    if perm.owner == &PERMISSION_PROGRAM_ID {
        UpdateEphemeralPermissionCpi {
            payer: acc.clone(),
            permissioned_account: acc.clone(),
            permission: perm.clone(),
            vault: a.ephemeral_vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            authority: acc.clone(),
            authority_is_signer: false,
            args,
        }
        .invoke_signed(&[seeds])?;
    } else {
        CreateEphemeralPermissionCpi {
            payer: acc.clone(),
            permissioned_account: acc.clone(),
            permission: perm.clone(),
            vault: a.ephemeral_vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            args,
        }
        .invoke_signed(&[seeds])?;
    }
    Ok(())
}

// ER: an extra position leaves the rollup on exit — the per-market twin of the
// position half of `undelegate_user`. `Position::Empty` is the privacy gate:
// `finalize_close` zeroes every trade field (trade.rs), so the committed bytes
// carry nothing. Owner-signed normally; the crank may do it only for an owner
// who has left (an exit the app did not finish).
#[derive(Accounts)]
pub struct UndelegatePosition<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the owner's `UserAccount` if it still exists — read by
    /// `user_has_left` on the crank path.
    #[account(seeds = [USER_SEED, position.owner.as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `position`
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK: shared ER vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to
    /// Config.magic_fee_vault (as in `UndelegateUser`)
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext`; only written when `magic_program` is executable
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: gates the CPIs via `.executable`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn undelegate_position<'info>(ctx: Context<'info, UndelegatePosition<'info>>) -> Result<()> {
    let a = ctx.accounts;
    require!(
        a.position.state == PositionState::Empty,
        DexxerError::HasOpenPosition
    );
    // The SOL position leaves with the user (`undelegate_user`).
    require_keys_neq!(
        a.position.market,
        sol_market_key(),
        DexxerError::PrimaryPositionMismatch
    );
    let signer = a.signer.key();
    let authorized = signer == a.position.owner
        || (signer == a.config.crank && user_has_left(&a.user_account.to_account_info())?);
    require!(authorized, DexxerError::Unauthorized);

    let o = a.position.owner;
    let m = a.position.market;
    let pb = [a.position.bump];
    // Flush before any CPI can move the owner (ruling 10) — a no-op write, but
    // it keeps Anchor's automatic post-handler exit from ever changing bytes.
    a.position.exit(&crate::ID)?;
    close_permission_if_present(
        &a.position.to_account_info(),
        &a.position_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[POSITION_SEED, o.as_ref(), m.as_ref(), &pb],
    )?;

    // Shared `'info` reference for the scheduler CPI (see `undelegate_user`).
    let a: &'info UndelegatePosition<'info> = a;
    // Absent on LiteSVM — skip, as `undelegate_user` does.
    if a.magic_program.to_account_info().executable {
        let escrow: &'info Account<'info, FeeEscrow> = &a.fee_escrow;
        let position: &'info Account<'info, Position> = &a.position;
        // An Empty position's task was normally cancelled at close; cancelling
        // an unknown task id is a measured no-op (week 5). A liquidated
        // position's task is still live — this is its only cleanup.
        cancel_liquidation_task(
            escrow.as_ref(),
            position.as_ref(),
            &a.magic_program,
            liq_task_id(&position.key()),
            a.fee_escrow.bump,
        )?;
        let bump = a.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(
            a.fee_escrow.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[a.position.to_account_info()])
        .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// L1: reclaim an extra position's rent once it is back under this program,
// Empty, and its owner has left — the per-market twin of `close_exited_user`
// (same typed-`Account` gate: it cannot touch a still-delegated position).
#[derive(Accounts)]
pub struct CloseExitedPosition<'info> {
    #[account(mut, constraint = fee_payer.key() == config.fee_payer @ DexxerError::Unauthorized)]
    pub fee_payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = fee_payer,
        seeds = [POSITION_SEED, position.owner.as_ref(), position.market.as_ref()],
        bump = position.bump,
        constraint = position.state == PositionState::Empty @ DexxerError::HasOpenPosition
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: the owner's `UserAccount` if any — `user_has_left` must hold (a
    /// still-delegated account means an active owner).
    #[account(seeds = [USER_SEED, position.owner.as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
}

pub fn close_exited_position(ctx: Context<CloseExitedPosition>) -> Result<()> {
    // The SOL position closes with the user (`close_exited_user`); closing it
    // here would leave `init_user_reuse_queue` without it — no re-onboarding.
    require_keys_neq!(
        ctx.accounts.position.market,
        sol_market_key(),
        DexxerError::PrimaryPositionMismatch
    );
    require!(
        user_has_left(&ctx.accounts.user_account.to_account_info())?,
        DexxerError::NotExited
    );
    Ok(())
}
