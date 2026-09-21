use crate::{
    apk, pdas, pk,
    setup::{Trader, World},
    token_ix::{ata, ATA_PROGRAM, RENT, SYSTEM, TOKEN},
};
use anchor_lang::InstructionData;
use dexxer_core::{
    instruction as ix,
    state::{DisclosureArgs, MarketParams, Side},
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
pub fn crank_tick(crank: &Pubkey, wd: &World, candidates: &[&Trader]) -> Instruction {
    // `crank: Signer<'info>` in `CrankTick` carries no `#[account(mut)]`, so the
    // client-side meta must be a readonly signer, not writable (`s`).
    let mut accounts = vec![
        rs(crank),
        r(&wd.config),
        w(&wd.market),
        w(&wd.risk),
        w(&wd.pool),
        r(&wd.feed),
    ];
    for t in candidates {
        accounts.push(w(&t.position));
        accounts.push(w(&t.user));
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
            w(&wd.pool),
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
            w(&wd.pool),
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
        accounts: vec![
            w(&pdas::commitment(nonce)),
            r(&wd.config),
            r(&SYSTEM),
            r(&prog()),
            rs(caller),
            w(&pdas::action_escrow(caller)),
        ],
        data: ix::WriteCommitment { nonce, hash }.data(),
    }
}
/// Direct call to `write_disclosure` — same attack shape as `write_commitment_direct`.
pub fn write_disclosure_direct(
    caller: &Pubkey,
    wd: &World,
    args: DisclosureArgs,
    salt: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            w(&pdas::disclosure(args.nonce)),
            r(&pdas::commitment(args.nonce)),
            r(&wd.config),
            r(&SYSTEM),
            r(&prog()),
            rs(caller),
            w(&pdas::action_escrow(caller)),
        ],
        data: ix::WriteDisclosure { args, salt }.data(),
    }
}
