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
    // rent for `UserAccount`/`Position`/`DisclosureQueue` and the three
    // per-PDA `EphemeralPermission` prefund transfers below, instead of
    // `owner` — see `FaucetInit`'s `payer` field for the same rationale.
    #[account(mut)]
    pub payer: Signer<'info>,
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
        payer = payer,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    // Boxed: DisclosureQueue is ~1.3 KB and blows the SBF stack frame
    // (~4 KB limit) if kept inline alongside the other init'd accounts here.
    #[account(
        init,
        payer = payer,
        space = 8 + DisclosureQueue::INIT_SPACE,
        seeds = [DQ_SEED, owner.key().as_ref()],
        bump
    )]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
    pub system_program: Program<'info, System>,
}
pub fn init_user(ctx: Context<InitUser>, exit_salt: [u8; 32]) -> Result<()> {
    let o = ctx.accounts.owner.key();
    let u = &mut ctx.accounts.user_account;
    u.version = USER_ACCOUNT_VERSION;
    u.owner = o;
    u.exit_salt = exit_salt;
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
                    from: ctx.accounts.payer.to_account_info(),
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

// spec §8 Q2: delegate the three user-scoped PDAs to the TEE validator. Seeds
// already pin `owner` on `user_account`/`position`/`disclosure_queue`, so no
// extra `has_one` check is needed before delegating them.
#[delegate]
#[derive(Accounts)]
pub struct DelegateUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    // Week-5 Task 3 (P1): the rent for the three delegation records is the
    // last owner-paid cost of onboarding (~0.004 SOL), which is what keeps the
    // one-tap flow from being 0-SOL. Splitting `payer` out of `owner` lets the
    // relayer's sponsor key fund it while the owner still signs for its own
    // PDAs. `payer == owner` remains valid and is what the tests use.
    #[account(mut)]
    pub payer: Signer<'info>,
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
    // Fix round 1 (controller ruling, IMPORTANT 2): `user_account` is an
    // `UncheckedAccount` here (the `#[delegate]` macro's shape), so nothing
    // would otherwise stop an exited account from being re-delegated straight
    // back into the ER — scrubbed, `exit_salt` zeroed, `exited` still set —
    // bypassing `init_user_reuse_queue` entirely. Read it manually: before
    // delegation the account is still owned by this program, so a plain
    // `try_deserialize` is valid (and fails on its own with
    // `AccountDidNotDeserialize` for a short legacy v1 account). Scoped so the
    // data borrow is released before the delegation CPI reassigns the owner.
    // No explicit `owner == crate::ID` check is needed even though this is a
    // raw deserialize: the address is PDA-derived by the `#[delegate]` macro's
    // `seeds = [USER_SEED, owner.key()]` constraint, so no foreign-owned
    // account can occupy this slot and be read as a `UserAccount`.
    {
        let data = ctx.accounts.user_account.try_borrow_data()?;
        let u = UserAccount::try_deserialize(&mut &data[..])?;
        require!(!u.exited, DexxerError::NotExited);
    }
    let o = ctx.accounts.owner.key();
    let m = ctx.accounts.market.key();
    ctx.accounts.delegate_user_account(
        &ctx.accounts.payer,
        &[USER_SEED, o.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    ctx.accounts.delegate_position(
        &ctx.accounts.payer,
        &[POSITION_SEED, o.as_ref(), m.as_ref()],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    ctx.accounts.delegate_disclosure_queue(
        &ctx.accounts.payer,
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

// Week-4 Task 2 (risk #24): `MarketRisk`/`PoolLive` are delegated to the ER
// but were never made permissioned — anyone with an ER connection can read
// them. Same Create/Update CPI pattern as `InitPermissions` above, but for
// the two market-scoped private aggregates instead of the three per-user
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
// `SetSession`/`InitPermissions` (the three per-user PDAs + shared vault +
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
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref(), position.market.as_ref()], bump = position.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [DQ_SEED, owner.key().as_ref()], bump = dq.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub dq: Box<Account<'info, DisclosureQueue>>,
    /// CHECK: permission PDA of `user_account`, under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, user_account.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub user_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `position`
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `dq`
    #[account(mut, seeds = [PERMISSION_SEED, dq.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub dq_permission: UncheckedAccount<'info>,
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
fn close_permission_if_present<'info>(
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
/// then close the three `EphemeralPermission`s (safe now — the underlying
/// accounts are already zeroed), then commit-and-undelegate so the three PDAs
/// return to this program on L1. The permission close must precede the
/// commit, not merely follow the scrub: a still-permissioned (private)
/// account is refused by the TEE's own commit filter (spec risk #13), so
/// skipping this step fails the whole `undelegate_user` call outright rather
/// than ever risking a leak. Task 1 M-A measured on devnet-tee that this
/// exact order (close-permission-then-commit-and-undelegate in the same ER
/// tx) lands on L1 on the first try.
///
/// This is the ONLY instruction in the program that commits a raw
/// `UserAccount`/`Position`/`DisclosureQueue` to L1 (CLAUDE.md privacy rule:
/// a raw private account is never committed as-is) — and it is safe here
/// specifically because both the scrub and the permission close above have
/// already run by the time `commit_and_undelegate` is reached, so nothing
/// sensitive is left in the bytes that land publicly on L1.
pub fn undelegate_user<'info>(ctx: Context<'info, UndelegateUser<'info>>) -> Result<()> {
    let a = ctx.accounts;
    require!(
        a.position.state == PositionState::Empty,
        DexxerError::HasOpenPosition
    );
    require!(
        a.user_account.free_margin == 0 && a.user_account.locked_margin == 0,
        DexxerError::BalanceNotZero
    );
    // Week-5 Task 2 (spec §2.6.3): a queue that still owes L1 commitments and
    // disclosures no longer blocks the exit (`QueueNotEmpty`, now retired).
    // Waiting for the reveal cycle means minutes on the demo delay but 30 days
    // in production — an unacceptable lock-in for a user who has already
    // closed out and withdrawn everything. So the user leaves and the debt
    // stays: the queue keeps its records, stays delegated, and narrows to a
    // crank-only permission below.
    let carries_debt = a.dq.len > 0;

    let o = a.owner.key();
    let m = a.position.market;
    let ub = [a.user_account.bump];
    let pb = [a.position.bump];
    let db = [a.dq.bump];

    // Scrub — nothing private may survive into the public commit below.
    // Every `UserAccount` field is accounted for here: `version`/`owner`/
    // `bump` are kept (structural, not private data — `owner` is the PDA
    // seed); `free_margin`/`locked_margin` are provably zero already (the
    // `BalanceNotZero` guard above); everything else is zeroed below,
    // including `last_withdraw_slot` (a withdraw-cooldown timestamp — leaks
    // recent activity if left on the committed account).
    let u = &mut a.user_account;
    u.session_key = Pubkey::default();
    u.session_expiry = 0;
    u.actions_left = 0;
    u.nonce = 0;
    u.last_withdraw_slot = 0;
    u.exit_salt = [0; 32];
    // Set on BOTH branches — the account has left the ER either way. This flag
    // is what later lets `init_user_reuse_queue` re-initialize the account in
    // place: undelegation hands the PDAs back scrubbed, it does not close
    // them, so a plain `init_user` can never re-onboard the same owner.
    u.exited = true;
    // The queue is scrubbed only when it goes with them. On the debt branch it
    // stays live in the ER and its records are the only copy of trades already
    // promised to L1 — wiping them would default on that promise.
    if !carries_debt {
        a.dq.head = 0;
        a.dq.len = 0;
        a.dq.records = [ClosedRecord::default(); DQ_CAPACITY];
    }

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
    // account's owner at that point. `position` is untouched by this
    // function, so its automatic exit is already a no-op either way; flushed
    // here too only for uniformity with `user_account`/`dq` and to stay safe
    // if a future change starts mutating it.
    a.user_account.exit(&crate::ID)?;
    a.position.exit(&crate::ID)?;
    if !carries_debt {
        a.dq.exit(&crate::ID)?;
    }

    close_permission_if_present(
        &a.user_account.to_account_info(),
        &a.user_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[USER_SEED, o.as_ref(), &ub],
    )?;
    close_permission_if_present(
        &a.position.to_account_info(),
        &a.position_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[POSITION_SEED, o.as_ref(), m.as_ref(), &pb],
    )?;
    if carries_debt {
        // The queue stays behind, alone: its owner is gone and its session key
        // is dead, so membership narrows to the crank — the only party that
        // still touches it (`commit_aggregate`'s reveals, then
        // `close_orphan_queue`). Same self-signing shape as `set_session`'s
        // update loop, and skipped for the same reason when no permission
        // account exists (LiteSVM, or an ER account never made private).
        let dq_ai = a.dq.to_account_info();
        let dq_perm = a.dq_permission.to_account_info();
        if dq_perm.owner == &PERMISSION_PROGRAM_ID {
            UpdateEphemeralPermissionCpi {
                payer: dq_ai.clone(),
                permissioned_account: dq_ai.clone(),
                permission: dq_perm.clone(),
                vault: a.ephemeral_vault.to_account_info(),
                magic_program: a.magic_program.to_account_info(),
                permission_program: a.permission_program.to_account_info(),
                authority: dq_ai.clone(),
                authority_is_signer: false, // PDA signs via the seeds below
                args: EphemeralMembersArgs {
                    is_private: true,
                    members: build_crank_only(a.config.crank),
                },
            }
            .invoke_signed(&[&[DQ_SEED, o.as_ref(), &db]])?;
        }
    } else {
        close_permission_if_present(
            &a.dq.to_account_info(),
            &a.dq_permission.to_account_info(),
            &a.ephemeral_vault.to_account_info(),
            &a.magic_program.to_account_info(),
            &a.permission_program.to_account_info(),
            &[DQ_SEED, o.as_ref(), &db],
        )?;
    }

    // Every mutation is done — hand the accounts over as a shared,
    // `'info`-scoped reference, which is what the scheduler CPI below needs
    // (`CancelCrankCpi` ties all of its accounts to one invariant lifetime;
    // see `instructions/liquidation.rs`).
    let a: &'info UndelegateUser<'info> = a;

    // Cancel the position's liquidation task. This is the ONLY place that can
    // clean up after a LIQUIDATED position: `crank_tick`/`liquidation_check`
    // deliberately do not cancel (see `trade::cancel_liq_task`), so a task
    // whose position was liquidated keeps ticking as a no-op until its owner
    // exits — and once the `Position` leaves the ER below, a live task would
    // be pointing at an account that is no longer there.
    //
    // KNOWN RISK, to be measured on devnet in Task 4 (M-I): on the ordinary
    // path (`close_position` already cancelled, or the owner never opened a
    // position at all) this cancels a `task_id` that does not exist. A failing
    // CPI cannot be caught from inside a program, so IF the validator errors
    // on an unknown task id, this aborts every exit and must be removed or
    // made conditional. Nothing in `ephemeral-rollups-sdk` 0.16.2 documents
    // the behaviour (it only forwards `MagicBlockInstruction::CancelTask`),
    // and week-5 Task 0's spike only ever cancelled live tasks.
    if a.magic_program.to_account_info().executable {
        // `task_context` is the position's own PDA — the same convention the
        // client uses when registering the task in `open_position`. The Magic
        // Program treats this account as an inert writable placeholder: it
        // never creates, writes or reassigns it, and any already-existing
        // writable account is accepted (week-5 Task 0, measurement 6). Reusing
        // `position` (already writable and delegated here) therefore costs
        // this context no extra account — and adding one measurably did not
        // fit: it put `UndelegateUser::try_accounts` 8 bytes over the SBF
        // frame, which boxing `fee_escrow` did not recover.
        let escrow: &'info Account<'info, FeeEscrow> = &a.fee_escrow;
        let position: &'info Account<'info, Position> = &a.position;
        cancel_liquidation_task(
            escrow.as_ref(),
            position.as_ref(),
            &a.magic_program,
            liq_task_id(&position.key()),
            a.fee_escrow.bump,
        )?;
    }

    // Only in a real ER does a Magic program actually live at this address;
    // on LiteSVM it is absent, so skip the commit-and-undelegate CPI rather
    // than fail the exit (same executable-gated pattern as `withdraw`).
    if a.magic_program.to_account_info().executable {
        let bump = a.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        // Two accounts on the debt branch, three otherwise — the queue only
        // rides along when it has nothing left to owe.
        let mut leaving = vec![
            a.user_account.to_account_info(),
            a.position.to_account_info(),
        ];
        if !carries_debt {
            leaving.push(a.dq.to_account_info());
        }
        MagicIntentBundleBuilder::new(
            a.fee_escrow.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&leaving)
        .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// Week-5 Task 2 (spec §2.6.3): the other half of the exit-with-debt path.
// `undelegate_user` can leave a `DisclosureQueue` behind in the ER, delegated
// and crank-only, still owing L1 the commitments and disclosures of trades
// that were closed before the exit. `commit_aggregate` drains those records
// on its normal 5-minute cycle; once the last one is gone the queue is pure
// dead weight in the rollup, and this is what reclaims it.
#[derive(Accounts)]
pub struct CloseOrphanQueue<'info> {
    // Authorization is asserted in the body, not here: a constraint on this
    // field could not reference `config`, which Anchor has not bound yet at
    // this point in the account list, and the brief's account order puts the
    // signer first.
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    // Seeded from the queue's OWN `owner` field, not from a signer: the owner
    // is gone by definition here, so there is no owner signature to derive
    // from — the account's stored owner is what pins its address.
    #[account(mut, seeds = [DQ_SEED, dq.owner.as_ref()], bump = dq.bump)]
    pub dq: Box<Account<'info, DisclosureQueue>>,
    /// CHECK: deliberately unchecked and read-only — the handler reads it, if
    /// it is there at all, to decide whether its owner has exited (week-5 Task
    /// 5: either absent/foreign-owned, or present with `exited == true`). It
    /// cannot be a typed `Account<UserAccount>`: the absent case must still
    /// pass the account list. The seeds constraint is all that binds the
    /// address handed in here to `dq.owner`.
    #[account(seeds = [USER_SEED, dq.owner.as_ref()], bump)]
    pub user_account: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `dq`, under the permission program
    #[account(mut, seeds = [PERMISSION_SEED, dq.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub dq_permission: UncheckedAccount<'info>,
    /// CHECK: shared ER vault (rent for permission accounts lives here)
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to Config.magic_fee_vault (as in UndelegateUser)
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the close-permission/commit-and-undelegate CPIs via `.executable`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn close_orphan_queue(ctx: Context<CloseOrphanQueue>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.crank.key() == a.config.crank, DexxerError::Unauthorized);
    // Nothing may be closed while L1 is still owed a reveal — the records are
    // the only copy of trades already promised publicly.
    require!(a.dq.len == 0, DexxerError::QueueStillPending);
    // The orphan signal. Week-5 Task 5 (measured on devnet-tee, Task 4): the
    // first version read ABSENCE — "the `UserAccount` is gone from the ER
    // clone" — and that never happens. After a partial `undelegate_user` the
    // TEE goes on serving the BASE clone of the account: present, owned by
    // this program, `exited == true`. So the signal is either half — the
    // account is genuinely absent/foreign-owned, OR it is here and flagged as
    // exited. A present, live (`exited == false`) account means its owner
    // never left and the queue is not an orphan.
    // A legacy (pre-`exited`) account short enough to fail deserialization
    // errors out here, which is the conservative answer: it does not close.
    let ua = a.user_account.to_account_info();
    if !ua.data_is_empty() && ua.owner == &crate::ID {
        let u = UserAccount::try_deserialize(&mut &ua.data.borrow()[..])?;
        require!(u.exited, DexxerError::NotExited);
    }

    let o = a.dq.owner;
    let db = [a.dq.bump];

    // Same order as `undelegate_user`: scrub, flush the scrub while this
    // program still owns the bytes (ruling 10 — `commit_and_undelegate` below
    // moves the owner before Anchor's automatic post-handler `exit()` would
    // otherwise run), close the permission (a still-private account is refused
    // by the TEE's commit filter, spec risk #13), then commit and undelegate.
    // `len` is already 0; `head`/`records` may still carry revealed leftovers.
    a.dq.head = 0;
    a.dq.len = 0;
    a.dq.records = [ClosedRecord::default(); DQ_CAPACITY];
    a.dq.exit(&crate::ID)?;

    close_permission_if_present(
        &a.dq.to_account_info(),
        &a.dq_permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &[DQ_SEED, o.as_ref(), &db],
    )?;

    // Absent on LiteSVM — skip rather than fail (as `withdraw`/`undelegate_user`).
    if a.magic_program.to_account_info().executable {
        let bump = a.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        MagicIntentBundleBuilder::new(
            a.fee_escrow.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[a.dq.to_account_info()])
        .build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// Base layer, after the ER side has handed everything back: reclaim the rent of
// an exited user's three PDAs in one instruction.
//
// Fix round 1 (controller ruling, CRITICAL 1). The first version of this closed
// ONLY the queue, which could strand an owner in a half-closed state no
// instruction could repair: `init_user` fails on the surviving
// `UserAccount`/`Position`, and `init_user_reuse_queue` fails on the missing
// queue. All three go together, so after this the owner's slate is genuinely
// blank and plain `init_user` is the re-onboarding path again.
// (`init_user_reuse_queue` remains the path for the owner who comes back before
// the crank has reclaimed anything.)
//
// Anchor's typed `Account<>` on all three is the gate that makes this safe to
// expose: the owner check only passes once each account is back under this
// program, i.e. only once the undelegation has actually settled on L1. While
// any of them is still delegated it is owned by the Delegation Program and this
// instruction cannot touch it at all.
//
// `fee_payer`, not the departed owner: the owner has exited and may never sign
// again, and it is the protocol that fronted this rent in the first place
// (`init_user`'s sponsored `payer`).
//
// POLICY (spec §4.2, risk #39): this is unconditional, and it is correct only
// for accounts whose rent the sponsor actually paid (week 4 onwards). An
// account created before sponsored rent existed was paid for by its OWNER, and
// this hands that rent to the protocol. Accepted for devnet; the fix (store the
// rent payer on `UserAccount` while the layout is versioned anyway, and refund
// it) is week-6 work.
#[derive(Accounts)]
pub struct CloseExitedUser<'info> {
    #[account(mut, constraint = fee_payer.key() == config.fee_payer @ DexxerError::Unauthorized)]
    pub fee_payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    // The owner is gone, so there is no owner signature to seed from — and the
    // ruling's account order puts `dq` last, which Anchor cannot reference from
    // an earlier field. `user_account.owner` is the same value and is bound
    // first, so all three addresses below derive from this one account's stored
    // owner: they cannot belong to different traders.
    #[account(mut, close = fee_payer, seeds = [USER_SEED, user_account.owner.as_ref()], bump = user_account.bump,
        constraint = user_account.exited @ DexxerError::NotExited,
        constraint = user_account.free_margin == 0 && user_account.locked_margin == 0 @ DexxerError::BalanceNotZero)]
    pub user_account: Box<Account<'info, UserAccount>>,
    #[account(mut, close = fee_payer, seeds = [POSITION_SEED, user_account.owner.as_ref(), position.market.as_ref()], bump = position.bump,
        constraint = position.state == PositionState::Empty @ DexxerError::HasOpenPosition)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, close = fee_payer, seeds = [DQ_SEED, user_account.owner.as_ref()], bump = dq.bump)]
    pub dq: Box<Account<'info, DisclosureQueue>>,
}
pub fn close_exited_user(ctx: Context<CloseExitedUser>) -> Result<()> {
    // Every queue that reaches L1 arrives scrubbed (`undelegate_user` and
    // `close_orphan_queue` both empty it before committing), so this can only
    // fire on operator error — and the cost of getting it wrong is destroying
    // the only copy of a trade already promised to L1.
    require!(ctx.accounts.dq.len == 0, DexxerError::QueueStillPending);
    Ok(())
}

