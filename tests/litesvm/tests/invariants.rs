// Task 10: randomized sequences of trading operations, checking the pool
// invariant, the OI ledger and liquidation-price ordering after every step.
// Deterministic PRNG (seed 0xDEADBEEF) so a failure reproduces exactly.
use dexxer_core::{math, state::*};
use dexxer_litesvm::{
    assert_invariant_ctx, ixs,
    setup::{Trader, World},
    Harness,
};
use solana_signer::Signer;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn random_sequences_keep_pool_invariants() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    let mut rng = Lcg(0xDEADBEEF);
    let mut price: u64 = 150_000_000;
    // Task 7-9's tests settled on NOW = 2_000_000 as the clock base (bootstrap
    // warps the clock past 1_000_000 via the faucet-funding loop); start here
    // instead of the brief's literal 1_000_000, keeping every relative delta
    // (staleness windows etc.) intact.
    let mut ts: i64 = 2_000_000;
    let mut slot: u64 = 100;
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();
    h.warp(slot, ts);
    w.set_price(&mut h, price, 5, ts, slot);
    let mut traders: Vec<Trader> = (0..4)
        .map(|_| w.new_trader(&mut h, 2_000_000_000))
        .collect();
    // Tracks, per trader index, whether a Closed position has already triggered
    // a replacement trader — a position cannot reopen after closing in week 1
    // (mark_committed is week 3), so any trader that becomes Closed (via a
    // user close/decrease-to-zero OR a crank liquidation) is replaced exactly once.
    let mut replaced: Vec<bool> = vec![false; traders.len()];

    // Per-kind success/attempt counters for the final report.
    let mut opened_ok = 0u32;
    let mut opened_attempt = 0u32;
    let mut add_margin_ok = 0u32;
    let mut add_margin_attempt = 0u32;
    let mut increase_ok = 0u32;
    let mut increase_attempt = 0u32;
    let mut decrease_ok = 0u32;
    let mut decrease_attempt = 0u32;
    let mut close_ok = 0u32;
    let mut close_attempt = 0u32;
    let mut crank_ok = 0u32;
    let mut liquidated = 0u32;

    for step in 0..300u32 {
        slot += 1;
        ts += 1;
        h.warp(slot, ts);
        let i = rng.below(traders.len() as u64) as usize;
        let side = if rng.below(2) == 0 {
            Side::Long
        } else {
            Side::Short
        };
        let size = 100_000_000 + rng.below(20_000_000_000); // 0.1 .. 20.1 SOL
        let st = h.account::<Position>(&traders[i].position).state;
        match rng.below(7) {
            0 | 1 if st == PositionState::Empty => {
                opened_attempt += 1;
                let notional = math::notional(size, price).unwrap();
                // Half the time bias the margin near the 10 % IMR floor (10-15 %
                // of notional) so a subsequent adverse price move plus crank has
                // a real chance to push the position under MMR and liquidate it;
                // otherwise keep the original wide 10-60 % range.
                let margin = if rng.below(2) == 0 {
                    notional / 10 + rng.below(notional / 20 + 1)
                } else {
                    notional / 10 + rng.below(notional / 2 + 1)
                };
                let r = h.send(
                    &[ixs::open_position(
                        &traders[i].kp.pubkey(),
                        &traders[i],
                        &w,
                        side,
                        size,
                        margin,
                        if side == Side::Long { u64::MAX } else { 0 },
                    )],
                    &[&traders[i].kp],
                );
                if r.is_ok() {
                    opened_ok += 1;
                }
            }
            2 if st == PositionState::Open => {
                add_margin_attempt += 1;
                let r = h.send(
                    &[ixs::add_margin(
                        &traders[i].kp.pubkey(),
                        &traders[i],
                        &w,
                        1 + rng.below(50_000_000),
                    )],
                    &[&traders[i].kp],
                );
                if r.is_ok() {
                    add_margin_ok += 1;
                }
            }
            3 if st == PositionState::Open => {
                increase_attempt += 1;
                let r = h.send(
                    &[ixs::increase_position(
                        &traders[i].kp.pubkey(),
                        &traders[i],
                        &w,
                        size / 4,
                        30_000_000 + rng.below(100_000_000),
                        if side == Side::Long { u64::MAX } else { 0 },
                    )],
                    &[&traders[i].kp],
                );
                if r.is_ok() {
                    increase_ok += 1;
                }
            }
            4 if st == PositionState::Open => {
                decrease_attempt += 1;
                let sz = h.account::<Position>(&traders[i].position).size;
                let r = h.send(
                    &[ixs::decrease_position(
                        &traders[i].kp.pubkey(),
                        &traders[i],
                        &w,
                        1 + rng.below(sz),
                        0,
                    )],
                    &[&traders[i].kp],
                );
                if r.is_ok() {
                    decrease_ok += 1;
                }
            }
            5 if st == PositionState::Open => {
                close_attempt += 1;
                let pos = h.account::<Position>(&traders[i].position);
                let r = h.send(
                    &[ixs::close_position(
                        &traders[i].kp.pubkey(),
                        &traders[i],
                        &w,
                        if pos.side == Side::Long { 0 } else { u64::MAX },
                    )],
                    &[&traders[i].kp],
                );
                if r.is_ok() {
                    close_ok += 1;
                }
            }
            _ => {
                // ±3 % move, then a crank over everyone
                let delta = price / 100 * (1 + rng.below(3));
                price = if rng.below(2) == 0 {
                    price + delta
                } else {
                    price.saturating_sub(delta).max(50_000_000)
                };
                w.set_price(&mut h, price, 5, ts, slot);
                let was_open: Vec<bool> = traders
                    .iter()
                    .map(|t| h.account::<Position>(&t.position).state == PositionState::Open)
                    .collect();
                let all: Vec<&Trader> = traders.iter().collect();
                h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &all)], &[&w.crank])
                    .unwrap_or_else(|e| panic!("step {step}: crank must not fail: {e:?}"));
                for (idx, t) in traders.iter().enumerate() {
                    if was_open[idx]
                        && h.account::<Position>(&t.position).state == PositionState::Closed
                    {
                        liquidated += 1;
                    }
                }
                crank_ok += 1;
            }
        }
        let refs: Vec<&Trader> = traders.iter().collect();
        assert_invariant_ctx(&h, &w, &refs, &format!("step {step}: "));
        // OI == Σ notional at entry over open positions
        let (mut ol, mut os) = (0u64, 0u64);
        for t in &traders {
            let p = h.account::<Position>(&t.position);
            if p.state == PositionState::Open {
                let n = math::notional(p.size, p.entry).unwrap();
                if p.side == Side::Long {
                    ol += n
                } else {
                    os += n
                }
            }
        }
        let r = h.account::<MarketRisk>(&w.risk); // VWAP entry is rounded up, so Σ notional(size, entry) may exceed the OI ledger by a few base units
        assert!(
            r.oi_long.abs_diff(ol) <= 100 && r.oi_short.abs_diff(os) <= 100,
            "step {step}: oi ({}, {}) vs Σ ({ol}, {os})",
            r.oi_long,
            r.oi_short
        );
        // liq price ordering for open positions
        for t in &traders {
            let p = h.account::<Position>(&t.position);
            if p.state == PositionState::Open && p.liq_price > 0 {
                match p.side {
                    Side::Long => assert!(
                        p.liq_price < p.entry,
                        "step {step}: long liq_price {} !< entry {}",
                        p.liq_price,
                        p.entry
                    ),
                    Side::Short => assert!(
                        p.liq_price > p.entry,
                        "step {step}: short liq_price {} !> entry {}",
                        p.liq_price,
                        p.entry
                    ),
                }
            }
        }
        // Any trader that is now Closed (user close/decrease-to-zero, or a crank
        // liquidation) is replaced exactly once (Closed → Empty needs
        // mark_committed, week 3, so it cannot reopen and must be swapped in).
        for idx in 0..traders.len() {
            if !replaced[idx]
                && h.account::<Position>(&traders[idx].position).state == PositionState::Closed
            {
                replaced[idx] = true;
                if traders.len() < 12 {
                    traders.push(w.new_trader(&mut h, 2_000_000_000));
                    replaced.push(false);
                }
            }
        }
    }
    println!(
        "ops: open {}/{} add_margin {}/{} increase {}/{} decrease {}/{} close {}/{} crank {} liquidated {}",
        opened_ok,
        opened_attempt,
        add_margin_ok,
        add_margin_attempt,
        increase_ok,
        increase_attempt,
        decrease_ok,
        decrease_attempt,
        close_ok,
        close_attempt,
        crank_ok,
        liquidated
    );
    assert!(liquidated > 0, "no liquidation occurred in 300 steps");
    let pool: Pool = h.account(&w.pool);
    println!(
        "final: protocol_liquidity {} fees {} insurance {} bad_debt {}",
        pool.protocol_liquidity, pool.fees_accrued, pool.insurance, pool.bad_debt_total
    );
}
