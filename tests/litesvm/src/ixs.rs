use crate::{
    apk, pdas, pk,
    setup::{Trader, World},
    token_ix::{ata, ATA_PROGRAM, RENT, SYSTEM, TOKEN},
};
use anchor_lang::InstructionData;
use dexxer_core::{
    instruction as ix,
    state::{commitment_hash, DisclosureArgs, MarketParams, Side},
};
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

fn prog() -> Pubkey {
    pk(dexxer_core::ID)
}
fn w(p: &Pubkey) -> AccountMeta {
    AccountMeta::new(*p, false)
}
fn r(p: &Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(*p, false)
}
fn s(p: &Pubkey) -> AccountMeta {
    AccountMeta::new(*p, true)
}
fn rs(p: &Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(*p, true)
}

#[allow(clippy::too_many_arguments)]
pub fn init_config(
    admin: &Pubkey,
    mint: &Pubkey,
    crank: &Pubkey,
    oracle_program: &Pubkey,
    tee_validator: &Pubkey,
    delay: u64,
    scheduler_signer: &Pubkey,
    fee_payer: &Pubkey,
    magic_fee_vault: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            w(&pdas::config()),
            s(mint),
            r(&pdas::mint_auth()),
            r(&SYSTEM),
            r(&TOKEN),
            r(&RENT),
        ],
        data: ix::InitConfig {
            crank: apk(*crank),
            oracle_program: apk(*oracle_program),
            tee_validator: apk(*tee_validator),
            disclosure_delay_slots: delay,
            scheduler_signer: apk(*scheduler_signer),
            fee_payer: apk(*fee_payer),
            magic_fee_vault: apk(*magic_fee_vault),
        }
        .data(),
    }
}
pub fn init_market(admin: &Pubkey, params: MarketParams, lazer_feed_id: &str) -> Instruction {
    let m = pdas::market();
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            r(&pdas::config()),
            w(&m),
            w(&pdas::risk(&m)),
            r(&SYSTEM),
        ],
        data: ix::InitMarket {
            params,
            lazer_feed_id: lazer_feed_id.to_string(),
        }
        .data(),
    }
}
pub fn init_pool(admin: &Pubkey, mint: &Pubkey) -> Instruction {
    let p = pdas::pool(mint);
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            r(&pdas::config()),
            w(&p),
            r(mint),
            w(&ata(&p, mint)),
            r(&SYSTEM),
            r(&TOKEN),
            r(&ATA_PROGRAM),
        ],
        data: ix::InitPool {}.data(),
    }
}
pub fn init_fee_escrow(admin: &Pubkey) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            r(&pdas::config()),
            w(&pdas::fee_escrow()),
            r(&SYSTEM),
        ],
        data: ix::InitFeeEscrow {}.data(),
    }
}
pub fn init_pool_live(admin: &Pubkey, mint: &Pubkey) -> Instruction {
    let p = pdas::pool(mint);
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            r(&pdas::config()),
            r(&p),
            w(&pdas::pool_live(mint)),
            r(&SYSTEM),
        ],
        data: ix::InitPoolLive {}.data(),
    }
}
pub fn init_balances_root(admin: &Pubkey) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            r(&pdas::config()),
            w(&pdas::balances_root()),
            r(&SYSTEM),
        ],
        data: ix::InitBalancesRoot {}.data(),
    }
}
/// `init_market_permissions` (admin, ER): make `MarketRisk` and `PoolLive`
/// permissioned `[crank, admin]` in one call (week-4 Task 2, risk #24). Same
/// permission/vault/magic accounts as `init_permissions`; no-op on LiteSVM
/// since no permission program is deployed here (`permission_program`
/// resolves to an empty, non-executable PDA).
pub fn init_market_permissions(admin: &Pubkey, wd: &World) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(admin),
            r(&wd.config),
            r(&wd.market),
            w(&wd.risk),
            w(&wd.pool_live),
            w(&pdas::permission(&wd.risk)),
            w(&pdas::permission(&wd.pool_live)),
            r(&pdas::permission_program()),
            w(&pdas::ephemeral_vault()),
            r(&pdas::magic_program()),
        ],
        data: ix::InitMarketPermissions {}.data(),
    }
}
pub fn set_params(
    admin: &Pubkey,
    config: &Pubkey,
    market: &Pubkey,
    params: MarketParams,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![rs(admin), r(config), w(market)],
        data: ix::SetParams { params }.data(),
    }
}
pub fn pause(admin: &Pubkey, config: &Pubkey) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![rs(admin), w(config)],
        data: ix::Pause {}.data(),
    }
}
pub fn unpause(admin: &Pubkey, config: &Pubkey) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![rs(admin), w(config)],
        data: ix::Unpause {}.data(),
    }
}
// Task-6 fix round 3: base-layer admin ix, same AdminConfig shape as pause/unpause.
pub fn set_scheduler_signer(
    admin: &Pubkey,
    config: &Pubkey,
    new_scheduler_signer: Pubkey,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![rs(admin), w(config)],
        data: ix::SetSchedulerSigner {
            new_scheduler_signer: apk(new_scheduler_signer),
        }
        .data(),
    }
}
pub fn seed_pool(admin: &Pubkey, wd: &World, amount: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(admin),
            r(&wd.config),
            w(&wd.pool),
            w(&wd.pool_live),
            w(&ata(admin, &wd.mint)),
            w(&wd.pool_ata),
            r(&TOKEN),
        ],
        data: ix::SeedPool { amount }.data(),
    }
}
pub fn faucet_init(owner: &Pubkey, wd: &World, amount: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(owner),
            s(owner), // payer (fix round 1, task 6 controller ruling): owner self-pays in tests
            r(&wd.config),
            w(&pdas::faucet(owner)),
            w(&wd.mint),
            r(&pdas::mint_auth()),
            w(&ata(owner, &wd.mint)),
            r(&SYSTEM),
            r(&TOKEN),
        ],
        data: ix::FaucetInit { amount }.data(),
    }
}
pub fn faucet_mint(owner: &Pubkey, wd: &World, amount: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(owner),
            r(&wd.config),
            w(&pdas::faucet(owner)),
            w(&wd.mint),
            r(&pdas::mint_auth()),
            w(&ata(owner, &wd.mint)),
            r(&TOKEN),
        ],
        data: ix::FaucetMint { amount }.data(),
    }
}
pub fn init_user(owner: &Pubkey, wd: &World, exit_salt: [u8; 32]) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(owner),
            s(owner), // payer (fix round 1, task 6 controller ruling): owner self-pays in tests
            r(&wd.config),
            r(&wd.market),
            w(&pdas::user(owner)),
            w(&pdas::position(owner, &wd.market)),
            w(&pdas::dq(owner)),
            r(&SYSTEM),
        ],
        data: ix::InitUser { exit_salt }.data(),
    }
}
pub fn set_session(
    signer: &Pubkey,
    t: &Trader,
    session: &Pubkey,
    expiry: i64,
    actions: u32,
) -> Instruction {
    // `SetSession` gains the same permission/vault/magic/permission_program
    // accounts `InitPermissions` has (task-2). On LiteSVM these are empty
    // (system-owned, 0-lamport) PDAs — that's the point: the permission
    // program doesn't exist here, so `perm.owner != PERMISSION_PROGRAM_ID`
    // and the program skips the update CPI.
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(signer),
            r(&pdas::config()),
            r(&pdas::market()),
            w(&t.user),
            w(&t.position),
            w(&t.dq),
            w(&pdas::permission(&t.user)),
            w(&pdas::permission(&t.position)),
            w(&pdas::permission(&t.dq)),
            r(&pdas::permission_program()),
            w(&pdas::ephemeral_vault()),
            r(&pdas::magic_program()),
        ],
        data: ix::SetSession {
            session_key: apk(*session),
            expiry,
            actions,
        }
        .data(),
    }
}
pub fn open_position(
    signer: &Pubkey,
    t: &Trader,
    w: &World,
    side: Side,
    size: u64,
    margin: u64,
    limit_price: u64,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts(w, signer),
        data: ix::OpenPosition {
            side,
            size,
            margin,
            limit_price,
        }
        .data(),
    }
}
pub fn add_margin(signer: &Pubkey, t: &Trader, w: &World, amount: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts(w, signer),
        data: ix::AddMargin { amount }.data(),
    }
}
pub fn close_position(signer: &Pubkey, t: &Trader, w: &World, limit_price: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts(w, signer),
        data: ix::ClosePosition { limit_price }.data(),
    }
}
pub fn increase_position(
    signer: &Pubkey,
    t: &Trader,
    w: &World,
    add_size: u64,
    add_margin: u64,
    limit_price: u64,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts(w, signer),
        data: ix::IncreasePosition {
            add_size,
            add_margin,
            limit_price,
        }
        .data(),
    }
}
pub fn decrease_position(
    signer: &Pubkey,
    t: &Trader,
    w: &World,
    close_size: u64,
    limit_price: u64,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts(w, signer),
        data: ix::DecreasePosition {
            close_size,
            limit_price,
        }
        .data(),
    }
}
/// `candidates` become `remaining_accounts` triples `[Position, UserAccount,
/// DisclosureQueue]` (week-5 Task 1: a liquidation is a close, and a close
/// pushes its record into the owner's queue).
pub fn crank_tick(crank: &Pubkey, wd: &World, candidates: &[&Trader]) -> Instruction {
    // `crank: Signer<'info>` in `CrankTick` carries no `#[account(mut)]`, so the
    // client-side meta must be a readonly signer, not writable (`s`).
    let mut accounts = vec![
        rs(crank),
        r(&wd.config),
        w(&wd.market),
        w(&wd.risk),
        w(&wd.pool_live),
        r(&wd.feed),
    ];
    for t in candidates {
        accounts.push(w(&t.position));
        accounts.push(w(&t.user));
        accounts.push(w(&t.dq));
    }
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::CrankTick {}.data(),
    }
}
pub fn credit_deposit(signer: &Pubkey, t: &Trader, wd: &World, amount: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(signer),
            w(&t.user),
            r(&wd.pool),
            w(&wd.pool_live),
            w(&ata(signer, &wd.mint)),
            w(&wd.pool_ata),
            r(&TOKEN),
        ],
        data: ix::CreditDeposit { amount }.data(),
    }
}
pub fn withdraw(signer: &Pubkey, t: &Trader, wd: &World, amount: u64) -> Instruction {
    // `owner_ata` is derived from `signer` (not necessarily the trader's real
    // owner) so the session-key-rejection test can pass a mismatched signer
    // and exercise the program's owner check.
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(signer),
            w(&t.user),
            r(&wd.pool),
            w(&wd.pool_live),
            w(&ata(signer, &wd.mint)),
            w(&wd.pool_ata),
            r(&TOKEN),
            r(&wd.config),
            w(&wd.fee_escrow),
            w(&wd.magic_fee_vault),
            w(&pdas::magic_context()),
            r(&pdas::magic_program()),
        ],
        data: ix::Withdraw { amount }.data(),
    }
}
/// `payer` must equal `Config.fee_payer` (`w.fee_payer` in tests). `extra` is any
/// mix of `Position`/`DisclosureQueue` accounts appended after the fixed accounts —
/// `commit_aggregate` reads them from `remaining_accounts`.
pub fn commit_aggregate(payer: &Pubkey, wd: &World, extra: &[AccountMeta]) -> Instruction {
    let mut accounts = vec![
        r(&wd.config),
        rs(payer),
        w(&wd.pool),
        r(&wd.pool_live),
        w(&wd.balances_root),
        w(&wd.fee_escrow),
        w(&wd.magic_fee_vault),
        w(&pdas::magic_context()),
        r(&pdas::magic_program()),
    ];
    accounts.extend_from_slice(extra);
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::CommitAggregate {}.data(),
    }
}
/// Shared account layout for a direct (non-Magic-Action) call to `write_commitment`:
/// `escrow_auth_meta` carries the caller-vs-real-fee-payer distinction (signer or
/// not), `escrow_auth_key` derives the `escrow` action-balance PDA that must sign
/// and never can.
fn write_commitment_direct_accounts(
    escrow_auth_meta: AccountMeta,
    escrow_auth_key: &Pubkey,
    wd: &World,
    hash: &[u8; 32],
) -> Vec<AccountMeta> {
    vec![
        w(&pdas::commitment(hash)),
        r(&wd.config),
        r(&SYSTEM),
        r(&prog()),
        escrow_auth_meta,
        w(&pdas::action_escrow(escrow_auth_key)),
    ]
}
/// Direct call to `write_commitment` by a plain wallet impersonating the action path:
/// `caller` signs as `escrow_auth` (a wallet can legitimately sign for itself), and
/// `escrow` is its derived action-escrow PDA — but **not** as a signer, since no wallet
/// holds the private key for a PDA. This must be rejected by the `#[action]`
/// escrow-signer / `source_program` checks.
pub fn write_commitment_direct(
    caller: &Pubkey,
    wd: &World,
    nonce: u64,
    hash: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: write_commitment_direct_accounts(rs(caller), caller, wd, &hash),
        data: ix::WriteCommitment { nonce, hash }.data(),
    }
}
/// Same shape as `write_commitment_direct`, but `escrow_auth` is the *real*
/// `Config.fee_payer` (public knowledge — no signature required by the program's
/// own constraint, which only checks the pubkey value) rather than the caller,
/// and is never marked as a transaction signer. Isolates the one remaining gate a
/// plain wallet cannot pass: `escrow` itself, which must be a signer at
/// `ephemeral_balance_pda_from_payer(escrow_auth, ACTION_ESCROW_INDEX)` — a PDA no
/// wallet holds the private key for.
pub fn write_commitment_direct_with_escrow_auth(
    escrow_auth: &Pubkey,
    wd: &World,
    nonce: u64,
    hash: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: write_commitment_direct_accounts(r(escrow_auth), escrow_auth, wd, &hash),
        data: ix::WriteCommitment { nonce, hash }.data(),
    }
}
/// Same split as `write_commitment_direct_accounts`, for `write_disclosure`.
/// `hash` is `commitment_hash(args, salt)` — both PDAs are seeded by it (ruling 9).
fn write_disclosure_direct_accounts(
    escrow_auth_meta: AccountMeta,
    escrow_auth_key: &Pubkey,
    wd: &World,
    hash: &[u8; 32],
) -> Vec<AccountMeta> {
    vec![
        w(&pdas::disclosure(hash)),
        r(&pdas::commitment(hash)),
        r(&wd.config),
        r(&SYSTEM),
        r(&prog()),
        escrow_auth_meta,
        w(&pdas::action_escrow(escrow_auth_key)),
    ]
}
/// Direct call to `write_disclosure` — same attack shape as `write_commitment_direct`.
pub fn write_disclosure_direct(
    caller: &Pubkey,
    wd: &World,
    args: DisclosureArgs,
    salt: [u8; 32],
) -> Instruction {
    let hash = commitment_hash(&args, &salt);
    Instruction {
        program_id: prog(),
        accounts: write_disclosure_direct_accounts(rs(caller), caller, wd, &hash),
        data: ix::WriteDisclosure { args, salt }.data(),
    }
}
/// Same shape as `write_disclosure_direct`, `escrow_auth`-parameterised like
/// `write_commitment_direct_with_escrow_auth`.
pub fn write_disclosure_direct_with_escrow_auth(
    escrow_auth: &Pubkey,
    wd: &World,
    args: DisclosureArgs,
    salt: [u8; 32],
) -> Instruction {
    let hash = commitment_hash(&args, &salt);
    Instruction {
        program_id: prog(),
        accounts: write_disclosure_direct_accounts(r(escrow_auth), escrow_auth, wd, &hash),
        data: ix::WriteDisclosure { args, salt }.data(),
    }
}
/// `set_balances_root` (ER, crank): `extra` is the batch of `UserAccount`
/// pubkeys (readonly, `remaining_accounts`) whose leaves this call computes.
pub fn set_balances_root(
    crank: &Pubkey,
    wd: &World,
    begin: bool,
    finalize: bool,
    padding_seed: [u8; 32],
    extra: &[AccountMeta],
) -> Instruction {
    let mut accounts = vec![rs(crank), r(&wd.config), w(&wd.balances_root)];
    accounts.extend_from_slice(extra);
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::SetBalancesRoot {
            begin,
            finalize,
            padding_seed,
        }
        .data(),
    }
}
/// `undelegate_user` (owner, ER): scrub -> close permission x3 -> commit_and_undelegate.
/// Same permission/vault/magic accounts as `set_session`, plus `fee_escrow`/
/// `magic_fee_vault`/`magic_context`/`magic_program` (as in `withdraw`).
pub fn undelegate_user(signer: &Pubkey, t: &Trader, wd: &World) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(signer),
            r(&wd.config),
            w(&t.user),
            w(&t.position),
            w(&t.dq),
            w(&pdas::permission(&t.user)),
            w(&pdas::permission(&t.position)),
            w(&pdas::permission(&t.dq)),
            w(&pdas::ephemeral_vault()),
            r(&pdas::permission_program()),
            w(&wd.fee_escrow),
            w(&wd.magic_fee_vault),
            w(&pdas::magic_context()),
            r(&pdas::magic_program()),
        ],
        data: ix::UndelegateUser {}.data(),
    }
}

