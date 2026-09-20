use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, assert_invariant, ixs, setup::World, Harness};
use solana_keypair::Keypair;
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
// Task 7's tests settled on NOW = 2_000_000 as the clock base (bootstrap
// warps the clock past 1_000_000 on its own via the faucet-funding loop);
// mirror that here instead of the brief's literal 1_000_000, keeping every
// relative delta (e.g. `- 100` for staleness) intact.
const NOW: i64 = 2_000_000;

fn open_long(h: &mut Harness, w: &World) -> dexxer_litesvm::setup::Trader {
    let t = w.new_trader(h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    t
}

#[test]
fn only_crank_or_scheduler_pda_may_tick() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::crank_tick(&stranger.pubkey(), &w, &[])],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    assert_eq!(h.account::<Market>(&w.market).mark, P150);
}

#[test]
fn mark_follows_ema_and_deviation_pauses_opens() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    w.set_price(&mut h, 160_000_000, 5, NOW, 101); // +6.67 % > max_deviation 2 %
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let m: Market = h.account(&w.market);
    assert_eq!(m.mark, 153_000_000, "ema alpha 0.3: 150 + 0.3*10");
    assert!(m.paused_open);
    assert_eq!(m.stale_ticks, 0);
    let t = w.new_trader(&mut h, 1_000_000_000);
    let r = h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            u64::MAX,
        )],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::OpenPaused as u32);
    for _ in 0..12 {
        h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
            .unwrap();
    }
    assert!(
        !h.account::<Market>(&w.market).paused_open,
        "mark converged, opens resume"
    );
}

#[test]
fn stale_oracle_skips_liquidation_and_counts_ticks() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = open_long(&mut h, &w);
    w.set_price(&mut h, 100_000_000, 5, NOW - 100, 101); // deep under liq, but stale
    for _ in 0..3 {
        h.send(
            &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
            &[&w.crank],
        )
        .unwrap();
    }
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Open
    );
    assert_eq!(h.account::<Market>(&w.market).stale_ticks, 3);
}

#[test]
fn liquidation_after_two_ticks_below_mmr() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = open_long(&mut h, &w);
    // drive mark down: set a hard ema so the test is deterministic — alpha 10000 (mark = index)
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    w.set_price(&mut h, 142_000_000, 5, NOW, 101); // liq price 142.5 -> equity < MMR
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Open);
    assert_eq!(pos.liq_ticks, 1);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Closed);
    let rec = pos.closed.unwrap();
    assert_eq!(rec.reason, CloseReason::Liquidated);
    assert_eq!(rec.exit, 142_000_000);
    // pnl = 10 * (142 - 150) = -80 $; liq fee 1 % of 1420 $ = 14.2 $; to_user = 150 - 80 - 14.2 = 55.8 $
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.free_margin, 1_000_000_000 - M150 - 900_000 + 55_800_000);
    assert_eq!(u.locked_margin, 0);
    let pool: Pool = h.account(&w.pool);
    assert_eq!(pool.insurance, 14_200_000);
    assert_eq!(pool.locked_total, 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn hysteresis_resets_when_price_recovers() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = open_long(&mut h, &w);
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    w.set_price(&mut h, 142_000_000, 5, NOW, 101);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    w.set_price(&mut h, 150_000_000, 5, NOW, 102);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Open);
    assert_eq!(pos.liq_ticks, 0);
}

#[test]
fn bad_debt_is_counted_not_paid() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = open_long(&mut h, &w);
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    w.set_price(&mut h, 120_000_000, 5, NOW, 101); // pnl -300 $ > margin 150 $
    for _ in 0..2 {
        h.send(
            &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
            &[&w.crank],
        )
        .unwrap();
    }
    let pool: Pool = h.account(&w.pool);
    assert_eq!(pool.bad_debt_total, 150_000_000);
    assert_eq!(pool.insurance, 0);
    assert_eq!(
        h.account::<UserAccount>(&t.user).free_margin,
        1_000_000_000 - M150 - 900_000
    );
    assert_invariant(&h, &w, &[&t]);
}

/// Not one of the 7 required tests — measures whether `MAX_CANDIDATES` (16)
/// pairs fit inside the 1.4M CU per-transaction budget.
#[test]
fn sixteen_candidates_fit_in_cu_budget() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let traders: Vec<_> = (0..MAX_CANDIDATES).map(|_| open_long(&mut h, &w)).collect();
    let refs: Vec<&_> = traders.iter().collect();
    let meta = h
        .send(
            &[ixs::crank_tick(&w.crank.pubkey(), &w, &refs)],
            &[&w.crank],
        )
        .unwrap();
    println!(
        "sixteen_candidates_fit_in_cu_budget: compute_units_consumed = {}",
        meta.compute_units_consumed
    );
    assert!(
        meta.compute_units_consumed <= 1_400_000,
        "CU budget exceeded: {}",
        meta.compute_units_consumed
    );
}

#[test]
fn invalid_candidate_pair_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let a = open_long(&mut h, &w);
    let b = w.new_trader(&mut h, 0);
    let mut ix = ixs::crank_tick(&w.crank.pubkey(), &w, &[&a]);
    ix.accounts.last_mut().unwrap().pubkey = b.user; // position of A with user account of B
    let r = h.send(&[ix], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
}

#[test]
fn duplicate_candidate_pair_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = open_long(&mut h, &w);
    // Same [Position, UserAccount] pair passed twice in one crank_tick must
    // not be allowed to drive liq_ticks 0 -> 2 in a single transaction.
    let r = h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t, &t])],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
}
