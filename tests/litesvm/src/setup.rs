use crate::{ixs, pdas, token_ix::*, Harness};
use dexxer_core::state::MarketParams;
use solana_account::Account;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

pub const SEED_AMOUNT: u64 = 100_000_000_000; // 100,000 dUSDC

/// `"BTC"` → `b"BTC\0\0\0\0\0"`, the on-chain market symbol / PDA seed.
pub fn sym(s: &str) -> [u8; 8] {
    let mut b = [0u8; 8];
    b[..s.len()].copy_from_slice(s.as_bytes());
    b
}

/// One market's accounts — everything a market-scoped instruction needs.
#[derive(Clone, Copy)]
pub struct Mkt {
    pub symbol: [u8; 8],
    pub market: Pubkey,
    pub risk: Pubkey,
    pub feed: Pubkey,
}

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
    pub pool_live: Pubkey,
    pub feed: Pubkey,
    pub fee_escrow: Pubkey,
    pub balances_root: Pubkey,
    pub magic_fee_vault: Pubkey,
    /// Signs `commit_aggregate`'s `payer: Signer` (must equal `Config.fee_payer`).
    /// Same key as `admin` (bootstrap's `init_config` sets `fee_payer = admin.pubkey()`,
    /// no real scheduler on LiteSVM) — kept as its own field/keypair so callers don't
    /// need to know that reuse detail (`Keypair::insecure_clone`, not a move: `admin`
    /// is still a separate field below).
    pub fee_payer: Keypair,
}

impl World {
    pub fn bootstrap(h: &mut Harness) -> World {
        Self::bootstrap_inner(h, true)
    }

    /// Same as `bootstrap`, but stops short of `init_pool_live` (and, since
    /// `seed_pool` now requires `pool_live` to exist — controller ruling,
    /// week-4 Task 1 fix round 1 — also short of `seed_pool`) — used by the
    /// admin-only negative test, which needs the `PoolLive` PDA to not yet
    /// exist so the `has_one = admin` check (not "account already in use")
    /// is what fires.
    pub fn bootstrap_without_pool_live(h: &mut Harness) -> World {
        Self::bootstrap_inner(h, false)
    }

