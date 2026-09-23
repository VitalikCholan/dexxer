use crate::{
    errors::DexxerError,
    instructions::disclosure::{due_reveals, pending_commitment},
    state::*,
};
use anchor_lang::prelude::*;
use anchor_lang::{Discriminator, InstructionData};
use ephemeral_rollups_sdk::{
    consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID},
    ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder},
    ActionArgs, ShortAccountMeta,
};

// spec §8 Q2 / week-2 controller ruling task-4 #5: batch-commit the public
// aggregate (`Pool`) on a fixed interval, never per-event (CLAUDE.md
// commit-cadence rule) — driven by `crank_tick`'s scheduled task, not a
// trading instruction. `payer` (`Config.fee_payer`) authorizes/signs the
// outer transaction so the scheduler can call this unattended — but week-2
// Task 5 fix round 1 (controller ruling) found that a top-level `Signer`
// structurally can never satisfy the fee-vault path's "payer must be
// delegated, signs via seeds" requirement (confirmed on real devnet:
// `commit_aggregate` hard-failed at commit #11 with `0xA0000000`, the
// no-vault-path limit, even with `.magic_fee_vault(...)` wired — see
// week2-results.md §Task 5 "03-commit-cycle"). The CPI's actual intent payer
// is now `fee_escrow` (state/fee_escrow.rs), a dedicated delegated PDA that
// signs via `invoke_signed` — mirroring the private-counter spike's M3b fix
// (`commit_with_vault` switched its CPI payer from a plain wallet to the
// delegated `counter` PDA for the same reason). `payer`/`fee_escrow` are
// deliberately independent (per fees-and-commit-economics.md: "the payer...
// and the committed accounts... are independent") — `payer` still gates who
// may call this instruction; `fee_escrow` is what the validator actually
// debits on the fee-vault path. Same executable-gated commit pattern as
// `withdraw` (instructions/user.rs): on LiteSVM no Magic program is deployed
// at `MAGIC_PROGRAM_ID`, so the account is absent/non-executable and the CPI
// is skipped rather than failing.
#[derive(Accounts)]
pub struct CommitAggregate<'info> {
    // Boxed (as `trade.rs` does for its larger accounts): `commit_aggregate`'s
    // remaining_accounts loop already carries several `Position`/`DisclosureQueue`
    // locals plus a `Vec<CallHandler>`, and `Config` alone is the biggest account
    // read here — keeping it on the heap is what keeps the function's stack
    // frame under the SBF 4096-byte limit (autofixer/build flagged the overflow
    // before this box).
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(constraint = payer.key() == config.fee_payer @ DexxerError::Unauthorized)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    // week-4 Task 1: the private live counters this call snapshots into `pool`
    // above (step-rounded). Read-only — `snapshot_into` only reads `self`.
    // NEVER included in `.commit(&[...])` below: `PoolLive` must stay off L1.
    #[account(seeds = [POOL_LIVE_SEED, pool_live.mint.as_ref()], bump = pool_live.bump,
        constraint = pool_live.mint == pool.mint @ DexxerError::PoolLiveMismatch)]
    pub pool_live: Account<'info, PoolLive>,
    // `zero_copy` (controller ruling 5) — AccountLoader, not Account/Box.
    #[account(mut, seeds = [BALANCES_ROOT_SEED], bump = balances_root.load()?.bump)]
    pub balances_root: AccountLoader<'info, BalancesRoot>,
    #[account(mut, seeds = [FEE_ESCROW_SEED], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: validator-scoped Magic Program fee vault; constrained to Config.magic_fee_vault
    /// (set by `init_config`/a future `set_fee_vault` admin ix; required on the fee-vault
    /// commit path when the payer is a delegated ER account — see fees-and-commit-economics.md)
    #[account(mut, constraint = magic_fee_vault.key() == config.magic_fee_vault @ DexxerError::Unauthorized)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the commit CPI via `.executable` in `commit_aggregate`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