/// `ComputeBudgetProgram::SetComputeUnitLimit` (discriminant `2`, u32 LE units),
/// hand-built so the test crate needs no extra dependency. A full `crank_tick`
/// batch no longer fits in the 200k default: 16 candidates measure ~166k when
/// none liquidate but 367k when all of them do (week-5 Task 1 put a
/// `DisclosureQueue` in every candidate triple), so any client that fills the
/// batch has to raise the limit — `services/relayer/src/crank.ts` does the same.
pub fn set_compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

// ---------------------------------------------------------------- week-5 Task 2

/// `close_orphan_queue` (ER, crank): reclaims the `DisclosureQueue` an exited
/// user left behind once its last record has been revealed.
pub fn close_orphan_queue(crank: &Pubkey, t: &Trader, wd: &World) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(crank),
            r(&wd.config),
            w(&t.dq),
            // Read-only and unchecked on purpose: its absence (or foreign
            // owner) is what the instruction reads as "the owner has exited".
            r(&t.user),
            w(&pdas::permission(&t.dq)),
            w(&pdas::ephemeral_vault()),
            r(&pdas::permission_program()),
            w(&wd.fee_escrow),
            w(&wd.magic_fee_vault),
            w(&pdas::magic_context()),
            r(&pdas::magic_program()),
        ],
        data: ix::CloseOrphanQueue {}.data(),
    }
}

