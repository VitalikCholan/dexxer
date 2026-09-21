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
pub fn fee_escrow() -> Pubkey {
    pda(&[FEE_ESCROW_SEED])
}
pub fn commitment(nonce: u64) -> Pubkey {
    pda(&[COMMIT_SEED, &nonce.to_le_bytes()])
}
pub fn disclosure(nonce: u64) -> Pubkey {
    pda(&[DISCLOSURE_SEED, &nonce.to_le_bytes()])
}
pub fn feed(oracle_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"price_feed", b"pyth-lazer", b"6"], oracle_program).0
}

/// `ephemeral_rollups_sdk::compat::Pubkey` -> `solana_pubkey::Pubkey` (this
/// crate's `Pubkey`, a different version), by bytes.
fn compat_pk(p: ephemeral_rollups_sdk::compat::Pubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}
pub fn permission_program() -> Pubkey {
    compat_pk(ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID)
}
pub fn ephemeral_vault() -> Pubkey {
    compat_pk(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID)
}
pub fn magic_program() -> Pubkey {
    compat_pk(ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)
}
pub fn magic_context() -> Pubkey {
    compat_pk(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID)
}
/// The ER `EphemeralPermission` PDA for `account`, under the permission program.
pub fn permission(account: &Pubkey) -> Pubkey {
    let compat_account = ephemeral_rollups_sdk::compat::Pubkey::new_from_array(account.to_bytes());
    let (pda, _) = ephemeral_rollups_sdk::access_control::structs::EphemeralPermission::find_pda(
        &compat_account,
    );
    compat_pk(pda)
}
/// The Magic Program's action escrow balance PDA for `escrow_auth`, index `ACTION_ESCROW_INDEX`
/// (spikes/06-magic-action, `#[action]`-gated instructions).
pub fn action_escrow(escrow_auth: &Pubkey) -> Pubkey {
    let compat_auth = ephemeral_rollups_sdk::compat::Pubkey::new_from_array(escrow_auth.to_bytes());
    let pda = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(
        &compat_auth,
        ACTION_ESCROW_INDEX,
    );
    compat_pk(pda)
}
