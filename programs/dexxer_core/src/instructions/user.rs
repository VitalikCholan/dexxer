use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
        structs::{EphemeralMembersArgs, EphemeralPermission, PERMISSION_SEED},
    },
    anchor::delegate,
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephemeral_accounts::rent,
};

use crate::{errors::DexxerError, state::*, token::transfer_signed_by_owner};

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
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = dusdc_mint)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
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
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    // `UncheckedAccount`, not `Account<'info, Market>` (task-13 finding on
    // mb-stack): once `delegate_market` has run, `market` is owned by the
    // Delegation Program on L1, so any `Account<'info, Market>` deserialize
    // of it here fails with `AccountOwnedByWrongProgram` — but users must
    // still be able to `init_user` after the market has been delegated
    // (delegation happens once at admin bootstrap; onboarding happens
    // continuously afterward). Only `.key()` is used below, so the seeds
    // constraint uses the fixed `SOL_SYMBOL` (matching `DelegateUser`'s
    // already-correct `market` field) instead of reading `.symbol`/`.bump`
    // off the account.
    /// CHECK: address-derived via seeds; only `.key()` is read
    #[account(seeds = [MARKET_SEED, &SOL_SYMBOL], bump)]
    pub market: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    // Boxed: DisclosureQueue is ~1.3 KB and blows the SBF stack frame
    // (~4 KB limit) if kept inline alongside the other init'd accounts here.
    #[account(
        init,
        payer = owner,
        space = 8 + DisclosureQueue::INIT_SPACE,
        seeds = [DQ_SEED, owner.key().as_ref()],
        bump
    )]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
    pub system_program: Program<'info, System>,
}
pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
    let o = ctx.accounts.owner.key();
    let u = &mut ctx.accounts.user_account;
    u.version = 1;
    u.owner = o;
    u.bump = ctx.bumps.user_account;
    let p = &mut ctx.accounts.position;
    p.version = 1;
    p.owner = o;
    p.market = ctx.accounts.market.key();
    p.state = PositionState::Empty;
    p.side = Side::Long;
    p.bump = ctx.bumps.position;
    let d = &mut ctx.accounts.disclosure_queue;
    d.version = 1;
    d.owner = o;
    d.bump = ctx.bumps.disclosure_queue;
    // spec §8 Q2: each PDA pays for its own EphemeralPermission inside the ER
    // (spike 01 pattern) — prefund that rent on L1 at creation time.
    let extra = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
    for to in [
        ctx.accounts.user_account.to_account_info(),
        ctx.accounts.position.to_account_info(),
        ctx.accounts.disclosure_queue.to_account_info(),
    ] {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to,
                },
            ),
            extra,
        )?;
    }
    Ok(())
}

// spec §8 Q2: rebuild the three per-user `EphemeralPermission` member lists
// whenever the session key changes, so the new session key can read ER state
// and the old one loses access. Same account set as `InitPermissions` (see
// there for the market/permission-PDA shape) plus `config` for `config.crank`.
#[derive(Accounts)]
pub struct SetSession<'info> {
    pub owner: Signer<'info>,
    // Boxed (same reason as `InitPermissions` below): this many accounts
    // alongside each other blows the SBF stack frame in `try_accounts`.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()], bump = position.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [DQ_SEED, owner.key().as_ref()], bump = disclosure_queue.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
    /// CHECK: permission PDAs under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, user_account.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub user_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, seeds = [PERMISSION_SEED, disclosure_queue.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub dq_permission: UncheckedAccount<'info>,
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
pub fn set_session(
    ctx: Context<SetSession>,
    session_key: Pubkey,
    expiry: i64,
    actions: u32,
) -> Result<()> {
    let u = &mut ctx.accounts.user_account;
    u.session_key = session_key;
    u.session_expiry = expiry;
    u.actions_left = actions;

    let o = ctx.accounts.owner.key();
    let m = ctx.accounts.market.key();
    let members = build_members(o, session_key, ctx.accounts.config.crank);
    let ub = [ctx.accounts.user_account.bump];
    let pb = [ctx.accounts.position.bump];
    let db = [ctx.accounts.disclosure_queue.bump];
    let triples: [(AccountInfo, AccountInfo, Vec<&[u8]>); 3] = [
        (
            ctx.accounts.user_account.to_account_info(),
            ctx.accounts.user_permission.to_account_info(),
            vec![USER_SEED, o.as_ref(), &ub],
        ),
        (
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_permission.to_account_info(),
            vec![POSITION_SEED, o.as_ref(), m.as_ref(), &pb],
        ),
        (
            ctx.accounts.disclosure_queue.to_account_info(),
            ctx.accounts.dq_permission.to_account_info(),
            vec![DQ_SEED, o.as_ref(), &db],
        ),
    ];
    for (acc, perm, seeds) in triples.iter() {
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
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump, has_one = vault_ata)]
    pub pool: Account<'info, Pool>,
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
    let p = &mut ctx.accounts.pool;
    p.capital_total = p
        .capital_total
        .checked_add(amount)
        .ok_or(DexxerError::MathOverflow)?;
    Ok(())
}

