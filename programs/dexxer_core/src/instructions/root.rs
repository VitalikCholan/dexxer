use crate::{errors::DexxerError, state::*};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

#[derive(Accounts)]
pub struct InitBalancesRoot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    // `zero_copy` (controller ruling 5): AccountLoader, not Account — see
    // state/balances_root.rs's doc comment. `BalancesRoot::SIZE` already
    // includes the 8-byte discriminator.
    #[account(init, payer = admin, space = BalancesRoot::SIZE, seeds = [BALANCES_ROOT_SEED], bump)]
    pub balances_root: AccountLoader<'info, BalancesRoot>,
    pub system_program: Program<'info, System>,
}
pub fn init_balances_root(ctx: Context<InitBalancesRoot>) -> Result<()> {
    let mut r = ctx.accounts.balances_root.load_init()?;
    r.version = 1;
    r.bump = ctx.bumps.balances_root;
    Ok(())
}

// Same shape as `DelegateFeeEscrow` (instructions/admin.rs) — mirrors its
// account list verbatim, replacing `fee_escrow` by `balances_root` with
// seeds `[BALANCES_ROOT_SEED]`. `#[delegate]`'s `del` account is an
// `UncheckedAccount` regardless of the target's own zero-copy-ness — it
// operates on raw bytes/ownership, not a typed view.
#[delegate]
#[derive(Accounts)]
pub struct DelegateBalancesRoot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [BALANCES_ROOT_SEED], bump)]
    pub balances_root: UncheckedAccount<'info>,
}
pub fn delegate_balances_root(ctx: Context<DelegateBalancesRoot>) -> Result<()> {
    ctx.accounts.delegate_balances_root(
        &ctx.accounts.admin,
        &[BALANCES_ROOT_SEED],
        DelegateConfig {
            validator: Some(ctx.accounts.config.tee_validator),
            ..Default::default()
        },
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct SetBalancesRoot<'info> {
    pub crank: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = crank.key() == config.crank @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [BALANCES_ROOT_SEED], bump = balances_root.load()?.bump)]
    pub balances_root: AccountLoader<'info, BalancesRoot>,
}

/// Leaves are computed HERE from the real `UserAccount` bytes — the crank chooses
/// which accounts to include (it can omit a user: spec risk #19) but cannot forge
/// a balance. `padding_seed` is never stored, so padding is indistinguishable.
pub fn set_balances_root<'info>(
    ctx: Context<'info, SetBalancesRoot<'info>>,
    begin: bool,
    finalize: bool,
    padding_seed: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let mut root = ctx.accounts.balances_root.load_mut()?;
    if begin {
        root.root_slot = clock.slot;
        root.filled = 0;
    }
    require!(
        ctx.remaining_accounts.len() <= ROOT_BATCH,
        DexxerError::InvalidLeafAccount
    );
    for ai in ctx.remaining_accounts.iter() {
        require!(ai.owner == &crate::ID, DexxerError::InvalidLeafAccount);
        let ua = UserAccount::try_deserialize(&mut &ai.try_borrow_data()?[..])
            .map_err(|_| DexxerError::InvalidLeafAccount)?;
        let (exp, _) = Pubkey::find_program_address(&[USER_SEED, ua.owner.as_ref()], &crate::ID);
        require!(ai.key() == exp, DexxerError::InvalidLeafAccount);
        let i = root.filled as usize;
        require!(i < ROOT_LEAVES, DexxerError::RootFull);
        root.leaves[i] = leaf(&ua.owner, ua.free_margin, &ua.exit_salt, root.root_slot);
        root.filled = root
            .filled
            .checked_add(1)
            .ok_or(DexxerError::MathOverflow)?;
    }
    if finalize {
        for i in (root.filled as usize)..ROOT_LEAVES {
            root.leaves[i] = pad(
                &padding_seed,
                u8::try_from(i).map_err(|_| DexxerError::MathOverflow)?,
            );
        }
    }
    Ok(())
}
