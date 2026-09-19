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