// spec §8 Q2: delegate the three user-scoped PDAs to the TEE validator. Seeds
// already pin `owner` on `user_account`/`position`/`disclosure_queue`, so no
// extra `has_one` check is needed before delegating them.
#[delegate]
#[derive(Accounts)]
pub struct DelegateUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: market key for the position seed
    #[account(seeds = [MARKET_SEED, &SOL_SYMBOL], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: delegated
    #[account(mut, del, seeds = [DQ_SEED, owner.key().as_ref()], bump)]
    pub disclosure_queue: UncheckedAccount<'info>,
}
pub fn delegate_user(ctx: Context<DelegateUser>) -> Result<()> {
    let o = ctx.accounts.owner.key();
    let m = ctx.accounts.market.key();
    ctx.accounts.delegate_user_account(
        &ctx.accounts.owner,
        &[USER_SEED, o.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    ctx.accounts.delegate_position(
        &ctx.accounts.owner,
        &[POSITION_SEED, o.as_ref(), m.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    ctx.accounts.delegate_disclosure_queue(
        &ctx.accounts.owner,
        &[DQ_SEED, o.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

// spec §8 Q2: create — or, if already public from week 1, flip — the ER-side
// `EphemeralPermission` account for each of the three delegated PDAs. Private
// with `[owner, session, crank]` members (session omitted until issued).
#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    // Boxed (task-2 finding: with `config` added and every permission/vault/
    // magic account alongside them, `config`/`market`/`user_account` blow the
    // SBF stack frame in `try_accounts` even before `position`/
    // `disclosure_queue` are counted).
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Box<Account<'info, UserAccount>>,
    // Boxed: with the market/user_account/permission accounts alongside them,
    // Position + DisclosureQueue blow the SBF stack frame in `try_accounts`
    // (same reason as `InitUser` above).
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()], bump = position.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [DQ_SEED, owner.key().as_ref()], bump = disclosure_queue.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
    /// CHECK: permission PDAs under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, user_account.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub user_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, seeds = [PERMISSION_SEED, disclosure_queue.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub dq_permission: UncheckedAccount<'info>,
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
    let m = ctx.accounts.market.key();
    let members = build_members(
        o,
        ctx.accounts.user_account.session_key,
        ctx.accounts.config.crank,
    );
    let ub = [ctx.accounts.user_account.bump];
    let pb = [ctx.accounts.position.bump];
    let db = [ctx.accounts.disclosure_queue.bump];
    let triples: [(AccountInfo, AccountInfo, Vec<&[u8]>); 3] = [
        (
            ctx.accounts.user_account.to_account_info(),
            ctx.accounts.user_permission.to_account_info(),
            vec![USER_SEED, o.as_ref(), &ub],
        ),
        (
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_permission.to_account_info(),
            vec![POSITION_SEED, o.as_ref(), m.as_ref(), &pb],
        ),
        (
            ctx.accounts.disclosure_queue.to_account_info(),
            ctx.accounts.dq_permission.to_account_info(),
            vec![DQ_SEED, o.as_ref(), &db],
        ),
    ];
    for (acc, perm, seeds) in triples.iter() {
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
