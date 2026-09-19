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
        let w = World {
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
        };
        // Seed the pool with SEED_AMOUNT of dUSDC via the faucet, respecting its
        // FAUCET_DAILY_LIMIT (10,000 dUSDC/day): one faucet_init plus nine
        // faucet_mint calls, warping one day forward before each.
        h.send(
            &[create_ata(&w.admin.pubkey(), &w.admin.pubkey(), &w.mint)],
            &[&w.admin],
        )
        .unwrap();
        h.warp(1, 1_000_000);
        h.send(
            &[ixs::faucet_init(&w.admin.pubkey(), &w, 10_000_000_000)],
            &[&w.admin],
        )
        .unwrap();
        for i in 1..=9u64 {
            h.warp(1 + i * 1_000, 1_000_000 + (i as i64) * 86_401);
            h.send(
                &[ixs::faucet_mint(&w.admin.pubkey(), &w, 10_000_000_000)],
                &[&w.admin],
            )
            .unwrap();
        }
        h.send(
            &[ixs::seed_pool(&w.admin.pubkey(), &w, SEED_AMOUNT)],
            &[&w.admin],
        )
        .unwrap();
        w
    }

    pub fn new_trader(&self, h: &mut Harness, deposit: u64) -> Trader {
        let kp = Keypair::new();
        let o = kp.pubkey();
        h.fund(&o, 5_000_000_000);
        h.send(&[create_ata(&o, &o, &self.mint)], &[&kp]).unwrap();
        if deposit > 0 {
            h.send(&[ixs::faucet_init(&o, self, deposit)], &[&kp])
                .unwrap();
        }
        h.send(&[ixs::init_user(&o, self)], &[&kp]).unwrap();
        let t = Trader {
            user: pdas::user(&o),
            position: pdas::position(&o, &self.market),
            dq: pdas::dq(&o),
            ata: ata(&o, &self.mint),
            kp,
        };
        if deposit > 0 {
            h.send(&[ixs::credit_deposit(&o, &t, self, deposit)], &[&t.kp])
                .unwrap();
        }
        t
    }
}

pub struct Trader {
    pub kp: Keypair,
    pub user: Pubkey,
    pub position: Pubkey,
    pub dq: Pubkey,
    pub ata: Pubkey,
}