// anchor-lang 1.0.2's single-lifetime `Context<'info, T>` (see `crank_tick`'s
// comment above `CrankTick`) — `remaining_accounts` is a mix of `Position` and
// `DisclosureQueue` accounts (owner- and seeds-checked below), each producing
// zero or more post-commit actions: a `Position` with a not-yet-written
// `Closed` record emits `write_commitment`; a `DisclosureQueue` with due
// records (`reveal_after_slot <= slot`) emits `write_disclosure` per record.
// Both mutations (flip `commitment_written`, pop the queue) happen in the same
// ER tx that schedules the action, so a failed/replayed bundle can never
// re-emit the same action (nonce reuse hard-fails `write_commitment`'s L1
// `init` — week-3 controller ruling 7).
// Split out of `commit_aggregate` (and marked `#[inline(never)]`) so its local
// `Position` (up to 400 B, `state/mod.rs`'s `print_sizes_for_spec_q3` bound)
// lives in its own call frame rather than `commit_aggregate`'s — the two
// candidate kinds are never live at once, but the SBF backend does not reuse
// stack slots across sibling branches in the same function, and their combined
// locals pushed `commit_aggregate` itself over the 4096-byte limit (build
// warning, fixed by this split).
#[inline(never)]
fn process_position_candidate<'info>(
    ai: &AccountInfo<'info>,
    config_key: Pubkey,
    payer: &AccountInfo<'info>,
    system_program: Pubkey,
    actions: &mut Vec<CallHandler<'info>>,
) -> Result<()> {
    let mut pos = Position::try_deserialize(&mut &ai.try_borrow_data()?[..])?;
    let (exp, _) = Pubkey::find_program_address(
        &[POSITION_SEED, pos.owner.as_ref(), pos.market.as_ref()],
        &crate::ID,
    );
    require!(ai.key() == exp, DexxerError::InvalidCandidate);
    if let Some((nonce, hash)) = pending_commitment(&pos) {
        require!(
            actions.len() < MAX_ACTIONS_PER_COMMIT,
            DexxerError::TooManyActions
        );
        // Hash-seeded (ruling 9): `nonce` is per-user, `hash` is globally unique.
        let (commitment, _) = Pubkey::find_program_address(&[COMMIT_SEED, &hash], &crate::ID);
        let data = crate::instruction::WriteCommitment { nonce, hash }.data();
        actions.push(CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta {
                    pubkey: commitment.to_bytes().into(),
                    is_writable: true,
                },
                ShortAccountMeta {
                    pubkey: config_key.to_bytes().into(),
                    is_writable: false,
                },
                ShortAccountMeta {
                    pubkey: system_program.to_bytes().into(),
                    is_writable: false,
                },
            ],
            args: ActionArgs::new(data),
            escrow_authority: payer.clone(),
            compute_units: 100_000,
        });
        if let Some(rec) = pos.closed.as_mut() {
            rec.commitment_written = true;
        }
        pos.try_serialize(&mut &mut ai.try_borrow_mut_data()?[..])?;
    }
    Ok(())
}

/// Same split as `process_position_candidate`, for `DisclosureQueue` (up to
/// 1300 B — the larger of the two candidate kinds, per the same size bound).
#[inline(never)]
fn process_disclosure_queue_candidate<'info>(
    ai: &AccountInfo<'info>,
    slot: u64,
    config_key: Pubkey,
    payer: &AccountInfo<'info>,
    system_program: Pubkey,
    actions: &mut Vec<CallHandler<'info>>,
) -> Result<()> {
    let mut dq = DisclosureQueue::try_deserialize(&mut &ai.try_borrow_data()?[..])?;
    let (exp, _) = Pubkey::find_program_address(&[DQ_SEED, dq.owner.as_ref()], &crate::ID);
    require!(ai.key() == exp, DexxerError::InvalidCandidate);
    let room = MAX_ACTIONS_PER_COMMIT.saturating_sub(actions.len());
    for (args, salt) in due_reveals(&mut dq, slot, room)? {
        // Hash-seeded (ruling 9), same hash as WriteDisclosure recomputes from (args, salt).
        let hash = commitment_hash(&args, &salt);
        let (disclosure, _) = Pubkey::find_program_address(&[DISCLOSURE_SEED, &hash], &crate::ID);
        let (commitment, _) = Pubkey::find_program_address(&[COMMIT_SEED, &hash], &crate::ID);
        let data = crate::instruction::WriteDisclosure { args, salt }.data();
        actions.push(CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta {
                    pubkey: disclosure.to_bytes().into(),
                    is_writable: true,
                },
                ShortAccountMeta {
                    pubkey: commitment.to_bytes().into(),
                    is_writable: false,
                },
                ShortAccountMeta {
                    pubkey: config_key.to_bytes().into(),
                    is_writable: false,
                },
                ShortAccountMeta {
                    pubkey: system_program.to_bytes().into(),
                    is_writable: false,
                },
            ],
            args: ActionArgs::new(data),
            escrow_authority: payer.clone(),
            compute_units: 120_000,
        });
    }
    dq.try_serialize(&mut &mut ai.try_borrow_mut_data()?[..])?;
    Ok(())
}

