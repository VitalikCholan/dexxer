use crate::{
    apk, pdas, pk,
    setup::World,
    token_ix::{ata, ATA_PROGRAM, SYSTEM, TOKEN},
};
use anchor_lang::InstructionData;
use dexxer_core::{instruction as ix, state::MarketParams};
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

pub fn init_config(
    admin: &Pubkey,
    mint: &Pubkey,
    crank: &Pubkey,
    oracle_program: &Pubkey,
    tee_validator: &Pubkey,
    delay: u64,
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
            r(&solana_pubkey::pubkey!(
                "SysvarRent111111111111111111111111111111111"
            )),
        ],
        data: ix::InitConfig {
            crank: apk(*crank),
            oracle_program: apk(*oracle_program),
            tee_validator: apk(*tee_validator),
            disclosure_delay_slots: delay,
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
pub fn set_params(
    admin: &Pubkey,
    config: &Pubkey,
    market: &Pubkey,
    params: MarketParams,
) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![s(admin), r(config), w(market)],
        data: ix::SetParams { params }.data(),
    }
}
pub fn pause(admin: &Pubkey, config: &Pubkey) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![s(admin), w(config)],
        data: ix::Pause {}.data(),
    }
}
pub fn unpause(admin: &Pubkey, config: &Pubkey) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![s(admin), w(config)],
        data: ix::Unpause {}.data(),
    }
}
pub fn seed_pool(admin: &Pubkey, wd: &World, amount: u64) -> Instruction {
    Instruction {
        program_id: prog(),
        accounts: vec![
            s(admin),
            r(&wd.config),
            w(&wd.pool),
            w(&ata(admin, &wd.mint)),
            w(&wd.pool_ata),
            r(&TOKEN),
        ],
        data: ix::SeedPool { amount }.data(),
    }
}
