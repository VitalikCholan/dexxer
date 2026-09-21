use anchor_lang::prelude::*;

// Week-2 Task 5 fix round 1 (controller ruling): a dedicated, program-owned,
// delegatable PDA that pays the CPI fee for `commit_aggregate`'s fee-vault
// path. Deliberately separate from `Pool` — state-account rent stays apart
// from the fee budget the escrow carries in the ER, so committing `Pool`
// never risks touching its own rent-exempt minimum (the exact failure mode
// M3b diagnosed on the private-counter spike when a state account doubled as
// fee payer). Zero-data beyond the minimal bookkeeping below: the escrow
// exists purely to be delegated and hold lamports the ER can debit.
#[account]
#[derive(InitSpace)]
pub struct FeeEscrow {
    pub version: u8,
    pub bump: u8,
}
