// Week-5 Task 3: the per-position liquidation path.
//
// `liquidation_check` is what the per-position Magic Actions task calls every
// `LIQ_TASK_INTERVAL_MS`. It is deliberately NOT a second crank: it never
// advances `Market.mark`/the EMA (the market-level schedule owns that), it
// only reads the oracle for freshness and then runs the SAME hysteresis and
// settlement helpers `crank_tick` runs (`liq_due`/`liquidate_now`).
use dexxer_core::{errors::DexxerError, state::*};
use dexxer_litesvm::{assert_custom_error, assert_invariant, ixs, setup::World, Harness};
use solana_keypair::Keypair;
use solana_signer::Signer;

const P150: u64 = 150_000_000;
const SOL10: u64 = 10_000_000_000;
const M150: u64 = 150_000_000;
// Same clock base every other suite settled on (bootstrap's faucet loop warps
// the clock past 1_000_000 on its own).
const NOW: i64 = 2_000_000;

/// Bootstraps a world whose mark is `mark_price` and one 10x long opened at
/// $150, without ever running a liquidating `crank_tick`: the mark is moved by
/// a candidate-less tick, so every liquidation in these tests can only come
/// from `liquidation_check` itself.
fn world_with_long(h: &mut Harness, mark_price: u64) -> (World, dexxer_litesvm::setup::Trader) {
    let w = World::bootstrap(h);
    h.warp(100, NOW);
    w.set_price(h, P150, 5, NOW, 100);
    let t = w.new_trader(h, 1_000_000_000);
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    if mark_price != P150 {
        // Hard EMA (alpha 1.0) and a wide deviation guard so the mark lands
        // exactly on `mark_price` in one tick and opens stay unpaused.
        let mut p = MarketParams::sol_perp_defaults();
        p.ema_alpha_bps = 10_000;
        p.max_deviation_bps = 10_000;
        h.send(
            &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
            &[&w.admin],
        )
        .unwrap();
        w.set_price(h, mark_price, 5, NOW, 101);
        // No candidates: this tick only moves the mark.
        h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
            .unwrap();
        assert_eq!(h.account::<Market>(&w.market).mark, mark_price);
    }
    (w, t)
}

/// The whole point of the task: a position goes under water and is closed by
/// the scheduled check alone, with no `crank_tick` candidate list anywhere.
#[test]
fn liquidation_check_liquidates_underwater_position() {
    let mut h = Harness::new();
    // liq price is ~142.5 for a 10 SOL long at $150 with $150 margin.
    let (w, t) = world_with_long(&mut h, 142_000_000);

    // Ticks below the hysteresis gate (default `liq_hysteresis_ticks` is 3
    // since fix round 1 — two callers now share one `liq_ticks` counter): the
    // position stays open and only the counter moves.
    for expected in 1..MarketParams::sol_perp_defaults().liq_hysteresis_ticks {
        h.send(
            &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
            &[&w.crank],
        )
        .unwrap();
        let pos: Position = h.account(&t.position);
        assert_eq!(pos.state, PositionState::Open);
        assert_eq!(pos.liq_ticks, expected);
    }

    // The tick that meets the gate: liquidated in the same instruction.
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Empty);
    assert_eq!(pos.size, 0);

    // Same settlement arithmetic the crank path produces for this position:
    // pnl = 10 * (142 - 150) = -80 $, liq fee 1 % of 1420 $ = 14.2 $,
    // to_user = 150 - 80 - 14.2 = 55.8 $.
    let u: UserAccount = h.account(&t.user);
    assert_eq!(u.free_margin, 1_000_000_000 - M150 - 900_000 + 55_800_000);
    assert_eq!(u.locked_margin, 0);
    assert_eq!(h.account::<PoolLive>(&w.pool_live).insurance, 14_200_000);

    // The mark is the market-level schedule's business: this path must not
    // have touched it.
    assert_eq!(h.account::<Market>(&w.market).mark, 142_000_000);
    assert_invariant(&h, &w, &[&t]);
}