    fn bootstrap_inner(h: &mut Harness, with_pool_live: bool) -> World {
        let admin = Keypair::new();
        let crank = Keypair::new();
        let mint_kp = Keypair::new();
        let oracle_program = Pubkey::new_unique(); // fake owner for the feed account (Task 7 writes bytes with set_account)
        h.fund(&admin.pubkey(), 50_000_000_000);
        h.fund(&crank.pubkey(), 5_000_000_000);
        let mint = mint_kp.pubkey();
        // A fresh, non-existent-on-ledger pubkey, not `Pubkey::default()` (== the
        // System Program's own address — LiteSVM/the SBF runtime rejects marking
        // an executable program account `mut`, which `Withdraw`/`CommitAggregate`
        // both do for `magic_fee_vault`; discovered when `Withdraw` started
        // requiring it — see instructions/user.rs's fix-round-1 comment).
        let magic_fee_vault = Pubkey::new_unique();
        h.send(
            &[ixs::init_config(
                &admin.pubkey(),
                &mint,
                &crank.pubkey(),
                &oracle_program,
                &Pubkey::new_unique(),
                &crank.pubkey(), // scheduler_signer: fixed test crank, no real scheduler on LiteSVM
                &admin.pubkey(), // fee_payer: reuse admin locally, no real scheduler on LiteSVM
                &magic_fee_vault,
            )],
            &[&admin, &mint_kp],
        )
        .unwrap();
        h.send(
            &[ixs::init_market(
                &admin.pubkey(),
                dexxer_core::state::SOL_SYMBOL,
                MarketParams::sol_perp_defaults(),
                "6",
            )],
            &[&admin],
        )
        .unwrap();
        h.send(&[ixs::init_pool(&admin.pubkey(), &mint)], &[&admin])
            .unwrap();
        // Controller ruling (week-4 Task 1 fix round 1): init_pool_live right
        // after init_pool (copies zeros) — seed_pool later needs the PDA to
        // already exist, since it now writes both Pool and PoolLive.
        if with_pool_live {
            h.send(&[ixs::init_pool_live(&admin.pubkey(), &mint)], &[&admin])
                .unwrap();
        }
        h.send(&[ixs::init_fee_escrow(&admin.pubkey())], &[&admin])
            .unwrap();
        h.send(&[ixs::init_balances_root(&admin.pubkey())], &[&admin])
            .unwrap();
        let market = pdas::market();
        let pool = pdas::pool(&mint);
        let w = World {
            config: pdas::config(),
            risk: pdas::risk(&market),
            market,
            pool,
            pool_ata: ata(&pool, &mint),
            pool_live: pdas::pool_live(&mint),
            feed: pdas::feed(&oracle_program),
            fee_escrow: pdas::fee_escrow(),
            balances_root: pdas::balances_root(),
            magic_fee_vault,
            fee_payer: admin.insecure_clone(),
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
        // seed_pool now writes both Pool and PoolLive (controller ruling), so it
        // requires PoolLive to already exist — gated on the same flag as
        // init_pool_live above (bootstrap_without_pool_live skips both).
        if with_pool_live {
            h.send(
                &[ixs::seed_pool(&w.admin.pubkey(), &w, SEED_AMOUNT)],
                &[&w.admin],
            )
            .unwrap();
        }
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
        h.send(&[ixs::init_user(&o, self, [0x5a; 32])], &[&kp])
            .unwrap();
        let t = Trader {
            user: pdas::user(&o),
            positions: pdas::positions(&o),
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
    pub positions: Pubkey,
    pub ata: Pubkey,
}

impl World {
    pub fn sol(&self) -> Mkt {
        Mkt {
            symbol: dexxer_core::state::SOL_SYMBOL,
            market: self.market,
            risk: self.risk,
            feed: self.feed,
        }
    }

    /// `init_market` for another symbol under the same admin/oracle (LiteSVM:
    /// no delegation, so the market is usable straight away).
    pub fn add_market(
        &self,
        h: &mut Harness,
        symbol: &str,
        lazer_feed_id: &str,
        params: MarketParams,
    ) -> Mkt {
        let s = sym(symbol);
        h.send(
            &[ixs::init_market(
                &self.admin.pubkey(),
                s,
                params,
                lazer_feed_id,
            )],
            &[&self.admin],
        )
        .unwrap();
        let market = pdas::market_for(&s);
        Mkt {
            symbol: s,
            market,
            risk: pdas::risk(&market),
            feed: pdas::feed_for(&self.oracle_program, lazer_feed_id),
        }
    }

    pub fn set_price(
        &self,
        h: &mut Harness,
        price_1e6: u64,
        conf_bps: u32,
        publish_time: i64,
        posted_slot: u64,
    ) {
        self.set_price_on(
            h,
            &self.sol(),
            price_1e6,
            conf_bps,
            publish_time,
            posted_slot,
        );
    }

    /// Writes a 134-byte PriceUpdateV2 feed owned by `oracle_program` (layout from spikes/04, exponent +8).
    pub fn set_price_on(
        &self,
        h: &mut Harness,
        m: &Mkt,
        price_1e6: u64,
        conf_bps: u32,
        publish_time: i64,
        posted_slot: u64,
    ) {
        let price: i64 = (price_1e6 as i128 * 100) as i64; // 1e6 -> 1e8 (expo +8)
        let conf: u64 = ((price as u128 * conf_bps as u128) / 10_000) as u64;
        let mut d = vec![234u8, 161, 14, 36, 172, 239, 15, 232];
        d.extend_from_slice(&[0u8; 32]);
        d.push(1);
        d.extend_from_slice(&[0xc6u8; 32]);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&8i32.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&posted_slot.to_le_bytes());
        d.push(0);
        h.svm
            .set_account(
                m.feed,
                Account {
                    lamports: 10_000_000,
                    data: d,
                    owner: self.oracle_program,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
}

impl Trader {
    pub fn trade_accounts(&self, w: &World, signer: &Pubkey) -> Vec<AccountMeta> {
        self.trade_accounts_on(w, &w.sol(), signer)
    }

    pub fn trade_accounts_on(&self, w: &World, m: &Mkt, signer: &Pubkey) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(*signer, true), // Trade.signer is not `mut`
            AccountMeta::new_readonly(w.config, false),
            AccountMeta::new(m.market, false),
            AccountMeta::new(m.risk, false),
            AccountMeta::new(w.pool_live, false),
            AccountMeta::new(self.user, false),
            AccountMeta::new(self.positions, false),
            AccountMeta::new_readonly(m.feed, false),
            AccountMeta::new(w.fee_escrow, false),
            // `task_context` is pinned to the `Positions` PDA by the program
            // (week-5 Task 3 fix round 1): it always exists and is already
            // writable in this very instruction. No Magic program is deployed
            // on LiteSVM, so nothing ever reads it here.
            AccountMeta::new(self.positions, false),
            AccountMeta::new_readonly(pdas::magic_program(), false),
            // `liq_crank_signer` (week-5 Task 3): the signer a scheduled
            // `liquidation_check` tick carries. Only checked on the scheduling
            // path, which is gated out here (no Magic program on LiteSVM), but
            // passed correctly anyway so the derivation stays exercised.
            AccountMeta::new_readonly(pdas::liq_crank_signer(), false),
        ]
    }
}
