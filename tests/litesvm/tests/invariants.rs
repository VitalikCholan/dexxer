// Task 10: randomized sequences of trading operations, checking the pool
// invariant, the OI ledger and liquidation-price ordering after every step.
// Deterministic PRNG (seed 0xDEADBEEF) so a failure reproduces exactly.
use dexxer_core::{math, state::*};
use dexxer_litesvm::{
    assert_invariant_ctx, custom_error_code, ixs,
    setup::{Trader, World},
    Harness,
};
use solana_signer::Signer;
use std::collections::HashMap;

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
    let traders: Vec<Trader> = (0..4)
        .map(|_| w.new_trader(&mut h, 2_000_000_000))
        .collect();
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
    // Custom error code -> occurrence count, over every failed trade-op
    // attempt below (crank itself must never fail — see the `unwrap_or_else`
    // in its arm — so it never contributes here).
    let mut err_hist: HashMap<u32, u32> = HashMap::new();

    // The op valid for the trader's current state: Empty can only be opened
    // (or left for a crank tick), Open can be add_margin/increase/decrease/
    // closed (or left for a crank tick). Drawing from this set — instead of
    // drawing one of 7 fixed slots and falling through to a crank whenever
    // the draw doesn't fit the state — means every non-crank draw below is a
    // genuine attempt against dexxer_core, not a silent no-op.
    enum Op {
        Open,
        AddMargin,
        Increase,
        Decrease,
        Close,
        Crank,
    }

    for step in 0..300u32 {
        slot += 1;
        ts += 1;
        h.warp(slot, ts);
        // Re-post the feed every step (same price unless this step is a
        // crank, which posts its own moved price below) so a trade-op
        // attempt never sees a stale oracle just because the crank ratio
        // dropped once every draw became a genuine attempt (task 12 finding
        // #6) — staleness is `max_staleness_secs` (2s) old, independent of
        // whether a crank_tick happened to run this step.
        w.set_price(&mut h, price, 5, ts, slot);
        let i = rng.below(traders.len() as u64) as usize;
        let side = if rng.below(2) == 0 {
            Side::Long
        } else {
            Side::Short
        };
        let size = 100_000_000 + rng.below(20_000_000_000); // 0.1 .. 20.1 SOL
        let st = h.account::<Position>(&traders[i].position).state;
        // ~50% trade attempts / ~50% cranks: comfortably clears the "≥120 of
        // 300 steps are trade attempts" bar while still giving positions
        // enough crank ticks against a moving price to actually land a
        // liquidation (a higher trade bias closes positions out from under
        // themselves before an adverse crank ever gets a chance at them).
        let do_trade = rng.below(2) == 0;
        let op = match st {
            PositionState::Empty if do_trade => Op::Open,
            PositionState::Open if do_trade => match rng.below(4) {
                0 => Op::AddMargin,
                1 => Op::Increase,
                2 => Op::Decrease,
                _ => Op::Close,
            },
            _ => Op::Crank,
        };
        match op {
            Op::Open => {
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
                } else if let Some(code) = custom_error_code(&r) {
                    *err_hist.entry(code).or_insert(0) += 1;
                }
            }
            Op::AddMargin => {
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
                } else if let Some(code) = custom_error_code(&r) {
                    *err_hist.entry(code).or_insert(0) += 1;
                }
            }
            Op::Increase => {
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
                } else if let Some(code) = custom_error_code(&r) {
                    *err_hist.entry(code).or_insert(0) += 1;
                }
            }
            Op::Decrease => {
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
                } else if let Some(code) = custom_error_code(&r) {
                    *err_hist.entry(code).or_insert(0) += 1;
                }
            }
            Op::Close => {
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
                } else if let Some(code) = custom_error_code(&r) {
                    *err_hist.entry(code).or_insert(0) += 1;
                }
            }
            Op::Crank => {
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
                // Candidates are the Open positions, bounded to what one
                // crank_tick accepts.
                let all: Vec<&Trader> = traders
                    .iter()
                    .filter(|t| h.account::<Position>(&t.position).state == PositionState::Open)
                    .take(MAX_CANDIDATES)
                    .collect();
                h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &all)], &[&w.crank])
                    .unwrap_or_else(|e| panic!("step {step}: crank must not fail: {e:?}"));
                // A liquidation is a close, so a liquidated position reads
                // back as `Empty`.
                for (idx, t) in traders.iter().enumerate() {
                    if was_open[idx]
                        && h.account::<Position>(&t.position).state == PositionState::Empty
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
    }
    let trade_attempts =
        opened_attempt + add_margin_attempt + increase_attempt + decrease_attempt + close_attempt;
    let mut hist: Vec<(u32, u32)> = err_hist.into_iter().collect();
    hist.sort_by_key(|(code, _)| *code);
    let hist_str = hist
        .iter()
        .map(|(code, count)| format!("{code}:{count}"))
        .collect::<Vec<_>>()
        .join(", ");
    println!(
        "ops: open {}/{} add_margin {}/{} increase {}/{} decrease {}/{} close {}/{} crank {} liquidated {} errors: {{{hist_str}}}",
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
    assert!(
        trade_attempts >= 120,
        "only {trade_attempts} trade attempts in 300 steps"
    );
    assert!(liquidated > 0, "no liquidation occurred in 300 steps");
    let pool: PoolLive = h.account(&w.pool_live);
    println!(
        "final: protocol_liquidity {} fees {} insurance {} bad_debt {}",
        pool.protocol_liquidity, pool.fees_accrued, pool.insurance, pool.bad_debt_total
    );
}
