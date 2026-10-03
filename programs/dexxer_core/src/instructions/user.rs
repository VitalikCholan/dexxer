use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
        structs::{EphemeralMembersArgs, EphemeralPermission, PERMISSION_SEED},
    },
    anchor::delegate,
    consts::{EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder},
    ephemeral_accounts::rent,
};

use crate::{
    errors::DexxerError,
    instructions::liquidation::cancel_liquidation_task,
    state::*,
    token::{transfer_signed_by_owner, transfer_signed_by_pool},
};

/// Authorize an instruction as coming from either the account owner or a
/// live, non-expired session key with remaining actions. Consumes one action
/// when authorizing via the session key. Used by Task 7/8/9 trading instructions.
pub fn assert_trader(signer: &Pubkey, user: &mut UserAccount, now: i64) -> Result<()> {
    if *signer == user.owner {
        return Ok(());
    }
    require!(
        user.session_key != Pubkey::default() && *signer == user.session_key,
        DexxerError::Unauthorized
    );
    require!(now < user.session_expiry, DexxerError::SessionExpired);
    require!(user.actions_left > 0, DexxerError::NoActionsLeft);
    user.actions_left = user
        .actions_left
        .checked_sub(1)
        .ok_or(DexxerError::MathOverflow)?;
    Ok(())
}

/// Shared faucet mint logic: rolls the daily window forward when it has
/// elapsed, then enforces the daily cap before minting.
#[allow(clippy::too_many_arguments)]
fn mint_with_limit<'info>(
    f: &mut Faucet,
    now: i64,
    amount: u64,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    mint_auth: &AccountInfo<'info>,
    bump: u8,
    tp: &Program<'info, Token>,
) -> Result<()> {
    require!(amount > 0, DexxerError::AmountZero);
    let elapsed = now
        .checked_sub(f.day_start)
        .ok_or(DexxerError::MathOverflow)?;
    if elapsed >= 86_400 {
        f.day_start = now;
        f.minted_today = 0;
    }
    let next = f
        .minted_today
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    require!(next <= FAUCET_DAILY_LIMIT, DexxerError::FaucetLimit);
    f.minted_today = next;
    let seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            tp.key(),
            MintTo {
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: mint_auth.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct FaucetInit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    // Fix round 1 (week 4, task 6 controller ruling): sponsored-rent onboarding —
    // `fee_payer` (relayer) fronts the `Faucet` PDA's rent instead of `owner`, so a
    // genuinely 0-SOL owner can still complete onboarding through `POST /sponsor`.
    // `owner` remains the sole signer/authority everywhere else (`has_one`, seeds,
    // `token::authority`) — only the rent-paying account changes.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = dusdc_mint)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + Faucet::INIT_SPACE,
        seeds = [FAUCET_SEED, owner.key().as_ref()],
        bump
    )]
    pub faucet: Account<'info, Faucet>,
    #[account(mut)]
    pub dusdc_mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority, seeds-checked below
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(mut, token::mint = dusdc_mint, token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}
pub fn faucet_init(ctx: Context<FaucetInit>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let f = &mut ctx.accounts.faucet;
    f.version = 1;
    f.owner = ctx.accounts.owner.key();
    f.day_start = now;
    f.minted_today = 0;
    f.bump = ctx.bumps.faucet;
    let bump = ctx.bumps.mint_auth;
    mint_with_limit(
        &mut ctx.accounts.faucet,
        now,
        amount,
        &ctx.accounts.dusdc_mint,
        &ctx.accounts.owner_ata,
        &ctx.accounts.mint_auth.to_account_info(),
        bump,
        &ctx.accounts.token_program,
    )
}

