use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, assert_invariant, ixs, setup::World, Harness};
use solana_keypair::Keypair;
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SOL1: u64 = 1_000_000_000;
const SOL10: u64 = 10_000_000_000;
const M30: u64 = 30_000_000;
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

/// Renamed in week-5 Task 3, fix round 1: the gate is `liq_hysteresis_ticks`,
/// whose default went 2 -> 3 once `crank_tick` and the scheduled
/// `liquidation_check` started sharing one `liq_ticks` counter. The test reads
/// the parameter instead of hardcoding the number.
#[test]
fn liquidation_after_hysteresis_ticks_below_mmr() {
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
    let hyst = MarketParams::sol_perp_defaults().liq_hysteresis_ticks;
    for expected in 1..hyst {
        h.send(
            &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
            &[&w.crank],
        )
        .unwrap();
        let pos: Position = h.account(&t.position);
        assert_eq!(pos.state, PositionState::Open);
        assert_eq!(pos.liq_ticks, expected);
    }
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    // Week-5 Task 1: a liquidation is a close, so the record lands in the
    // owner's `DisclosureQueue` and the position is freed in the same tick.
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Empty);
    assert!(pos.closed.is_none());
    let dq: DisclosureQueue = h.account(&t.dq);
    assert_eq!(dq.len, 1);
    let rec = dq.records[0];
    assert_eq!(rec.reason, CloseReason::Liquidated);
    assert_eq!(rec.exit, 142_000_000);
    // pnl = 10 * (142 - 150) = -80 $; liq fee 1 % of 1420 $ = 14.2 $; to_user = 150 - 80 - 14.2 = 55.8 $
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.free_margin, 1_000_000_000 - M150 - 900_000 + 55_800_000);
    assert_eq!(u.locked_margin, 0);
    let pool: PoolLive = h.account(&w.pool_live);
    assert_eq!(pool.insurance, 14_200_000);
    assert_eq!(pool.locked_total, 0);
    assert_invariant(&h, &w, &[&t]);
}

/// Fix round 1, finding 2: a candidate whose `DisclosureQueue` is full cannot
/// be liquidated (the record is the only copy of the closed trade and must not
/// be dropped), but it must not take the rest of the batch down with it either
/// — otherwise filling one's own ring with eight open/close pairs would be a
/// market-wide liquidation DoS. The full-ring candidate is skipped, stays
/// `Open` with its `liq_ticks` still accruing, and every other candidate in the
/// same tick liquidates normally.
#[test]
fn crank_tick_skips_candidate_with_full_queue() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);

    // A fills its ring: DQ_CAPACITY small open/close pairs, nothing draining it
    // (the default disclosure delay keeps every record un-due, and no
    // commit_aggregate runs in this test).
    let a = w.new_trader(&mut h, 10_000_000_000);
    for _ in 0..DQ_CAPACITY {
        h.send(
            &[ixs::open_position(
                &a.kp.pubkey(),
                &a,
                &w,
                Side::Long,
                SOL1,
                M30,
                P150,
            )],
            &[&a.kp],
        )
        .unwrap();
        h.send(&[ixs::close_position(&a.kp.pubkey(), &a, &w, 0)], &[&a.kp])
            .unwrap();
    }
    assert_eq!(
        h.account::<DisclosureQueue>(&a.dq).len as usize,
        DQ_CAPACITY,
        "A's ring is full"
    );

    // Now A opens the position that will go underwater, and B opens the same
    // one with an empty ring.
    h.send(
        &[ixs::open_position(
            &a.kp.pubkey(),
            &a,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&a.kp],
    )
    .unwrap();
    let b = open_long(&mut h, &w);

    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    w.set_price(&mut h, 142_000_000, 5, NOW, 101); // both below MMR (liq price 142.5)
    let hyst = MarketParams::sol_perp_defaults().liq_hysteresis_ticks;
    for _ in 0..hyst {
        h.send(
            &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&a, &b])],
            &[&w.crank],
        )
        .unwrap(); // the whole batch must survive A's full ring
    }

    let pos_a: Position = h.account(&a.position);
    assert_eq!(
        pos_a.state,
        PositionState::Open,
        "A is skipped, not liquidated — its ring has no room for the record"
    );
    assert_eq!(
        pos_a.liq_ticks, hyst,
        "and it keeps accruing ticks, so it liquidates on the first tick after a reveal drains the ring"
    );
    assert_eq!(
        h.account::<DisclosureQueue>(&a.dq).len as usize,
        DQ_CAPACITY,
        "A's ring is untouched"
    );

    let pos_b: Position = h.account(&b.position);
    assert_eq!(
        pos_b.state,
        PositionState::Empty,
        "B liquidated in the same batch"
    );
    let dq_b: DisclosureQueue = h.account(&b.dq);
    assert_eq!(dq_b.len, 1);
    assert_eq!(dq_b.records[0].reason, CloseReason::Liquidated);
    assert_invariant(&h, &w, &[&a, &b]);
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
    for _ in 0..MarketParams::sol_perp_defaults().liq_hysteresis_ticks {
        h.send(
            &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
            &[&w.crank],
        )
        .unwrap();
    }
    let pool: PoolLive = h.account(&w.pool_live);
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
    // The explicit limit is not optional: this measures the cheap path (16
    // candidates, none liquidatable) at ~166k CU, which does fit the 200k
    // default — but the same tick with all 16 actually liquidating measured
    // 367k (fix round 1, finding 4), so any client that fills a batch has to
    // raise the limit. `services/relayer/src/crank.ts` does the same.
    let meta = h
        .send(
            &[
                ixs::set_compute_unit_limit(1_400_000),
                ixs::crank_tick(&w.crank.pubkey(), &w, &refs),
            ],
            &[&w.crank],
        )
        .unwrap();
    println!(
        "sixteen_candidates_fit_in_cu_budget: compute_units_consumed = {}",
        meta.compute_units_consumed
    );
    // Measured 165_623 after fix round 1 moved the per-candidate
    // `DisclosureQueue` PDA derivation and decode onto the liquidation path
    // only (finding 4) — down from 205_391. Bound kept just above that, so a
    // regression in the non-liquidating path is caught rather than absorbed.
    assert!(
        meta.compute_units_consumed <= 250_000,
        "CU budget exceeded: {}",
        meta.compute_units_consumed
    );
}

#[test]
fn invalid_candidate_triple_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let a = open_long(&mut h, &w);
    let b = w.new_trader(&mut h, 0);
    let mut ix = ixs::crank_tick(&w.crank.pubkey(), &w, &[&a]);
    // Position and queue of A with the user account of B (the middle slot of
    // the triple, which `crank_tick` derives both other addresses from).
    let user_slot = ix.accounts.len() - 2;
    ix.accounts[user_slot].pubkey = b.user;
    let r = h.send(&[ix], &[&w.crank]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
}

#[test]
fn duplicate_candidate_triple_rejected() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = open_long(&mut h, &w);
    // Same [Position, UserAccount, DisclosureQueue] triple passed twice in one
    // crank_tick must not be allowed to drive liq_ticks 0 -> 2 in a single
    // transaction.
    let r = h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t, &t])],
        &[&w.crank],
    );
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
}
