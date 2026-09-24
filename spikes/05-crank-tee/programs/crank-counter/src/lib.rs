use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::access_control::{
    instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
    structs::{
        EphemeralMembersArgs, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG,
        TX_MESSAGE_FLAG,
    },
};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::crank::{CancelCrankCpi, ScheduleCrankCpi, ScheduleTaskArgs};

declare_id!("9pAYXKX2xwpsUhQFvW5rGVGRKmv9mTwpPLMGKgBHsv3q");

pub const COUNTER_SEED: &[u8] = b"counter";
/// Week-5 Task 0 (spike P3): one simulated position per slot.
pub const SLOT_SEED: &[u8] = b"w5slot";
/// Week-5 Task 0 (spike P3): shared program-owned task authority / CPI payer.
pub const ESCROW_SEED: &[u8] = b"w5escrow";

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
            data: anchor_lang::InstructionData::data(&crate::instruction::TickAndReschedule {
                args: args.clone(),
            }),
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

    // ===================================================================
    // Week-5 Task 0 (spike P3): per-position scheduler measurements.
    //
    // Everything below simulates ONE POSITION PER SCHEDULED TASK: a
    // `SlotCounter` PDA stands in for a `Position`, its `flag` for
    // "position is Open", and `slot_tick` for `crank_tick`'s
    // liquidation check on that one position. The scheduled task is
    // registered with the program-owned `escrow` PDA as the CPI payer
    // (`invoke_signed`) so the task authority is the PROGRAM, not a
    // wallet — that is what would let `open_position` register and
    // `close_position` cancel a task without a human signer.
    // ===================================================================

    /// Base layer: create the shared escrow PDA and pre-fund it. The escrow
    /// is the CPI payer of `ScheduleCrankCpi` and the `authority` of
    /// `CancelCrankCpi`; it must be delegated (`delegate_escrow`) before it
    /// can be a writable signer inside the ER.
    pub fn init_escrow(ctx: Context<InitEscrow>, prefund_lamports: u64) -> Result<()> {
        ctx.accounts.escrow.bump = ctx.bumps.escrow as u64;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            prefund_lamports,
        )?;
        msg!(
            "escrow {} prefunded {}",
            ctx.accounts.escrow.key(),
            prefund_lamports
        );
        Ok(())
    }

    /// Base layer: create one "position" slot. `prefund_lamports` covers the
    /// ephemeral permission account this slot will own on the ER (spike 01's
    /// week-2 finding: budget for the full rent-exempt minimum, not the
    /// marginal resize delta).
    pub fn init_slot(ctx: Context<InitSlot>, index: [u8; 1], prefund_lamports: u64) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        let slot = &mut ctx.accounts.slot;
        slot.authority = authority;
        slot.count = 0;
        slot.ticks = 0;
        slot.last_signer = Pubkey::default();
        slot.index = index;
        slot.flag = 0;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.slot.to_account_info(),
                },
            ),
            prefund_lamports,
        )?;
        Ok(())
    }

    /// Base layer: delegate a slot PDA to the (TEE) ER.
    pub fn delegate_slot(ctx: Context<DelegateInput>, index: [u8; 1]) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[SLOT_SEED, &index],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Base layer: delegate the escrow PDA to the (TEE) ER.
    pub fn delegate_escrow(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[ESCROW_SEED],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// ER: create the slot's ephemeral permission (public at first).
    /// Payer and permissioned account are both the slot PDA, which signs
    /// via its own seeds — same shape as spike 01's `init_permission`.
    pub fn init_slot_permission(ctx: Context<SlotPermission>) -> Result<()> {
        if ctx.accounts.permission.lamports() > 0 {
            msg!("permission already exists, skipping");
            return Ok(());
        }
        let index = ctx.accounts.slot.index;
        let signers = [SLOT_SEED, &index[..], &[ctx.bumps.slot]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.slot.to_account_info(),
            permissioned_account: ctx.accounts.slot.to_account_info(),
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

    /// ER: flip the slot's permission to private with an explicit member list.
    /// `extra` is week-5's knob for measurement (5): pass `Pubkey::default()`
    /// for an OWNER-ONLY member list (the scheduler's crank signer is then
    /// NOT a member), or the crank signer PDA to add it as a member.
    pub fn set_slot_privacy(
        ctx: Context<SlotPermission>,
        is_private: bool,
        extra: Pubkey,
    ) -> Result<()> {
        let index = ctx.accounts.slot.index;
        let signers = [SLOT_SEED, &index[..], &[ctx.bumps.slot]];
        let members = if is_private {
            let mut m = vec![Member {
                flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                pubkey: ctx.accounts.slot.authority,
            }];
            if extra != Pubkey::default() {
                m.push(Member {
                    flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                    pubkey: extra,
                });
            }
            m
        } else {
            vec![]
        };
        msg!(
            "set_slot_privacy private={} members={}",
            is_private,
            members.len()
        );
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.slot.to_account_info(),
            permissioned_account: ctx.accounts.slot.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.slot.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private,
                members,
            },
        }
        .invoke_signed(&[&signers])?;
        Ok(())
    }

    /// ER: owner flips the "position is Open" flag the scheduled tick gates on.
    pub fn set_flag(ctx: Context<SetFlag>, flag: u8) -> Result<()> {
        ctx.accounts.slot.flag = flag;
        Ok(())
    }

    /// ER: register one scheduled task for one slot.
    ///
    /// `use_escrow` selects the task AUTHORITY: `true` = the program's
    /// `escrow` PDA signs the `ScheduleTask` CPI via `invoke_signed`
    /// (the open-time-registration shape Task 3 needs); `false` = the
    /// `owner` wallet signs it directly (the week-4 shape, kept as a
    /// control so a PDA-specific failure is distinguishable).
    ///
    /// `instruction_accounts` MUST come from `ctx.remaining_accounts`:
    /// `ScheduleCrankCpi`'s `compat::AccountInfo<'a>` is invariant in
    /// `'a`, and only `remaining_accounts` is `&'info [AccountInfo<'info>]`
    /// (same constraint `dexxer_core::schedule_crank` documents). Order is
    /// `[task_context, crank, slot]` — matching `ScheduleTask`'s own account
    /// layout (0 = payer, prepended by the CPI; 1 = task context; 2.. = the
    /// task's accounts).
    pub fn schedule_slot_task<'info>(
        ctx: Context<'info, ScheduleSlotTask<'info>>,
        args: ScheduleIncrementArgs,
        use_escrow: bool,
    ) -> Result<()> {
        let rem = ctx.remaining_accounts;
        require!(rem.len() == 3, SpikeError::BadRemainingAccounts);
        let expected = [
            ctx.accounts.task_context.key(),
            ctx.accounts.crank.key(),
            ctx.accounts.slot.key(),
        ];
        for (ai, key) in rem.iter().zip(expected.iter()) {
            require!(ai.key() == *key, SpikeError::BadRemainingAccounts);
        }

        let tick_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                // Only the scheduler's derived crank signer may be a signer in
                // a scheduled inner instruction, and it must be read-only.
                AccountMeta::new_readonly(ctx.accounts.crank.key(), true),
                AccountMeta::new(ctx.accounts.slot.key(), false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::SlotTick {}),
        };

        let payer: &AccountInfo<'info> = if use_escrow {
            &ctx.accounts.escrow
        } else {
            &ctx.accounts.owner
        };
        let cpi = ScheduleCrankCpi {
            payer,
            magic_program: &&ctx.accounts.magic_program,
            instruction_accounts: rem,
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![tick_ix],
            },
        };
        if use_escrow {
            cpi.invoke_signed(&[&[ESCROW_SEED, &[ctx.bumps.escrow]]])?;
        } else {
            cpi.invoke()?;
        }
        msg!(
            "schedule_slot_task task_id={} use_escrow={} slot={}",
            args.task_id,
            use_escrow,
            ctx.accounts.slot.key()
        );
        Ok(())
    }

    /// ER: cancel a task. `use_escrow = true` makes the program's `escrow`
    /// PDA the `CancelCrankCpi` authority via `invoke_signed` — measurement
    /// (3). `false` cancels as the `owner` wallet (control / wrong-authority
    /// probe, depending on who registered the task).
    pub fn cancel_slot_task<'info>(
        ctx: Context<'info, CancelSlotTask<'info>>,
        task_id: i64,
        use_escrow: bool,
    ) -> Result<()> {
        let authority: &AccountInfo<'info> = if use_escrow {
            &ctx.accounts.escrow
        } else {
            &ctx.accounts.owner
        };
        let cpi = CancelCrankCpi {
            authority,
            task_context: &ctx.accounts.task_context,
            magic_program: &ctx.accounts.magic_program,
            crank_id: task_id,
        };
        if use_escrow {
            cpi.invoke_signed(&[&[ESCROW_SEED, &[ctx.bumps.escrow]]])?;
        } else {
            cpi.invoke()?;
        }
        msg!(
            "cancel_slot_task task_id={} use_escrow={}",
            task_id,
            use_escrow
        );
        Ok(())
    }

    /// ER: the scheduled instruction itself — one position's tick.
    ///
    /// `ticks` counts every landed execution (so "did the task run at all"
    /// is observable even when the position is closed), `count` only
    /// advances while `flag == 1` ("position is Open" — the liquidation
    /// check the real `crank_tick` would do). `last_signer` records whatever
    /// key the scheduler actually supplied as the signer: that is the
    /// measurement of which PDA the validator derives, and it is recorded
    /// rather than enforced so a wrong signer shows up as data, not as a
    /// failed transaction indistinguishable from every other failure.
    pub fn slot_tick(ctx: Context<SlotTickAccounts>) -> Result<()> {
        let signer = ctx.accounts.crank.key();
        let slot = &mut ctx.accounts.slot;
        slot.ticks = slot.ticks.saturating_add(1);
        slot.last_signer = signer;
        if slot.flag == 1 {
            slot.count = slot.count.saturating_add(1);
        }
        msg!(
            "slot_tick idx={} ticks={} count={} flag={} signer={}",
            slot.index[0],
            slot.ticks,
            slot.count,
            slot.flag,
            signer
        );
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

// =========================================================================
// Week-5 Task 0 (spike P3) account structs. See the instruction bodies in
// the `#[program]` module above for what each measurement is for.
// =========================================================================

#[error_code]
pub enum SpikeError {
    #[msg("remaining_accounts must be exactly [task_context, crank, slot]")]
    BadRemainingAccounts,
}

/// One simulated position.
#[account]
pub struct SlotCounter {
    pub authority: Pubkey,
    /// Ticks that landed while `flag == 1` ("position Open").
    pub count: u64,
    /// Every landed tick, open or not.
    pub ticks: u64,
    /// The key the scheduler supplied as the scheduled instruction's signer.
    pub last_signer: Pubkey,
    /// PDA seed byte; `[u8; 1]` (not `u8`) so `seeds = [SLOT_SEED, &slot.index]`
    /// borrows from the account instead of a temporary.
    pub index: [u8; 1],
    /// 1 = "position Open".
    pub flag: u8,
}

/// Shared task authority / CPI payer. The account body is irrelevant; the
/// lamports and the fact that the PROGRAM can sign for it are the point.
#[account]
pub struct Escrow {
    pub bump: u64,
}

#[derive(Accounts)]
pub struct InitEscrow<'info> {
    #[account(init, payer = authority, space = 8 + 8, seeds = [ESCROW_SEED], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: [u8; 1])]
pub struct InitSlot<'info> {
    #[account(init, payer = authority, space = 8 + 32 + 8 + 8 + 32 + 1 + 1, seeds = [SLOT_SEED, &index], bump)]
    pub slot: Account<'info, SlotCounter>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Shared context for `init_slot_permission` / `set_slot_privacy`.
#[derive(Accounts)]
pub struct SlotPermission<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SLOT_SEED, &slot.index], bump, has_one = authority)]
    pub slot: Account<'info, SlotCounter>,
    /// CHECK: verified by the permission program; seeds match the on-chain layout
    #[account(mut, seeds = [PERMISSION_SEED, slot.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetFlag<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SLOT_SEED, &slot.index], bump, has_one = authority)]
    pub slot: Account<'info, SlotCounter>,
}