#[derive(Accounts)]
pub struct FaucetMint<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = dusdc_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [FAUCET_SEED, owner.key().as_ref()], bump = faucet.bump, has_one = owner)]
    pub faucet: Account<'info, Faucet>,
    #[account(mut)]
    pub dusdc_mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority, seeds-checked below
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(mut, token::mint = dusdc_mint, token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn faucet_mint(ctx: Context<FaucetMint>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.mint_auth;
    mint_with_limit(
        &mut ctx.accounts.faucet,
        now,
        amount,
        &ctx.accounts.dusdc_mint,
        &ctx.accounts.owner_ata,
        &ctx.accounts.mint_auth.to_account_info(),
        bump,
        &ctx.accounts.token_program,
    )
}

#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    // Fix round 1 (week 4, task 6 controller ruling): `fee_payer` fronts the
    // rent for `UserAccount`/`Positions` and the two per-PDA
    // `EphemeralPermission` prefund transfers below, instead of
    // `owner` — see `FaucetInit`'s `payer` field for the same rationale.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    // Every position of this trader, one slot per market (spec §2.9.1). No
    // market in the seeds: which markets a trader uses never shows on L1, and
    // a new market costs the trader no new account. Zero-copy (3.1 KiB).
    #[account(
        init,
        payer = payer,
        space = Positions::SPACE,
        seeds = [POSITIONS_SEED, owner.key().as_ref()],
        bump
    )]
    pub positions: AccountLoader<'info, Positions>,
    pub system_program: Program<'info, System>,
}
pub fn init_user(ctx: Context<InitUser>, exit_salt: [u8; 32]) -> Result<()> {
    let o = ctx.accounts.owner.key();
    let u = &mut ctx.accounts.user_account;
    u.version = USER_ACCOUNT_VERSION;
    u.owner = o;
    u.exit_salt = exit_salt;
    u.rent_payer = ctx.accounts.payer.key();
    u.bump = ctx.bumps.user_account;
    {
        // Every slot and history record starts all-zero (`SLOT_EMPTY`).
        let mut p = ctx.accounts.positions.load_init()?;
        p.owner = o;
        p.version = 1;
        p.bump = ctx.bumps.positions;
    } // RefMut dropped before the prefund CPI below takes the account
      // spec §8 Q2: each PDA pays for its own EphemeralPermission inside the ER
      // (spike 01 pattern) — prefund that rent on L1 at creation time.
    let extra = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
    for to in [
        ctx.accounts.user_account.to_account_info(),
        ctx.accounts.positions.to_account_info(),
    ] {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to,
                },
            ),
            extra,
        )?;
    }
    Ok(())
}

