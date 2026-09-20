use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::{pubkey, Pubkey};

pub const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Pubkey = pubkey!("11111111111111111111111111111111");
pub const RENT: Pubkey = pubkey!("SysvarRent111111111111111111111111111111111");
pub const MINT_LEN: u64 = 82;

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

/// create account (system) + InitializeMint2 (tag 20).
pub fn create_mint(
    payer: &Pubkey,
    mint: &Pubkey,
    authority: &Pubkey,
    decimals: u8,
    rent_lamports: u64,
) -> [Instruction; 2] {
    let create = solana_system_interface::instruction::create_account(
        payer,
        mint,
        rent_lamports,
        MINT_LEN,
        &TOKEN,
    );
    let mut data = vec![20u8, decimals];
    data.extend_from_slice(authority.as_ref());
    data.push(0); // no freeze authority
    let init = Instruction {
        program_id: TOKEN,
        accounts: vec![AccountMeta::new(*mint, false)],
        data,
    };
    [create, init]
}

/// ATA CreateIdempotent (tag 1).
pub fn create_ata(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        data: vec![1],
    }
}

/// MintTo (tag 7).
pub fn mint_to(mint: &Pubkey, dest: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

pub fn token_balance(svm: &litesvm::LiteSVM, acc: &Pubkey) -> u64 {
    let a = svm.get_account(acc).expect("token account");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
