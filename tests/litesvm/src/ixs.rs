use crate::{
    apk, pdas, pk,
    setup::{Mkt, Trader, World},
    token_ix::{ata, ATA_PROGRAM, RENT, SYSTEM, TOKEN},
};
use anchor_lang::InstructionData;
use dexxer_core::{
    instruction as ix,
    state::{MarketParams, Side},
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
            scheduler_signer: apk(*scheduler_signer),
            fee_payer: apk(*fee_payer),
            magic_fee_vault: apk(*magic_fee_vault),
        }
        .data(),
    }
}
pub fn init_market(
    admin: &Pubkey,
    symbol: [u8; 8],
    params: MarketParams,
    lazer_feed_id: &str,
) -> Instruction {
    let m = pdas::market_for(&symbol);
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
            symbol,
            params,
            lazer_feed_id: lazer_feed_id.to_string(),
        }
        .data(),
    }
}

pub fn dlp() -> Pubkey {
    pk(anchor_lang::prelude::Pubkey::new_from_array(
        ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID.to_bytes(),
    ))
}

/// The `[buffer, delegation_record, delegation_metadata, account]` quadruple the
/// `#[delegate]` macro expands each `del` field into (see `delegate_user`).
pub fn delegation_quad(acc: &Pubkey) -> [AccountMeta; 4] {
    use ephemeral_rollups_sdk::pda::{
        DELEGATE_BUFFER_TAG, DELEGATION_METADATA_TAG, DELEGATION_RECORD_TAG,
    };
    let buffer = Pubkey::find_program_address(&[DELEGATE_BUFFER_TAG, acc.as_ref()], &prog()).0;
    let record = Pubkey::find_program_address(&[DELEGATION_RECORD_TAG, acc.as_ref()], &dlp()).0;
    let meta = Pubkey::find_program_address(&[DELEGATION_METADATA_TAG, acc.as_ref()], &dlp()).0;
    [w(&buffer), w(&record), w(&meta), w(acc)]
}

