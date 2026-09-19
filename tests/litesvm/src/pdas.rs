use crate::pk;
use dexxer_core::state::*;
use solana_pubkey::Pubkey;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pk(dexxer_core::ID)).0
}
pub fn config() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn mint_auth() -> Pubkey {
    pda(&[MINT_AUTH_SEED])
}
pub fn market() -> Pubkey {
    pda(&[MARKET_SEED, &SOL_SYMBOL])
}
pub fn risk(market: &Pubkey) -> Pubkey {
    pda(&[RISK_SEED, market.as_ref()])
}
pub fn pool(mint: &Pubkey) -> Pubkey {
    pda(&[POOL_SEED, mint.as_ref()])
}
pub fn user(owner: &Pubkey) -> Pubkey {
    pda(&[USER_SEED, owner.as_ref()])
}
pub fn position(owner: &Pubkey, market: &Pubkey) -> Pubkey {
    pda(&[POSITION_SEED, owner.as_ref(), market.as_ref()])
}
pub fn dq(owner: &Pubkey) -> Pubkey {
    pda(&[DQ_SEED, owner.as_ref()])
}
pub fn faucet(owner: &Pubkey) -> Pubkey {
    pda(&[FAUCET_SEED, owner.as_ref()])
}
pub fn feed(oracle_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"price_feed", b"pyth-lazer", b"6"], oracle_program).0
}