pub fn commit_aggregate<'info>(ctx: Context<'info, CommitAggregate<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    // Step-rounded snapshot (week-4 Task 1), set before the commit CPI so the
    // committed bytes carry it: assets down, liabilities up, `last_commit_slot`
    // stamped inside `snapshot_into`.
    ctx.accounts
        .pool_live
        .snapshot_into(&mut ctx.accounts.pool, clock.slot)?;

    let mut actions: Vec<CallHandler> = Vec::new();
    let system_program = anchor_lang::system_program::ID;
    let config_key = ctx.accounts.config.key();
    let payer_ai = ctx.accounts.payer.to_account_info();
    for ai in ctx.remaining_accounts.iter() {
        require!(
            ai.owner == &crate::ID && ai.is_writable,
            DexxerError::InvalidCandidate
        );
        let disc: [u8; 8] = {
            let data = ai.try_borrow_data()?;
            data[..8]
                .try_into()
                .map_err(|_| DexxerError::InvalidCandidate)?
        };
        if disc == Position::DISCRIMINATOR {
            process_position_candidate(ai, config_key, &payer_ai, system_program, &mut actions)?;
        } else if disc == DisclosureQueue::DISCRIMINATOR {
            process_disclosure_queue_candidate(
                ai,
                clock.slot,
                config_key,
                &payer_ai,
                system_program,
                &mut actions,
            )?;
        } else {
            return err!(DexxerError::InvalidCandidate);
        }
    }

    // Only in a real ER does a Magic program actually live at this address;
    // on LiteSVM (and any environment without the ER runtime) it is absent,
    // so skip the commit CPI rather than fail.
    if ctx.accounts.magic_program.to_account_info().executable {
        let bump = ctx.accounts.fee_escrow.bump;
        let seeds: &[&[u8]] = &[FEE_ESCROW_SEED, &[bump]];
        let builder = MagicIntentBundleBuilder::new(
            ctx.accounts.fee_escrow.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit(&[
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.balances_root.to_account_info(),
        ]);
        let builder = if actions.is_empty() {
            builder
        } else {
            builder.add_post_commit_actions(actions)
        };
        builder.build_and_invoke_signed(&[seeds])?;
    }
    Ok(())
}

// Same template as `commit_aggregate`, for `Market` after `set_params`.
// Admin-gated rather than fee-payer-gated: `Market` carries no per-user
// fields (spec §8 Q2), so there is no privacy reason to route it through the
// scheduled fee-payer path, and admin already signs `set_params` itself.
#[derive(Accounts)]
pub struct CommitMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ DexxerError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, &market.symbol], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: ER `MagicContext` PDA; only written when `magic_program` is executable (real ER)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: address-checked; gates the commit CPI via `.executable` in `commit_market`
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
pub fn commit_market(ctx: Context<CommitMarket>) -> Result<()> {
    if ctx.accounts.magic_program.to_account_info().executable {
        MagicIntentBundleBuilder::new(
            ctx.accounts.admin.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.market.to_account_info()])
        .build_and_invoke()?;
    }
    Ok(())
}