pub fn delegate_market(admin: &Pubkey, wd: &World, m: &Mkt) -> Instruction {
    let mut accounts = vec![s(admin), r(&wd.config)];
    accounts.extend(delegation_quad(&m.market));
    accounts.extend(delegation_quad(&m.risk));
    accounts.extend([r(&prog()), r(&dlp()), r(&SYSTEM)]);
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::DelegateMarket { symbol: m.symbol }.data(),
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
    init_user_paid(owner, owner, wd, exit_salt) // owner self-pays in tests
}
/// `init_user` with a separate `payer` (the relayer's sponsored onboarding).
pub fn init_user_paid(
    owner: &Pubkey,
    payer: &Pubkey,
    wd: &World,
    exit_salt: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(owner),
            s(payer), // payer (fix round 1, task 6 controller ruling)
            r(&wd.config),
            w(&pdas::user(owner)),
            w(&pdas::positions(owner)),
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
            w(&t.user),
            w(&t.positions),
            w(&pdas::permission(&t.user)),
            w(&pdas::permission(&t.positions)),
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
#[allow(clippy::too_many_arguments)]
pub fn open_position_on(
    signer: &Pubkey,
    t: &Trader,
    wd: &World,
    m: &Mkt,
    side: Side,
    size: u64,
    margin: u64,
    limit_price: u64,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts_on(wd, m, signer),
        data: ix::OpenPosition {
            side,
            size,
            margin,
            limit_price,
        }
        .data(),
    }
}
pub fn close_position_on(
    signer: &Pubkey,
    t: &Trader,
    wd: &World,
    m: &Mkt,
    limit_price: u64,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: t.trade_accounts_on(wd, m, signer),
        data: ix::ClosePosition { limit_price }.data(),
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
/// `candidates` become `remaining_accounts` pairs `[Positions, UserAccount]`.
pub fn crank_tick(crank: &Pubkey, wd: &World, candidates: &[&Trader]) -> Instruction {
    crank_tick_on(crank, wd, &wd.sol(), candidates)
}
pub fn crank_tick_on(crank: &Pubkey, wd: &World, m: &Mkt, candidates: &[&Trader]) -> Instruction {
    // `crank: Signer<'info>` in `CrankTick` carries no `#[account(mut)]`, so the
    // client-side meta must be a readonly signer, not writable (`s`).
    let mut accounts = vec![
        rs(crank),
        r(&wd.config),
        w(&m.market),
        w(&m.risk),
        w(&wd.pool_live),
        r(&m.feed),
    ];
    for t in candidates {
        accounts.push(w(&t.positions));
        accounts.push(w(&t.user));
    }
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::CrankTick {}.data(),
    }
}
/// `liquidation_check` (ER): the per-position scheduled task's instruction.
/// Fixed account list — the scheduler freezes it at registration time, so it
/// never carries `remaining_accounts` (week-5 Task 3).
pub fn liquidation_check(signer: &Pubkey, wd: &World, t: &Trader) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            rs(signer),
            r(&wd.config),
            r(&wd.market),
            w(&wd.risk),
            w(&wd.pool_live),
            r(&wd.feed),
            w(&t.positions),
            w(&t.user),
        ],
        data: ix::LiquidationCheck {}.data(),
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
/// `payer` must equal `Config.fee_payer` (`w.fee_payer` in tests).
pub fn commit_aggregate(payer: &Pubkey, wd: &World) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            r(&wd.config),
            rs(payer),
            w(&wd.pool),
            r(&wd.pool_live),
            w(&wd.balances_root),
            w(&wd.fee_escrow),
            w(&wd.magic_fee_vault),
            w(&pdas::magic_context()),
            r(&pdas::magic_program()),
        ],
        data: ix::CommitAggregate {}.data(),
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
/// `undelegate_user` (owner, ER): scrub -> close permission x2 -> commit_and_undelegate.
/// Same permission/vault/magic accounts as `set_session`, plus `fee_escrow`/
/// `magic_fee_vault`/`magic_context`/`magic_program` (as in `withdraw`).
/// `markets` go to `remaining_accounts`: the markets whose liquidation tasks
/// to cancel (read-only, used only for their key).
pub fn undelegate_user(signer: &Pubkey, t: &Trader, wd: &World, markets: &[Pubkey]) -> Instruction {
    let mut accounts = vec![
        s(signer),
        r(&wd.config),
        w(&t.user),
        w(&t.positions),
        w(&pdas::permission(&t.user)),
        w(&pdas::permission(&t.positions)),
        w(&pdas::ephemeral_vault()),
        r(&pdas::permission_program()),
        w(&wd.fee_escrow),
        w(&wd.magic_fee_vault),
        w(&pdas::magic_context()),
        r(&pdas::magic_program()),
    ];
    accounts.extend(markets.iter().map(r));
    Instruction {
        program_id: prog(),
        accounts,
        data: ix::UndelegateUser {}.data(),
    }
}

/// `ComputeBudgetProgram::SetComputeUnitLimit` (discriminant `2`, u32 LE units),
/// hand-built so the test crate needs no extra dependency. A full `crank_tick`
/// batch may not fit in the 200k default when many candidates liquidate at
/// once, so any client that fills the batch raises the limit —
/// `services/relayer/src/crank.ts` does the same.
pub fn set_compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

/// `close_exited_user` (base layer, `Config.fee_payer` or the owner): rent
/// reclaim on both of an exited owner's undelegated PDAs, sent to
/// `rent_payer` (must equal `UserAccount.rent_payer`, risk #39).
pub fn close_exited_user(
    closer: &Pubkey,
    t: &Trader,
    wd: &World,
    rent_payer: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(closer),
            r(&wd.config),
            w(rent_payer),
            w(&t.user),
            w(&t.positions),
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
pub fn delegate_user(owner: &Pubkey, payer: &Pubkey, wd: &World) -> Instruction {
    use ephemeral_rollups_sdk::pda::{
        DELEGATE_BUFFER_TAG, DELEGATION_METADATA_TAG, DELEGATION_RECORD_TAG,
    };
    let dlp = pk(anchor_lang::prelude::Pubkey::new_from_array(
        ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID.to_bytes(),
    ));
    // Week-5 Task 3 (P1): `payer` sits immediately after `owner` and funds the
    // delegation records; `owner` still signs for its own PDAs.
    let mut accounts = vec![s(owner), s(payer), r(&wd.config)];
    for acc in [pdas::user(owner), pdas::positions(owner)] {
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
