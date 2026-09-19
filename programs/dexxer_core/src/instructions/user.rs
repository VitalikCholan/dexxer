use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use ephemeral_rollups_sdk::{
    access_control::structs::EphemeralPermission, ephemeral_accounts::rent,
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
    #[account(seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
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

#[derive(Accounts)]
pub struct SetSession<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_account.bump, has_one = owner @ DexxerError::Unauthorized)]
    pub user_account: Account<'info, UserAccount>,
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