/// Two no-op shapes that must both succeed (never error): a healthy position,
/// and a stale feed. The stale branch matters most — liquidating on a mark the
/// oracle can no longer vouch for is exactly what spec §3.5 forbids.
#[test]
fn liquidation_check_noop_when_healthy_or_stale() {
    let mut h = Harness::new();
    let (w, t) = world_with_long(&mut h, P150);

    // (1) healthy at the opening mark.
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Open);
    assert_eq!(pos.liq_ticks, 0);

    // (2) deep under water, but the feed is stale: no liquidation, no error,
    // and not even a hysteresis tick (the price is not trustworthy at all).
    w.set_price(&mut h, 100_000_000, 5, NOW - 100, 101);
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    let pos: Position = h.account(&t.position);
    assert_eq!(pos.state, PositionState::Open);
    assert_eq!(pos.liq_ticks, 0);
    assert_invariant(&h, &w, &[&t]);
}

#[test]
fn liquidation_check_rejects_non_scheduler_signer() {
    let mut h = Harness::new();
    let (w, t) = world_with_long(&mut h, 142_000_000);
    let stranger = Keypair::new();
    h.fund(&stranger.pubkey(), 1_000_000_000);
    let r = h.send(
        &[ixs::liquidation_check(&stranger.pubkey(), &w, &t)],
        &[&stranger],
    );
    assert_custom_error(&r, 6000 + DexxerError::Unauthorized as u32);
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Open
    );
}

/// What this test can and cannot prove (week-5 final review M4, renamed from
/// `open_registers_task_idempotently`): LiteSVM has no Magic program, so
/// `open_position`'s schedule CPI and `close_position`'s cancel CPI are both
/// SKIPPED by the `magic_program.executable` gate. All that is verified here is
/// that each path REACHES that gate and that a re-open after a close works —
/// NOT that a re-registration under the same `task_id` is treated as an update
/// by the scheduler. That idempotency is a devnet measurement (week-5 Task 0,
/// measurement 1/3), unverifiable in this harness.
#[test]
fn open_skips_task_registration_without_magic_program() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = w.new_trader(&mut h, 1_000_000_000);

    let meta = h
        .send(
            &[ixs::open_position(
                &t.kp.pubkey(),
                &t,
                &w,
                Side::Long,
                SOL10,
                M150,
                P150,
            )],
            &[&t.kp],
        )
        .unwrap();
    assert!(
        meta.logs.iter().any(|l| l.contains("liq task: skipped")),
        "open must REACH the scheduler gate — LiteSVM has no Magic program, so \
         this proves the path is taken, NOT that the registration is \
         idempotent (devnet-only measurement), logs: {:?}",
        meta.logs
    );

    let meta = h
        .send(&[ixs::close_position(&t.kp.pubkey(), &t, &w, 0)], &[&t.kp])
        .unwrap();
    assert!(
        meta.logs.iter().any(|l| l.contains("liq task: skipped")),
        "close must REACH the cancel gate — skipped here, so the cancel CPI \
         itself is not exercised, logs: {:?}",
        meta.logs
    );

    // Second open: same position PDA, therefore the same `task_id`. Here this
    // only shows the re-open succeeds; whether the scheduler treats the
    // re-registration as an update is the devnet measurement above.
    h.send(
        &[ixs::open_position(
            &t.kp.pubkey(),
            &t,
            &w,
            Side::Long,
            SOL10,
            M150,
            P150,
        )],
        &[&t.kp],
    )
    .unwrap();
    assert_eq!(
        h.account::<Position>(&t.position).state,
        PositionState::Open
    );
    assert_invariant(&h, &w, &[&t]);
}

/// Fix round 1, M-1: `task_context` is an inert placeholder to the Magic
/// Program, but it is `mut` in this context — so an unconstrained one would let
/// any caller name another trader's delegated account and write-lock it for the
/// whole transaction, purely to contend with them. It is pinned to the caller's
/// own `position`.
#[test]
fn open_position_rejects_foreign_task_context() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let victim = w.new_trader(&mut h, 1_000_000_000);
    let attacker = w.new_trader(&mut h, 1_000_000_000);

    let mut ix = ixs::open_position(
        &attacker.kp.pubkey(),
        &attacker,
        &w,
        Side::Long,
        SOL10,
        M150,
        P150,
    );
    // `task_context` is the second-to-last account of `Trade`, right before
    // `magic_program` and `liq_crank_signer` (see `Trader::trade_accounts`).
    let task_context_idx = ix.accounts.len() - 3;
    assert_eq!(ix.accounts[task_context_idx].pubkey, attacker.position);
    ix.accounts[task_context_idx].pubkey = victim.position;

    let r = h.send(&[ix], &[&attacker.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
    assert_eq!(
        h.account::<Position>(&attacker.position).state,
        PositionState::Empty,
        "the open must not have happened"
    );
}
