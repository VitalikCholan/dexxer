use crate::{ixs, pdas, token_ix::*, Harness};
use dexxer_core::state::MarketParams;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

pub const SEED_AMOUNT: u64 = 100_000_000_000; // 100,000 dUSDC

pub struct World {
    pub admin: Keypair,
    pub crank: Keypair,
    pub mint: Pubkey,
    pub oracle_program: Pubkey,
    pub config: Pubkey,
    pub market: Pubkey,
    pub risk: Pubkey,
    pub pool: Pubkey,
    pub pool_ata: Pubkey,
    pub feed: Pubkey,
}

impl World {
    pub fn bootstrap(h: &mut Harness) -> World {
        let admin = Keypair::new();
        let crank = Keypair::new();
        let mint_kp = Keypair::new();
        let oracle_program = Pubkey::new_unique(); // fake owner for the feed account (Task 7 writes bytes with set_account)
        h.fund(&admin.pubkey(), 50_000_000_000);
        h.fund(&crank.pubkey(), 5_000_000_000);
        let mint = mint_kp.pubkey();
        h.send(
            &[ixs::init_config(
                &admin.pubkey(),
                &mint,
                &crank.pubkey(),
                &oracle_program,
                &Pubkey::new_unique(),
                100,
            )],
            &[&admin, &mint_kp],
        )
        .unwrap();
        h.send(
            &[ixs::init_market(
                &admin.pubkey(),
                MarketParams::sol_perp_defaults(),
                "6",
            )],
            &[&admin],
        )
        .unwrap();
        h.send(&[ixs::init_pool(&admin.pubkey(), &mint)], &[&admin])
            .unwrap();
        let market = pdas::market();
        let pool = pdas::pool(&mint);
        // Task 6 adds faucet_mint (mint authority is a PDA) and switches bootstrap to seed
        // SEED_AMOUNT of dUSDC liquidity into the pool; this task leaves the pool unseeded.
        World {
            config: pdas::config(),
            risk: pdas::risk(&market),
            market,
            pool,
            pool_ata: ata(&pool, &mint),
            feed: pdas::feed(&oracle_program),
            admin,
            crank,
            mint,
            oracle_program,
        }
    }
}
