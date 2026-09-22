use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};

declare_id!("AsXtStXjZxwUd6UNVqJ9kQYJ9cYFdZbh2SeSWaZdX8bi");

pub const COUNTER_SEED: &[u8] = b"counter";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScheduleIncrementArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[ephemeral]
#[program]
pub mod anchor_counter {
    use super::*;

    /// Initialize the counter.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        msg!("PDA {} count: {}", counter.key(), counter.count);
        Ok(())
    }

    // This example intentionally keeps `increment` permissionless. A privileged scheduled
    // instruction must authenticate the preceding Hydra `Trigger` through the instructions
    // sysvar. Scheduled instructions run top-level and do not inherit a Hydra PDA signature.
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

    // Schedules crank for increment counter
    pub fn schedule_increment<'info>(
        ctx: Context<'info, ScheduleIncrement<'info>>,
        args: ScheduleIncrementArgs,
    ) -> Result<()> {
        let increment_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.counter.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Increment {}),
        };

        ScheduleCrankCpi {
            payer: &ctx.accounts.payer,
            magic_program: &&ctx.accounts.magic_program,
            instruction_accounts: &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.counter.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![increment_ix],
            },
        }
        .invoke()?;

        Ok(())
    }

    /// Delegate the account to the delegation program
    /// Set specific validator based on ER, see https://docs.magicblock.gg/pages/get-started/how-integrate-your-program/local-setup
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[COUNTER_SEED],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Undelegate the account from the delegation program
    pub fn undelegate(ctx: Context<UndelegateInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Week-3 M-D(4): schedules `tick_and_reschedule` (instead of the plain,
    /// signer-free `increment`) as the crank task.
    pub fn schedule_tick_and_reschedule<'info>(
        ctx: Context<'info, ScheduleTickAndReschedule<'info>>,
        args: ScheduleIncrementArgs,
    ) -> Result<()> {
        let tick_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.magic_program.key(), false),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.counter.key(), false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::TickAndReschedule { args: args.clone() }),
        };

        ScheduleCrankCpi {
            payer: &ctx.accounts.payer,
            magic_program: &&ctx.accounts.magic_program,
            instruction_accounts: &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.counter.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![tick_ix],
            },
        }
        .invoke()?;

        Ok(())
    }

    /// Week-3 M-D(4): the scheduled task itself. Increments the counter (so a
    /// tick landing at all is independently observable via `counter.count`),
    /// then attempts to CPI `ScheduleCrankCpi` again — a self-reschedule — with
    /// `payer` as the CPI's `payer`. `payer` is declared `Signer<'info>`, so
    /// Anchor requires a live signature for it; whether the crank executor's
    /// top-level scheduled invocation actually carries one (as opposed to only
    /// the original, directly-signed `schedule_tick_and_reschedule` call) is
    /// exactly what this measures — the vendored `increment` instruction is
    /// deliberately signer-free for the same reason (see its doc comment: a
    /// privileged scheduled instruction must authenticate some other way,
    /// because "scheduled instructions run top-level and do not inherit a
    /// Hydra PDA signature").
    pub fn tick_and_reschedule<'info>(
        ctx: Context<'info, TickAndReschedule<'info>>,
        args: ScheduleIncrementArgs,
    ) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count += 1;

        let increment_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.counter.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Increment {}),
        };

        ScheduleCrankCpi {
            payer: &ctx.accounts.payer,
            magic_program: &&ctx.accounts.magic_program,
            instruction_accounts: &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.counter.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id: args.task_id.wrapping_add(1),
                execution_interval_millis: args.execution_interval_millis,
                iterations: 1,
                instructions: vec![increment_ix],
            },
        }
        .invoke()?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init_if_needed, payer = user, space = 8 + 8, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Add delegate function to the context
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK The pda to delegate
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

/// Account for the increment instruction.
#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

/// Account for the increment instruction + manual commit.
#[commit]
#[derive(Accounts)]
pub struct UndelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

#[account]
pub struct Counter {
    pub count: u64,
}

#[derive(Accounts)]
pub struct ScheduleIncrement<'info> {
    /// CHECK: used for CPI
    #[account()]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Passed to CPI - using UncheckedAccount to avoid Anchor re-serializing stale data after CPI
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: UncheckedAccount<'info>,
    /// CHECK: used for CPI
    pub program: UncheckedAccount<'info>,
}

/// Week-3 M-D(4): registers `tick_and_reschedule` as the scheduled task.
#[derive(Accounts)]
pub struct ScheduleTickAndReschedule<'info> {
    /// CHECK: used for CPI
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Passed to CPI, same pattern as `ScheduleIncrement`
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: UncheckedAccount<'info>,
}

/// Week-3 M-D(4): the scheduled task's own accounts. `payer` is `Signer<'info>`
/// on purpose — see `tick_and_reschedule`'s doc comment for why.
#[derive(Accounts)]
pub struct TickAndReschedule<'info> {
    /// CHECK: used for CPI
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}