// spec §8 Q2: rebuild the per-user `EphemeralPermission` member lists
// whenever the session key changes, so the new session key can read ER state
// and the old one loses access. Same account set as `InitPermissions` (see
// there for the permission-PDA shape).
#[derive(Accounts)]
pub struct SetSession<'info> {
    pub owner: Signer<'info>,
    // Boxed (same reason as `InitPermissions` below): this many accounts
    // alongside each other blows the SBF stack frame in `try_accounts`.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, seeds = [POSITIONS_SEED, owner.key().as_ref()], bump = positions.load()?.bump,
        constraint = positions.load()?.owner == owner.key() @ DexxerError::Unauthorized)]
    pub positions: AccountLoader<'info, Positions>,
    /// CHECK: permission PDAs under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, user_account.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub user_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, seeds = [PERMISSION_SEED, positions.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub positions_permission: UncheckedAccount<'info>,
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
pub fn set_session<'info>(
    ctx: Context<'info, SetSession<'info>>,
    session_key: Pubkey,
    expiry: i64,
    actions: u32,
) -> Result<()> {
    let u = &mut ctx.accounts.user_account;
    u.session_key = session_key;
    u.session_expiry = expiry;
    u.actions_left = actions;

    let o = ctx.accounts.owner.key();
    let members = build_members(o, session_key, ctx.accounts.config.crank);
    let ub = [ctx.accounts.user_account.bump];
    // `load()` borrow ends with this statement, before the CPIs below.
    let pb = [ctx.accounts.positions.load()?.bump];
    let pairs: [(AccountInfo, AccountInfo, Vec<&[u8]>); 2] = [
        (
            ctx.accounts.user_account.to_account_info(),
            ctx.accounts.user_permission.to_account_info(),
            vec![USER_SEED, o.as_ref(), &ub],
        ),
        (
            ctx.accounts.positions.to_account_info(),
            ctx.accounts.positions_permission.to_account_info(),
            vec![POSITIONS_SEED, o.as_ref(), &pb],
        ),
    ];
    for (acc, perm, seeds) in pairs.iter() {
        // Skip when the permission account doesn't exist yet: LiteSVM (no
        // permission program at all) and the L1 (permissions only ever live
        // in the ER, created there by `init_permissions` after delegation).
        if perm.owner != &PERMISSION_PROGRAM_ID {
            continue;
        }
        UpdateEphemeralPermissionCpi {
            payer: acc.clone(),
            permissioned_account: acc.clone(),
            permission: perm.clone(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: acc.clone(),
            authority_is_signer: false, // PDA signs via the seeds below
            args: EphemeralMembersArgs {
                is_private: true,
                members: members.clone(),
            },
        }
        .invoke_signed(&[seeds.as_slice()])?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct CreditDeposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Account<'info, UserAccount>,
    // NOT `mut` (week-4 Task 1): `Pool` is only written by `init_pool`/`seed_pool`/
    // `commit_aggregate` now — kept here read-only, purely for `vault_ata`'s
    // `has_one` check and `mint`.
    #[account(seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump, has_one = vault_ata)]
    pub pool: Account<'info, Pool>,
    // Live pool counters — the actual write target for this deposit.
    #[account(mut, seeds = [POOL_LIVE_SEED, pool.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Account<'info, PoolLive>,
    #[account(mut, token::mint = pool.mint, token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
pub fn credit_deposit(ctx: Context<CreditDeposit>, amount: u64) -> Result<()> {
    require!(amount > 0, DexxerError::AmountZero);
    transfer_signed_by_owner(
        &ctx.accounts.token_program,
        &ctx.accounts.owner_ata,
        &ctx.accounts.vault_ata,
        &ctx.accounts.owner,
        amount,
    )?;
    let u = &mut ctx.accounts.user_account;
    u.free_margin = u
        .free_margin
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    let p = &mut ctx.accounts.pool_live;
    p.capital_total = p
        .capital_total
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    Ok(())
}

// Mirror image of `CreditDeposit`: owner-only (money leaves the system, so
// the session-key path in `assert_trader` does not apply here), debits
// `free_margin`/`pool.capital_total`, and transfers `vault_ata -> owner_ata`
// signed by the pool PDA. `magic_context`/`magic_program` are plain
// `UncheckedAccount`s (not the `#[commit]` macro's `Program<MagicProgram>`)
// so the commit CPI can be gated on `magic_program.executable` in the body:
// on LiteSVM no program is deployed at that fixed address, so the account is
// absent/non-executable and the CPI is skipped; on the ER it is the real
// Magic program and the CPI runs.
//
// Week-2 Task 5 fix round 1 (controller ruling, item 3): `withdraw`'s commit
// intent originally used `owner` (a plain wallet) as the CPI payer. Verified
// directly on devnet after the fix round's own program change landed
// elsewhere: a real `withdraw` call's `UserAccount` commit intent had still
// not reached base layer after 30+ minutes of polling (see task-5-report.md
// "fix round 1" — genuinely stuck, not merely slow like `Pool`'s first
// commit). Routed through the same `fee_escrow` PDA `commit_aggregate` now
// uses, via `invoke_signed`.
//
// Fix round 1, round-trip 2: the first version of this fix omitted
// `.magic_fee_vault(...)` (reasoned it wasn't needed — this path doesn't
// need the fee-vault's higher commit ceiling). Real devnet run disagreed:
// failed with `InstructionError::MissingAccount` ("An account required by
// the instruction is missing"), a base Solana runtime error, not an Anchor
// one — the validator expects the vault account in the CPI's account list
// whenever the payer is delegated, independent of commit volume. Added here
// to match `commit_aggregate` exactly. `config` is `Box`ed (same reason as
// `InitPermissions`/`SetSession` elsewhere in this file): with `magic_fee_vault`
// added alongside the existing `owner_ata`/`vault_ata`/`pool`/`user_account`,
// this context blew the SBF stack frame (`Access violation in stack frame 5`)
// without it.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Account<'info, UserAccount>,
    // NOT `mut` (week-4 Task 1, same reasoning as `CreditDeposit.pool`): only the
    // vault-authority signing seeds and `has_one = vault_ata`/`mint` are read here.
    #[account(seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump, has_one = vault_ata)]
    pub pool: Account<'info, Pool>,
    // Boxed (same reason as `config` below): this context is already at the SBF
    // stack-frame limit — adding `pool_live` unboxed overflowed it by 8 bytes
    // (`anchor build` autofixer finding, week-4 Task 1).
    #[account(mut, seeds = [POOL_LIVE_SEED, pool.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Box<Account<'info, PoolLive>>,
    #[account(mut, token::mint = pool.mint, token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to Config.magic_fee_vault
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the commit CPI via `.executable` in `withdraw`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount >= MIN_WITHDRAW, DexxerError::InvalidParams);
    let clock = Clock::get()?;
    let u = &mut ctx.accounts.user_account;
    let cooldown_ends = u
        .last_withdraw_slot
        .checked_add(WITHDRAW_COOLDOWN_SLOTS)
        .ok_or(DexxerError::MathOverflow)?;
    require!(clock.slot >= cooldown_ends, DexxerError::WithdrawCooldown);
    require!(u.free_margin >= amount, DexxerError::InsufficientMargin);
    u.free_margin = u
        .free_margin
        .checked_sub(amount)
        .ok_or(DexxerError::MathOverflow)?;
    u.last_withdraw_slot = clock.slot;
    let live = &mut ctx.accounts.pool_live;
    live.capital_total = live
        .capital_total
        .checked_sub(amount)
        .ok_or(DexxerError::MathOverflow)?;
    let mint = ctx.accounts.pool.mint;
    let pool_bump = ctx.accounts.pool.bump;
    transfer_signed_by_pool(
        &ctx.accounts.token_program,
        &ctx.accounts.vault_ata,
        &ctx.accounts.owner_ata,
        &ctx.accounts.pool.to_account_info(),
        &mint,
        pool_bump,
        amount,
    )?;
    // Only in a real ER does a Magic program actually live at this address;
    // on LiteSVM (and any environment without the ER runtime) it is absent,
    // so skip the commit CPI rather than fail the withdrawal.
    if ctx.accounts.magic_program.to_account_info().executable {
        let bump = ctx.accounts.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(
            ctx.accounts.fee_escrow.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.user_account.to_account_info()])
        .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// spec §8 Q2: delegate the user-scoped PDAs to the TEE validator. Seeds
// already pin `owner` on `user_account`/`positions`, so no extra `has_one`
// check is needed before delegating them.
#[delegate]
#[derive(Accounts)]
pub struct DelegateUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    // Week-5 Task 3 (P1): the rent for the delegation records is the
    // last owner-paid cost of onboarding (~0.004 SOL), which is what keeps the
    // one-tap flow from being 0-SOL. Splitting `payer` out of `owner` lets the
    // relayer's sponsor key fund it while the owner still signs for its own
    // PDAs. `payer == owner` remains valid and is what the tests use.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [POSITIONS_SEED, owner.key().as_ref()], bump)]
    pub positions: UncheckedAccount<'info>,
}
pub fn delegate_user(ctx: Context<DelegateUser>) -> Result<()> {
    // Fix round 1 (controller ruling, IMPORTANT 2): `user_account` is an
    // `UncheckedAccount` here (the `#[delegate]` macro's shape), so nothing
    // would otherwise stop an exited account from being re-delegated straight
    // back into the ER — scrubbed, `exit_salt` zeroed, `exited` still set.
    // An exited owner re-onboards only after `close_exited_user` has closed
    // the old PDAs, through a fresh `init_user`. Read it manually: before
    // delegation the account is still owned by this program, so a plain
    // `try_deserialize` is valid (and fails on its own with
    // `AccountDidNotDeserialize` for a short legacy v1 account). Scoped so the
    // data borrow is released before the delegation CPI reassigns the owner.
    // No explicit `owner == crate::ID` check is needed even though this is a
    // raw deserialize: the address is PDA-derived by the `#[delegate]` macro's
    // `seeds = [USER_SEED, owner.key()]` constraint, so no foreign-owned
    // account can occupy this slot and be read as a `UserAccount`.
    // (`UserExited`, not `NotExited`: the account HAS exited — final review.)
    {
        let data = ctx.accounts.user_account.try_borrow_data()?;
        let u = UserAccount::try_deserialize(&mut &data[..])?;
        require!(!u.exited, DexxerError::UserExited);
    }
    let o = ctx.accounts.owner.key();
    ctx.accounts.delegate_user_account(
        &ctx.accounts.payer,
        &[USER_SEED, o.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    ctx.accounts.delegate_positions(
        &ctx.accounts.payer,
        &[POSITIONS_SEED, o.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

// spec §8 Q2: create — or, if already public from week 1, flip — the ER-side
// `EphemeralPermission` account for each of the delegated per-user PDAs. Private
// with `[owner, session, crank]` members (session omitted until issued).
#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    // Boxed (task-2 finding: with `config` added and every permission/vault/
    // magic account alongside them, `config`/`user_account` blow the SBF stack
    // frame in `try_accounts`).
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, seeds = [POSITIONS_SEED, owner.key().as_ref()], bump = positions.load()?.bump,
        constraint = positions.load()?.owner == owner.key() @ DexxerError::Unauthorized)]
    pub positions: AccountLoader<'info, Positions>,
    /// CHECK: permission PDAs under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, user_account.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub user_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, seeds = [PERMISSION_SEED, positions.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub positions_permission: UncheckedAccount<'info>,
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
pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
    let o = ctx.accounts.owner.key();
    let members = build_members(
        o,
        ctx.accounts.user_account.session_key,
        ctx.accounts.config.crank,
    );
    let ub = [ctx.accounts.user_account.bump];
    // `load()` borrow ends with this statement, before the CPIs below.
    let pb = [ctx.accounts.positions.load()?.bump];
    let pairs: [(AccountInfo, AccountInfo, Vec<&[u8]>); 2] = [
        (
            ctx.accounts.user_account.to_account_info(),
            ctx.accounts.user_permission.to_account_info(),
            vec![USER_SEED, o.as_ref(), &ub],
        ),
        (
            ctx.accounts.positions.to_account_info(),
            ctx.accounts.positions_permission.to_account_info(),
            vec![POSITIONS_SEED, o.as_ref(), &pb],
        ),
    ];
    for (acc, perm, seeds) in pairs.iter() {
        let args = EphemeralMembersArgs {
            is_private: true,
            members: members.clone(),
        };
        // Task-13 finding on mb-stack: a freshly created `EphemeralPermission`
        // account has 0 lamports (its rent is funded into the shared
        // `ephemeral_vault`, not the account itself), so `perm.lamports() > 0`
        // never detects "already exists". Ownership is the correct signal: an
        // undelegated/uninitialized PDA here is owned by the System Program
        // (or has no account at all), never by the Permission Program. When
        // it *is* owned by the Permission Program, a permission already
        // exists (week 1's public one, or a prior private one) — update its
        // members instead of re-creating, which the Magic program rejects on
        // an already-initialized account (`invalid account data for
        // instruction`).
        if perm.owner == &PERMISSION_PROGRAM_ID {
            UpdateEphemeralPermissionCpi {
                payer: acc.clone(),
                permissioned_account: acc.clone(),
                permission: perm.clone(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: acc.clone(),
                authority_is_signer: false, // PDA signs via the seeds below
                args,
            }
            .invoke_signed(&[seeds.as_slice()])?;
        } else {
            CreateEphemeralPermissionCpi {
                payer: acc.clone(),
                permissioned_account: acc.clone(),
                permission: perm.clone(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args,
            }
            .invoke_signed(&[seeds.as_slice()])?;
        }
    }
    Ok(())
}

// Week-4 Task 2 (risk #24): `MarketRisk`/`PoolLive` are delegated to the ER
// but were never made permissioned — anyone with an ER connection can read
// them. Same Create/Update CPI pattern as `InitPermissions` above, but for
// the two market-scoped private aggregates instead of the per-user
// PDAs, and with `build_admin_members` (crank OWNER_FLAGS, admin
// VIEWER_FLAGS — neither account has a single trader-owner). NOTE: this file
// is already large; kept here per the week-4 plan's placement (right after
// `InitPermissions`) rather than a new file.
#[derive(Accounts)]
pub struct InitMarketPermissions<'info> {
    // The permissioned account self-funds its permission rent (as
    // `InitPermissions`); on an already-delegated PDA with no rent surplus
    // this fails `InsufficientFundsForRent`. Caller must top it up first via
    // the eSPL delegated-lamports transfer (`lamportsDelegatedTransferIx`,
    // see `admin.ts`'s `fundMarketPermissions`); in-tx funding from the fee
    // payer/raw SystemProgram/lamport moves is rejected by the ER (week 4, Task 3).
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [RISK_SEED, market.key().as_ref()], bump = market_risk.bump, has_one = market)]
    pub market_risk: Box<Account<'info, MarketRisk>>,
    // Self-referential seed (mirrors `CommitAggregate`/`Trade`'s `pool_live`
    // field): this context carries no separate `Pool` account to read the
    // mint from.
    #[account(mut, seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump)]
    pub pool_live: Box<Account<'info, PoolLive>>,
    /// CHECK: permission PDA of `market_risk`, under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, market_risk.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub risk_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `pool_live`
    #[account(mut, seeds = [PERMISSION_SEED, pool_live.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub pool_live_permission: UncheckedAccount<'info>,
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
pub fn init_market_permissions(ctx: Context<InitMarketPermissions>) -> Result<()> {
    // LiteSVM and the L1 base layer have no permission program deployed — a
    // no-op here keeps the admin bootstrap call idempotent locally and on
    // devnet regardless of whether it has run before (same executable-gate
    // style as `commit.rs`'s `magic_program.executable` guard).
    if !ctx.accounts.permission_program.to_account_info().executable {
        return Ok(());
    }
    let members = build_admin_members(ctx.accounts.config.crank, ctx.accounts.config.admin);
    let m = ctx.accounts.market.key();
    let mint = ctx.accounts.pool_live.mint;
    let rb = [ctx.accounts.market_risk.bump];
    let lb = [ctx.accounts.pool_live.bump];
    let pairs: [(AccountInfo, AccountInfo, Vec<&[u8]>); 2] = [
        (
            ctx.accounts.market_risk.to_account_info(),
            ctx.accounts.risk_permission.to_account_info(),
            vec![RISK_SEED, m.as_ref(), &rb],
        ),
        (
            ctx.accounts.pool_live.to_account_info(),
            ctx.accounts.pool_live_permission.to_account_info(),
            vec![POOL_LIVE_SEED, mint.as_ref(), &lb],
        ),
    ];

    for (acc, perm, seeds) in pairs.iter() {
        let args = EphemeralMembersArgs {
            is_private: true,
            members: members.clone(),
        };
        // Same "owned by the permission program already?" signal as
        // `InitPermissions` above (a freshly created `EphemeralPermission`
        // has 0 lamports, so ownership — not `lamports() > 0` — is what
        // detects "already exists"). `payer: acc.clone()`, self-funded
        // (matches `InitPermissions`) — the caller must ensure both
        // accounts carry rent surplus before calling this instruction (see
        // `InitMarketPermissions`'s doc comment and `admin.ts`'s
        // `fundMarketPermissions`).
        if perm.owner == &PERMISSION_PROGRAM_ID {
            UpdateEphemeralPermissionCpi {
                payer: acc.clone(),
                permissioned_account: acc.clone(),
                permission: perm.clone(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: acc.clone(),
                authority_is_signer: false, // PDA signs via the seeds below
                args,
            }
            .invoke_signed(&[seeds.as_slice()])?;
        } else {
            CreateEphemeralPermissionCpi {
                payer: acc.clone(),
                permissioned_account: acc.clone(),
                permission: perm.clone(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args,
            }
            .invoke_signed(&[seeds.as_slice()])?;
        }
    }
    Ok(())
}

// Week-3 Task 6 (spec §2.4.3): full exit. Same permission-account shape as
// `SetSession`/`InitPermissions` (the per-user PDAs + shared vault +
// permission program) plus `Withdraw`'s magic-fee-vault accounts, since this
// is the only instruction that both closes ER permissions *and* pays a
// fee-vault commit CPI in the same call. Boxed for the same reason as every
// other multi-account context in this file: this many accounts together blow
// the SBF stack frame in `try_accounts`.
#[derive(Accounts)]
pub struct UndelegateUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, seeds = [POSITIONS_SEED, owner.key().as_ref()], bump = positions.load()?.bump,
        constraint = positions.load()?.owner == owner.key() @ DexxerError::Unauthorized)]
    pub positions: AccountLoader<'info, Positions>,
    /// CHECK: permission PDA of `user_account`, under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, user_account.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub user_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `positions`
    #[account(mut, seeds = [PERMISSION_SEED, positions.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub positions_permission: UncheckedAccount<'info>,
    /// CHECK: shared ER vault (rent for permission accounts lives here, as in SetSession)
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to Config.magic_fee_vault (as in Withdraw)
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the close-permission/commit-and-undelegate CPIs via `.executable`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Close one ER `EphemeralPermission`, mirroring `set_session`'s
/// `UpdateEphemeralPermissionCpi` loop exactly: the permissioned account signs
/// for itself via its own PDA seeds (`authority_is_signer: false`), and the
/// call is skipped when `perm` isn't owned by the permission program — LiteSVM
/// has no permission program deployed at all, and on the L1/pre-onboarding
/// path the permission may simply not exist yet (same guard `set_session`
/// uses for the identical reason).
#[inline(never)]
pub(crate) fn close_permission_if_present<'info>(
    acc: &AccountInfo<'info>,
    perm: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    if perm.owner != &PERMISSION_PROGRAM_ID {
        return Ok(());
    }
    CloseEphemeralPermissionCpi {
        payer: acc.clone(),
        authority: acc.clone(),
        permissioned_account: acc.clone(),
        permission: perm.clone(),
        vault: vault.clone(),
        magic_program: magic_program.clone(),
        permission_program: permission_program.clone(),
        authority_is_signer: false,
    }
    .invoke_signed(&[seeds])
    .map_err(Into::into)
}

/// Full exit with a live TEE (spec §2.4.3). Order matters: scrub every
/// private field first (nothing private may survive into a public commit),
/// then close both `EphemeralPermission`s (safe now — the underlying
/// accounts are already zeroed), then commit-and-undelegate so both PDAs
/// return to this program on L1. The permission close must precede the
/// commit, not merely follow the scrub: a still-permissioned (private)
/// account is refused by the TEE's own commit filter (spec risk #13), so
/// skipping this step fails the whole `undelegate_user` call outright rather
/// than ever risking a leak. Task 1 M-A measured on devnet-tee that this
/// exact order (close-permission-then-commit-and-undelegate in the same ER
/// tx) lands on L1 on the first try.
///
/// This is the ONLY instruction in the program that commits a raw
/// `UserAccount`/`Positions` to L1 (CLAUDE.md privacy rule:
/// a raw private account is never committed as-is) — and it is safe here
/// specifically because both the scrub and the permission close above have
/// already run by the time `commit_and_undelegate` is reached, so nothing
/// sensitive is left in the bytes that land publicly on L1: every slot is
/// `Empty` (a cleared slot is all-zero bytes, `market` included) and the
/// history ring is scrubbed.
///
/// `remaining_accounts` are the markets whose liquidation tasks to cancel
/// (spec §2.9.2): used ONLY for their key, from which the task id is derived
/// (`liq_task_id(positions, market)`). They are never deserialized — a key
/// that names no registered task is a measured-safe no-op cancel (week 5).
pub fn undelegate_user<'info>(ctx: Context<'info, UndelegateUser<'info>>) -> Result<()> {
    let a = ctx.accounts;
    let rem = ctx.remaining_accounts;
    require!(rem.len() <= MAX_SLOTS, DexxerError::InvalidInput);
    let o = a.owner.key();
    let positions_key = a.positions.key();
    let pb = {
        let mut p = a.positions.load_mut()?;
        require!(p.open_count() == 0, DexxerError::HasOpenPosition);
        // The owner's private close history never leaves the ER. Every slot is
        // already `Empty` (gate above) and a cleared slot is all-zero bytes;
        // the slots are zeroed again anyway, as defence in depth. `owner`,
        // `version`, `bump`, `_pad` and `_reserved` are kept: `owner` is the
        // PDA seed, the rest are structural and hold no trade data.
        p.scrub_slots();
        p.scrub_orders();
        p.scrub_history();
        [p.bump]
    }; // RefMut dropped here — before every CPI below that takes `positions`
    require!(
        a.user_account.free_margin == 0 && a.user_account.locked_margin == 0,
        DexxerError::BalanceNotZero
    );
    let ub = [a.user_account.bump];

    // Scrub — nothing private may survive into the public commit below.
    // Every `UserAccount` field is accounted for here: `version`/`owner`/
    // `bump` are kept (structural, not private data — `owner` is the PDA
    // seed); `free_margin`/`locked_margin` are provably zero already (the
    // `BalanceNotZero` guard above); `rent_payer` and `_reserved` are kept
    // deliberately — `rent_payer` is where `close_exited_user` must send the
    // rent (risk #39) and is public on L1 anyway (the payer of `init_user`),
    // `_reserved` is never written; everything else is zeroed below,
    // including `last_withdraw_slot` (a withdraw-cooldown timestamp — leaks
    // recent activity if left on the committed account).
    let u = &mut a.user_account;
    u.session_key = Pubkey::default();
    u.session_expiry = 0;
    u.actions_left = 0;
    u.last_withdraw_slot = 0;
    u.exit_salt = [0; 32];
    // Marks the account as having left the ER: it comes back to L1 scrubbed,
    // not closed, and `close_exited_user` reclaims it only once this is set.
    u.exited = true;

    // Flush the scrub to the account's raw data now, while this program is
    // still its uncontested owner. `Account<'info, T>::exit()` re-serializes
    // unconditionally (`exit_with_expected_owner` compares `T::owner()` to
    // `crate::ID`, both compile-time constants for this program — it never
    // reads the account's *live* owner field), and Anchor calls it again,
    // automatically, after this function returns. Root cause of devnet
    // `ExternalAccountDataModified` (Ruling 10): `commit_and_undelegate`
    // below flips these accounts' owner away from this program before that
    // automatic exit runs; the automatic write is a raw data-buffer write
    // gated only by the runtime's owner check, so a write that changes bytes
    // after the owner has moved trips it. Writing the scrub here — before
    // any CPI reassigns ownership — makes the later automatic write a no-op
    // (identical bytes), which the runtime does not flag regardless of the
    // account's owner at that point. `positions` is zero-copy: the slot and
    // history scrubs above were written in place, and its automatic exit only
    // rewrites the same 8-byte discriminator — already a no-op, so no explicit
    // flush (reasoned from Anchor's `AccountLoader::exit`, not measured on
    // devnet).
    a.user_account.exit(&crate::ID)?;

    close_permission_if_present(
        &a.user_account.to_account_info(),
        &a.user_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[USER_SEED, o.as_ref(), &ub],
    )?;
    close_permission_if_present(
        &a.positions.to_account_info(),
        &a.positions_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[POSITIONS_SEED, o.as_ref(), &pb],
    )?;

    // Every mutation is done — hand the accounts over as a shared,
    // `'info`-scoped reference, which is what the scheduler CPI below needs
    // (`CancelCrankCpi` ties all of its accounts to one invariant lifetime;
    // see `instructions/liquidation.rs`).
    let a: &'info UndelegateUser<'info> = a;

    // Cancel the liquidation task of every market the client names. This is
    // the ONLY place that can clean up after a LIQUIDATED position:
    // `crank_tick`/`liquidation_check` deliberately do not cancel (see
    // `trade::cancel_liq_task`), so a task whose position was liquidated keeps
    // ticking as a no-op until its owner exits — and once `Positions` leaves
    // the ER below, a live task would be pointing at an account that is no
    // longer there. Cancelling an id that was never registered (or already
    // cancelled by `close_position`) is a measured-safe no-op (week 5, M-I).
    if a.magic_program.to_account_info().executable {
        // `task_context` is the `Positions` PDA — the same convention
        // `open_position` uses when registering the task. The Magic Program
        // treats this account as an inert writable placeholder: it never
        // creates, writes or reassigns it (week-5 Task 0, measurement 6).
        let escrow: &'info Account<'info, FeeEscrow> = &a.fee_escrow;
        let positions_ai: &'info AccountInfo<'info> = a.positions.as_ref();
        for market in rem.iter() {
            cancel_liquidation_task(
                escrow.as_ref(),
                positions_ai,
                &a.magic_program,
                liq_task_id(&positions_key, &market.key()),
                a.fee_escrow.bump,
            )?;
        }
    }

    // Only in a real ER does a Magic program actually live at this address;
    // on LiteSVM it is absent, so skip the commit-and-undelegate CPI rather
    // than fail the exit (same executable-gated pattern as `withdraw`).
    if a.magic_program.to_account_info().executable {
        let bump = a.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(
            a.fee_escrow.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[
            a.user_account.to_account_info(),
            a.positions.to_account_info(),
        ])
        .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// Base layer, after the ER side has handed everything back: reclaim the rent of
// an exited user's PDAs in one instruction. After this the owner's slate is
// blank and plain `init_user` is the re-onboarding path.
//
// Anchor's typed `Account<>`/`AccountLoader<>` on both is the gate that makes this safe to
// expose: the owner check only passes once each account is back under this
// program, i.e. only once the undelegation has actually settled on L1. While
// either is still delegated it is owned by the Delegation Program and this
// instruction cannot touch it at all.
//
// The rent goes to the recorded `UserAccount.rent_payer` (risk #39), never to
// whoever signs: a sponsored onboarding refunds `Config.fee_payer`, a
// self-funded one refunds the owner. The closer is `Config.fee_payer` (the
// relayer's janitor, for an owner who has gone) or the owner themselves.
// `rent_payer` survives `undelegate_user`'s scrub — it is already public on L1
// as the payer of `init_user`.
#[derive(Accounts)]
pub struct CloseExitedUser<'info> {
    /// `Config.fee_payer` (the relayer's janitor) or the owner themselves.
    pub closer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: lamports destination, pinned to the recorded payer.
    #[account(mut, constraint = rent_payer.key() == user_account.rent_payer @ DexxerError::Unauthorized)]
    pub rent_payer: UncheckedAccount<'info>,
    // `user_account.owner` is bound first, so both addresses below derive from
    // this one account's stored owner: they cannot belong to different traders.
    #[account(mut, close = rent_payer, seeds = [USER_SEED, user_account.owner.as_ref()], bump = user_account.bump,
        constraint = closer.key() == config.fee_payer || closer.key() == user_account.owner @ DexxerError::Unauthorized,
        constraint = user_account.exited @ DexxerError::NotExited,
        constraint = user_account.free_margin == 0 && user_account.locked_margin == 0 @ DexxerError::BalanceNotZero)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, close = rent_payer, seeds = [POSITIONS_SEED, user_account.owner.as_ref()], bump = positions.load()?.bump,
        constraint = positions.load()?.open_count() == 0 @ DexxerError::HasOpenPosition)]
    pub positions: AccountLoader<'info, Positions>,
}
pub fn close_exited_user(_ctx: Context<CloseExitedUser>) -> Result<()> {
    Ok(())
}
