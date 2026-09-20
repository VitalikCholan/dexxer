pub mod ixs;
pub mod pdas;
pub mod setup;
pub mod token_ix;

use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const SO_PATH: &str = "../../target/deploy/dexxer_core.so";

pub fn pk(p: anchor_lang::prelude::Pubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}
pub fn apk(p: Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(p.to_bytes())
}

pub struct Harness {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub program_id: Pubkey,
}

impl Harness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program_id = pk(dexxer_core::ID);
        svm.add_program_from_file(program_id, SO_PATH)
            .expect("run `anchor build` first: target/deploy/dexxer_core.so");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        Self {
            svm,
            payer,
            program_id,
        }
    }

    pub fn fund(&mut self, who: &Pubkey, lamports: u64) {
        self.svm.airdrop(who, lamports).unwrap();
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &bh);
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend(signers.iter().filter(|k| k.pubkey() != self.payer.pubkey()));
        let tx = Transaction::new(&all, msg, bh);
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn account<T: anchor_lang::AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.svm.get_account(key).expect("account missing");
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
    }

    pub fn warp(&mut self, slot: u64, unix_ts: i64) {
        self.svm.warp_to_slot(slot);
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix_ts;
        self.svm.set_sysvar(&c);
    }
}

/// Assert a failed tx carries the given Anchor custom error code (6000 + index).
pub fn assert_custom_error(r: &Result<TransactionMetadata, FailedTransactionMetadata>, code: u32) {
    let e = r.as_ref().err().expect("expected failure").err.to_string();
    assert!(
        e.contains(&format!("custom program error: {:#x}", code))
            || e.contains(&format!("Custom({})", code)),
        "expected custom error {code}, got: {e}"
    );
}

/// Extract the custom program error code (e.g. `6006`) from a failed tx's
/// error `Display`, or `None` if it failed some other way (or didn't fail).
/// Mirrors `assert_custom_error`'s two observed formats instead of matching
/// on `TransactionError`/`InstructionError` directly, since those solana-*
/// crates are only transitive dependencies here (pulled in via `litesvm`),
/// not declared ones.
pub fn custom_error_code(
    r: &Result<TransactionMetadata, FailedTransactionMetadata>,
) -> Option<u32> {
    let e = r.as_ref().err()?.err.to_string();
    if let Some(start) = e.find("Custom(") {
        let rest = &e[start + "Custom(".len()..];
        let end = rest.find(')')?;
        if let Ok(code) = rest[..end].parse::<u32>() {
            return Some(code);
        }
    }
    if let Some(pos) = e.find("custom program error: ") {
        let hex = e[pos + "custom program error: ".len()..].trim_start_matches("0x");
        let hex: String = hex.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if let Ok(code) = u32::from_str_radix(&hex, 16) {
            return Some(code);
        }
    }
    None
}

/// protocol_liquidity + Σ free + Σ pos.margin + fees + insurance == capital_total == vault balance.
/// Shared across Task 7 (trade), 8 (liquidation) and 9/10 (decrease/crank) tests.
pub fn assert_invariant(h: &Harness, w: &setup::World, traders: &[&setup::Trader]) {
    assert_invariant_ctx(h, w, traders, "");
}

/// Same as `assert_invariant`, but every assertion message is prefixed with `ctx`
/// (e.g. `"step {step}: "`) so a randomized-sequence failure names the failing step.
pub fn assert_invariant_ctx(h: &Harness, w: &setup::World, traders: &[&setup::Trader], ctx: &str) {
    let pool: dexxer_core::state::Pool = h.account(&w.pool);
    let mut sum = pool.protocol_liquidity + pool.fees_accrued + pool.insurance;
    let mut locked_sum: u64 = 0;
    for t in traders {
        let u: dexxer_core::state::UserAccount = h.account(&t.user);
        let p: dexxer_core::state::Position = h.account(&t.position);
        let open_margin = if p.state == dexxer_core::state::PositionState::Open {
            p.margin
        } else {
            0
        };
        sum += u.free_margin + open_margin;
        locked_sum += open_margin;
        assert_eq!(
            u.locked_margin, open_margin,
            "{ctx}user.locked_margin != position.margin for {}",
            t.user
        );
    }
    assert_eq!(sum, pool.capital_total, "{ctx}sum != capital_total");
    assert_eq!(
        pool.capital_total,
        token_ix::token_balance(&h.svm, &w.pool_ata),
        "{ctx}capital_total != vault balance"
    );
    assert_eq!(
        pool.locked_total, locked_sum,
        "{ctx}pool.locked_total != Σ position.margin over Open positions"
    );
}