/// `close_exited_user` (base layer, `Config.fee_payer`): rent reclaim on all
/// three of an exited owner's undelegated PDAs.
pub fn close_exited_user(fee_payer: &Pubkey, t: &Trader, wd: &World) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(fee_payer),
            r(&wd.config),
            w(&t.user),
            w(&t.position),
            w(&t.dq),
        ],
        data: ix::CloseExitedUser {}.data(),
    }
}

/// `delegate_user` (base layer): the `#[delegate]` macro expands each delegated
/// PDA into a `[buffer, delegation_record, delegation_metadata, account]`
/// quadruple — buffer under this program, record/metadata under the delegation
/// program. LiteSVM deploys no delegation program, so the CPI itself always
/// fails here; the builder exists so the guards that run BEFORE it (week-5 Task
/// 2 fix round 1: `exited`) can be tested.
pub fn delegate_user(owner: &Pubkey, wd: &World) -> Instruction {
    use ephemeral_rollups_sdk::pda::{
        DELEGATE_BUFFER_TAG, DELEGATION_METADATA_TAG, DELEGATION_RECORD_TAG,
    };
    let dlp = pk(anchor_lang::prelude::Pubkey::new_from_array(
        ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID.to_bytes(),
    ));
    let mut accounts = vec![s(owner), r(&wd.config), r(&wd.market)];
    for acc in [
        pdas::user(owner),
        pdas::position(owner, &wd.market),
        pdas::dq(owner),
    ] {
        let buffer = Pubkey::find_program_address(&[DELEGATE_BUFFER_TAG, acc.as_ref()], &prog()).0;
        let record = Pubkey::find_program_address(&[DELEGATION_RECORD_TAG, acc.as_ref()], &dlp).0;
        let meta = Pubkey::find_program_address(&[DELEGATION_METADATA_TAG, acc.as_ref()], &dlp).0;
        accounts.extend([w(&buffer), w(&record), w(&meta), w(&acc)]);
    }
    accounts.extend([r(&prog()), r(&dlp), r(&SYSTEM)]);
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::DelegateUser {}.data(),
    }
}

/// `init_user_reuse_queue`: re-onboarding after an exit — same account shape as
/// `init_user`, but every PDA already exists (undelegation hands them back
/// scrubbed, it does not close them).
pub fn init_user_reuse_queue(owner: &Pubkey, wd: &World, exit_salt: [u8; 32]) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(owner),
            s(owner), // payer: owner self-pays in tests, as in `init_user`
            r(&wd.config),
            r(&wd.market),
            w(&pdas::user(owner)),
            w(&pdas::position(owner, &wd.market)),
            w(&pdas::dq(owner)),
            r(&SYSTEM),
        ],
        data: ix::InitUserReuseQueue { exit_salt }.data(),
    }
}