#[derive(Accounts)]
pub struct ScheduleSlotTask<'info> {
    /// Outer-transaction signer and ER fee payer. A PDA can never be that,
    /// which is exactly why `escrow` exists as a separate CPI payer.
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: program-owned task authority; signs the CPI via `invoke_signed`
    #[account(mut, seeds = [ESCROW_SEED], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the delegated slot the scheduled instruction writes; passed through
    #[account(mut)]
    pub slot: UncheckedAccount<'info>,
    /// CHECK: the crank signer the scheduler is expected to supply; passed through
    pub crank: UncheckedAccount<'info>,
    /// CHECK: Magic Actions task-context account — no SDK derivation exists for
    /// it (week-2 Task 1 finding), so the client supplies the candidate and
    /// measurement (6) reports which candidates the scheduler accepts.
    #[account(mut)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelSlotTask<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: program-owned task authority; signs the CPI via `invoke_signed`
    #[account(mut, seeds = [ESCROW_SEED], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: same value the matching `schedule_slot_task` registered with
    #[account(mut)]
    pub task_context: UncheckedAccount<'info>,
    /// CHECK: address-checked
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// The scheduled instruction's accounts. `crank` is a bare `Signer` on
/// purpose — whatever the scheduler supplies is recorded, not rejected.
#[derive(Accounts)]
pub struct SlotTickAccounts<'info> {
    pub crank: Signer<'info>,
    #[account(mut, seeds = [SLOT_SEED, &slot.index], bump)]
    pub slot: Account<'info, SlotCounter>,
}