// Re-onboarding after an exit. `init_user` cannot do this job: undelegation
// hands the three PDAs back scrubbed but NOT closed, so its `init`s hit
// accounts that already exist. This is the same instruction with every `init`
// replaced by a `mut` re-initialization, gated on `UserAccount.exited` — which
// is exactly what that flag exists for.
//
// (The week-5 plan sketched `user_account`/`position` as `init` and only the
// queue as pre-existing; controller ruling during implementation: all three
// survive the undelegation, so all three are reused.)
#[derive(Accounts)]
pub struct InitUserReuseQueue<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// Sponsorable, as in `InitUser`: the two ER permission prefunds below are
    /// paid by whoever calls, typically the relayer's `fee_payer`.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: address-derived via seeds; only `.key()` is read (as in `InitUser`)
    #[account(seeds = [MARKET_SEED, &SOL_SYMBOL], bump)]
    pub market: UncheckedAccount<'info>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump,
        has_one = owner @ DexxerError::Unauthorized,
        constraint = user_account.exited @ DexxerError::NotExited)]
    pub user_account: Account<'info, UserAccount>,
    // Boxed for the same stack reason as `InitUser`'s.
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()], bump = position.bump,
        has_one = owner @ DexxerError::Unauthorized,
        constraint = position.state == PositionState::Empty @ DexxerError::HasOpenPosition)]
    pub position: Box<Account<'info, Position>>,
    // Typed `Account<>`, which also sequences re-onboarding for free: while the
    // orphaned queue is still delegated it is owned by the Delegation Program
    // on L1, so this deserialize fails (`AccountOwnedByWrongProgram`) and the
    // owner cannot come back until `close_orphan_queue`'s undelegation has
    // landed. That is the right order anyway — `delegate_user` would otherwise
    // try to re-delegate an already-delegated queue.
    #[account(mut, seeds = [DQ_SEED, owner.key().as_ref()], bump = disclosure_queue.bump,
        constraint = disclosure_queue.owner == owner.key() @ DexxerError::Unauthorized)]
    pub disclosure_queue: Box<Account<'info, DisclosureQueue>>,
    pub system_program: Program<'info, System>,
}
pub fn init_user_reuse_queue(ctx: Context<InitUserReuseQueue>, exit_salt: [u8; 32]) -> Result<()> {
    let u = &mut ctx.accounts.user_account;
    // Balances are provably zero (the exit required it) — asserted rather than
    // assigned: zeroing a non-zero balance here would silently break the pool
    // invariant instead of failing loudly.
    require!(
        u.free_margin == 0 && u.locked_margin == 0,
        DexxerError::BalanceNotZero
    );
    u.version = USER_ACCOUNT_VERSION;
    u.exited = false;
    u.exit_salt = exit_salt;
    // `nonce` is deliberately NOT touched HERE — but note it does NOT survive an
    // exit: `undelegate_user`'s scrub sets `nonce = 0`, so a reused account
    // restarts its numbering from 0 (week-5 final review M1 corrected the
    // earlier "must only ever move forward" claim, which was false). That is
    // safe because a record's salt is `keccak(owner, nonce, slot)` and the
    // SLOT always moves forward: a repeated `(owner, nonce)` pair after an exit
    // lands on a different slot, so the commitment hashes cannot collide with
    // the pre-exit ones.
    // `session_key`/`session_expiry`/`actions_left`/`last_withdraw_slot` were
    // already zeroed by the exit's scrub; re-issuing a session key is
    // `set_session`'s job, exactly as after a fresh `init_user`.

    // `position` is untouched beyond its `Empty` constraint (the close that
    // preceded the exit already blanked every field — see `finalize_close`),
    // and the queue keeps whatever debt it still carries.

    // Same permission-rent prefund as `init_user`, for the two accounts that
    // re-enter the ER. The queue is either still delegated (debt branch) or
    // already prefunded from its own first onboarding, so it is not topped up
    // again here.
    let extra = rent(EphemeralPermission::size_of(PERMISSION_MEMBERS) as u32);
    for to in [
        ctx.accounts.user_account.to_account_info(),
        ctx.accounts.position.to_account_info(),
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
