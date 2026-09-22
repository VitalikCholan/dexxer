use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi,
            UpdateEphemeralPermissionCpi,
        },
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
};

declare_id!("2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7");

pub const COUNTER_SEED: &[u8] = b"counter";

#[ephemeral]
#[program]
pub mod private_counter {
    use super::*;

    /// Initialize the counter on the base layer, pre-funding it with enough rent
    /// for the ephemeral permission account that will be created on the ER after
    /// delegation. The counter PDA is the delegated account — its lamports flow
    /// with it to the ER and become spendable there for explicit deposits (the
    /// tempKeypair's base lamports aren't directly transferable on the ER, but
    /// the counter PDA's are).
    ///
    /// Week-2 M2 finding: `size_of(1)` (week 0's owner-only budget, 894_080
    /// lamports on this deployment) is NOT enough once `set_privacy` grows the
    /// permission to 2 members (owner + a week-2 `crank` member) — a real
    /// `setPrivacy(true, crank)` attempt against a `size_of(1)`-funded counter
    /// failed with `InsufficientFundsForRent` (permission's resize needs the
    /// full 134-byte rent-exempt minimum, ~1_330_960 lamports on devnet, not
    /// just the marginal resize delta). Budget for 2 members from the start.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.counter.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32),
        )?;

        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        counter.authority = ctx.accounts.authority.key();

        msg!(
            "PDA {} count: {} authority: {}",
            counter.key(),
            counter.count,
            counter.authority
        );
        Ok(())
    }

    /// Increment the counter.
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count += 1;
        if counter.count > 1000 {
            counter.count = 0;
        }
        msg!("PDA {} count: {}", counter.key(), counter.count);
        Ok(())
    }

    /// Delegate the counter to the (TEE) ER. Permission setup happens separately
    /// on the ER via `init_permission` — that's the canonical ephemeral-permission
    /// flow (cheaper rent, single CPI, no base-layer permission account to manage).
    pub fn delegate(ctx: Context<DelegateCounterPrivately>) -> Result<()> {
        if ctx.accounts.counter.owner != &ephemeral_rollups_sdk::id() {
            let validator = ctx.accounts.validator.as_ref();
            ctx.accounts.delegate_counter(
                &ctx.accounts.authority,
                &[COUNTER_SEED, ctx.accounts.authority.key().as_ref()],
                DelegateConfig {
                    validator: validator.map(|v| v.key()),
                    ..Default::default()
                },
            )?;
        } else {
            msg!("Counter already delegated");
        }
        Ok(())
    }

    /// Create the ephemeral permission directly on the ER. Payer = the counter PDA
    /// (delegated), which carries its base-layer lamports onto the ER and can spend
    /// them via PDA-signed CPI. The tempKeypair's lamports are mirrored to the ER
    /// but not directly transferable in a deposit. Idempotent: skips if already exists.
    /// Starts public; flip via `set_privacy`.
    pub fn init_permission(ctx: Context<PermissionContext>) -> Result<()> {
        if ctx.accounts.permission.lamports() > 0 {
            msg!("Permission already exists, skipping creation");
            return Ok(());
        }
        let signers = [
            COUNTER_SEED,
            ctx.accounts.counter.authority.as_ref(),
            &[ctx.bumps.counter],
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.counter.to_account_info(),
            permissioned_account: ctx.accounts.counter.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: false,
                members: vec![],
            },
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    /// Toggle the privacy flag of the ephemeral permission. When private, the
    /// listed members (the counter authority plus a week-2 `crank` member, used
    /// by task-1's M2 measurement to observe crank-vs-stranger visibility) can
    /// read ER state via the TEE; external wallets are rejected when private.
    /// `crank` is week-2's addition to the week-0 spike (single-member vec) —
    /// pass `Pubkey::default()` to reproduce the original owner-only behavior.
    pub fn set_privacy(ctx: Context<PermissionContext>, is_private: bool, crank: Pubkey) -> Result<()> {
        msg!("Toggling privacy to {}", is_private);
        let signers = [
            COUNTER_SEED,
            ctx.accounts.counter.authority.as_ref(),
            &[ctx.bumps.counter],
        ];
        let members = if is_private {
            let mut m = vec![Member {
                flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                pubkey: ctx.accounts.counter.authority,
            }];
            if crank != Pubkey::default() {
                m.push(Member {
                    flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                    pubkey: crank,
                });
            }
            m
        } else {
            vec![]
        };
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.counter.to_account_info(),
            permissioned_account: ctx.accounts.counter.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.counter.to_account_info(),
            authority_is_signer: false, // PDA signs via the seeds above
            args: EphemeralMembersArgs { is_private, members },
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    /// Close the ephemeral permission account on the ER, refunding rent to the
    /// counter PDA (the payer that originally deposited it).
    pub fn close_permission(ctx: Context<PermissionContext>) -> Result<()> {
        let signers = [
            COUNTER_SEED,
            ctx.accounts.counter.authority.as_ref(),
            &[ctx.bumps.counter],
        ];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.counter.to_account_info(),
            permissioned_account: ctx.accounts.counter.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.counter.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    /// Manual commit the counter state in the ER.
    pub fn commit(ctx: Context<IncrementAndCommit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Week-2 M3 addition: same as `commit`, but passes the validator-scoped
    /// `magic_fee_vault` account to the intent builder (`.magic_fee_vault(..)`,
    /// documented in `ephemeral-rollups-sdk` 0.16.2 as "Required when the payer
    /// is delegated"). Real finding: a first attempt using `payer` (a plain
    /// funded wallet, even with a `lamportsDelegatedTransferIx`-created
    /// *derived* lamports PDA elsewhere) as the CPI payer still failed with
    /// `0xA0000000` — a plain wallet is never itself "delegated" (only a PDA
    /// relative to it can be, and a PDA can't be an outer tx signer either).
    /// `counter` *is* delegated and can PDA-sign a CPI (same pattern as
    /// `set_privacy`/`close_permission`), so it is the CPI's `payer` here;
    /// the outer transaction still needs a real wallet (`payer` account) to
    /// pay the tx fee.
    pub fn commit_with_vault(ctx: Context<CommitWithVault>) -> Result<()> {
        let signers = [
            COUNTER_SEED,
            ctx.accounts.counter.authority.as_ref(),
            &[ctx.bumps.counter],
        ];
        MagicIntentBundleBuilder::new(
            ctx.accounts.counter.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke_signed(&[&signers])?;
        Ok(())
    }

    /// Commit and undelegate the counter in one atomic ER transaction.
    pub fn undelegate(ctx: Context<UndelegateCounter>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Week-3 M-A: close the ephemeral permission (the counter becomes public
    /// again on the ER, same as `close_permission`) and, in the same atomic ER
    /// transaction, commit-and-undelegate. Owner-signed. Tests whether the TEE
    /// lets a just-unprivatized delegated account's bytes reach L1 this way —
    /// the sequence `undelegate_user` (spec §2.4.3) wants to use. If this
    /// instruction fails, `undelegate` above is the fallback variant (commit
    /// and undelegate without closing the permission first); a Solana
    /// transaction is all-or-nothing, so a failed `exit` never leaves the
    /// permission half-closed.
    pub fn exit(ctx: Context<ExitCounter>) -> Result<()> {
        let signers = [
            COUNTER_SEED,
            ctx.accounts.counter.authority.as_ref(),
            &[ctx.bumps.counter],
        ];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.counter.to_account_info(),
            permissioned_account: ctx.accounts.counter.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.counter.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&signers])?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + core::mem::size_of::<Counter>(),
        seeds = [COUNTER_SEED, authority.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Counter delegation only — permission lives on the ER and is created later by
/// `init_permission`. Simpler than the bundled flow: no base-layer permission
/// account, no separate buffer/record/metadata PDAs for permission delegation.
#[delegate]
#[derive(Accounts)]
pub struct DelegateCounterPrivately<'info> {
    pub authority: Signer<'info>,
    /// CHECK: The counter PDA to delegate
    #[account(mut, del, seeds = [COUNTER_SEED, authority.key().as_ref()], bump)]
    pub counter: UncheckedAccount<'info>,
    /// CHECK: Checked by the delegate program
    pub validator: Option<UncheckedAccount<'info>>,
}

/// Account for the increment instruction.
#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut, seeds = [COUNTER_SEED, counter.authority.as_ref()], bump)]
    pub counter: Account<'info, Counter>,
}

/// Shared context for init_permission / set_privacy / close_permission — all run
/// on the ER and operate on the ephemeral permission.
#[derive(Accounts)]
pub struct PermissionContext<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [COUNTER_SEED, counter.authority.as_ref()],
        has_one = authority,
        bump
    )]
    pub counter: Account<'info, Counter>,
    /// CHECK: verified by permission program; seeds match the on-chain layout
    #[account(
        mut,
        seeds = [PERMISSION_SEED, counter.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: verified by magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Magic Program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct IncrementAndCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED, counter.authority.as_ref()], bump)]
    pub counter: Account<'info, Counter>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitWithVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED, counter.authority.as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    /// CHECK: validator-scoped magic fee vault (`magicFeeVaultPdaFromValidator`), passed
    /// through to `MagicIntentBundleBuilder::magic_fee_vault` unchecked by this spike.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED, counter.authority.as_ref()], bump)]
    pub counter: Account<'info, Counter>,
}

/// `close_permission` + `undelegate` combined in one ER transaction. `payer`
/// is a plain wallet (mirrors `UndelegateCounter` above) — a program PDA
/// cannot be an outer-transaction signer.
#[commit]
#[derive(Accounts)]
pub struct ExitCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED, counter.authority.as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    /// CHECK: verified by permission program; seeds match the on-chain layout
    #[account(
        mut,
        seeds = [PERMISSION_SEED, counter.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: verified by magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
}

#[account]
pub struct Counter {
    pub count: u64,
    pub authority: Pubkey,
}
