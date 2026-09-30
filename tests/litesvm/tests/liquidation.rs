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
const P142: u64 = 142_000_000;
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

    // Ticks below the hysteresis gate: the position stays open and only the
    // counter moves. `liquidation_check` never moves the mark, so each tick
    // needs a fresh price sample from a (candidate-less) `crank_tick` (risk
    // #38: one sample, one tick).
    let mut slot = 100u64;
    for expected in 1..MarketParams::sol_perp_defaults().liq_hysteresis_ticks {
        h.send(
            &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
            &[&w.crank],
        )
        .unwrap();
        let pos = h.slot(&t, &w.market).expect("open slot");
        assert!(pos.is_open());
        assert_eq!(pos.liq_ticks, expected);
        slot += 1;
        h.warp(slot, NOW);
        // A new oracle print (later `posted_slot` than the mark tick's 101).
        w.set_price(&mut h, 142_000_000, 5, NOW, slot + 1_000);
        h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
            .unwrap();
    }

    // The tick that meets the gate: liquidated in the same instruction.
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    assert!(h.slot(&t, &w.market).is_none());
    assert!(h.positions(&t.positions).slots.iter().all(|s| s.size == 0));

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
    let pos = h.slot(&t, &w.market).expect("open slot");
    assert!(pos.is_open());
    assert_eq!(pos.liq_ticks, 0);

    // (2) deep under water, but the feed is stale: no liquidation, no error,
    // and not even a hysteresis tick (the price is not trustworthy at all).
    w.set_price(&mut h, 100_000_000, 5, NOW - 100, 101);
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    let pos = h.slot(&t, &w.market).expect("open slot");
    assert!(pos.is_open());
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
    assert!(h.slot(&t, &w.market).is_some());
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
    assert!(h.slot(&t, &w.market).is_some());
    assert_invariant(&h, &w, &[&t]);
}

/// Fix round 1, M-1: `task_context` is an inert placeholder to the Magic
/// Program, but it is `mut` in this context — so an unconstrained one would let
/// any caller name another trader's delegated account and write-lock it for the
/// whole transaction, purely to contend with them. It is pinned to the caller's
/// own `positions`.
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
    assert_eq!(ix.accounts[task_context_idx].pubkey, attacker.positions);
    ix.accounts[task_context_idx].pubkey = victim.positions;

    let r = h.send(&[ix], &[&attacker.kp]);
    assert_custom_error(&r, 6000 + DexxerError::InvalidCandidate as u32);
    assert!(
        h.slot(&attacker, &w.market).is_none(),
        "the open must not have happened"
    );
}

/// Risk #38: `liq_ticks` counts distinct oracle prints accepted by
/// `crank_tick` (`Market.sample_seq`), not calls. Only `crank_tick` moves the
/// mark and the sample; `liquidation_check` reads them.
#[test]
fn three_checks_on_one_price_sample_count_as_one_tick() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = w.new_trader(&mut h, 1_000_000_000);
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
    assert_eq!(h.account::<Market>(&w.market).liq_hysteresis_ticks, 2);
    // Hard EMA + wide deviation guard: the mark lands on the crashed price in
    // one tick (liq price is ~142.5 for this position).
    let mut p = MarketParams::sol_perp_defaults();
    p.ema_alpha_bps = 10_000;
    p.max_deviation_bps = 10_000;
    h.send(
        &[ixs::set_params(&w.admin.pubkey(), &w.config, &w.market, p)],
        &[&w.admin],
    )
    .unwrap();

    // Sample #1: a crank tick on a NEW print at the crashed price.
    h.warp(9_110, NOW);
    w.set_price(&mut h, P142, 5, NOW, 101);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 1);
    // Three checks on the same print: still one tick (they do reach `liq_due`
    // — the last step below is liquidated by ONE check).
    for i in 0..3u32 {
        h.send(
            &[
                ixs::set_compute_unit_limit(200_000 + i),
                ixs::liquidation_check(&w.crank.pubkey(), &w, &t),
            ],
            &[&w.crank],
        )
        .unwrap();
    }
    let s = h.slot(&t, &w.market).expect("not liquidated on one sample");
    assert_eq!(s.liq_ticks, 1);

    // A second crank tick in a LATER slot on the SAME print (no new
    // publication): the mark_slot moves, the sample does not.
    h.warp(9_111, NOW);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.account::<Market>(&w.market).mark_slot, 9_111);
    let s = h
        .slot(&t, &w.market)
        .expect("one print is one tick, whoever cranks");
    assert_eq!(s.liq_ticks, 1);

    // A new print, seen by a candidate-less crank_tick (moves the sample only):
    // ONE liquidation_check now reaches the hysteresis and liquidates.
    h.warp(9_112, NOW);
    w.set_price(&mut h, P142, 5, NOW, 102);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 1);
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    assert!(
        h.slot(&t, &w.market).is_none(),
        "liquidated on the second print"
    );
    assert_invariant(&h, &w, &[&t]);
}

/// A freshly opened slot starts at the market's current sample, so a print
/// that was already sampled before the open can never tick the new position.
/// (An underwater open is refused, so this asserts the stored baseline.)
#[test]
fn a_new_position_starts_from_the_current_sample() {
    let mut h = Harness::new();
    let w = World::bootstrap(&mut h);
    h.warp(100, NOW);
    w.set_price(&mut h, P150, 5, NOW, 100);
    let t = w.new_trader(&mut h, 1_000_000_000);
    // Two crank prints before the open: sample_seq = 2.
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    h.warp(101, NOW);
    w.set_price(&mut h, P150, 5, NOW, 101);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let seq = h.account::<Market>(&w.market).sample_seq;
    assert_eq!(seq, 2);
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
    assert_eq!(h.slot(&t, &w.market).expect("open").last_liq_sample, seq);
}

/// Final review C1: a dust `increase_position` on a position that is
/// liquidatable at the current mark used to reset `liq_ticks` to 0, so the
/// trader could dodge the hysteresis print after print. Now the increase is
/// refused (the would-be slot is liquidatable at the stored mark), the counter
/// stays, and the next print liquidates.
#[test]
fn a_dust_increase_on_a_liquidatable_position_is_refused_and_keeps_ticks() {
    let mut h = Harness::new();
    let (w, t) = world_with_long(&mut h, P142);
    let o = t.kp.pubkey();
    assert_eq!(h.account::<Market>(&w.market).liq_hysteresis_ticks, 2);
    // Same print the mark tick saw: the crank counts tick 1 on it.
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 1);
    let slot_before = h.slot(&t, &w.market).unwrap();
    let user_before: UserAccount = h.account(&t.user);

    let r = h.send(
        &[ixs::increase_position(&o, &t, &w, 1, 2, u64::MAX)],
        &[&t.kp],
    );
    assert_custom_error(&r, 6000 + DexxerError::PositionLiquidatable as u32);
    let slot_after = h.slot(&t, &w.market).expect("still open");
    assert_eq!(
        bytemuck_bytes(&slot_before),
        bytemuck_bytes(&slot_after),
        "a refused increase writes nothing, liq_ticks included"
    );
    let user_after: UserAccount = h.account(&t.user);
    assert_eq!(user_before.free_margin, user_after.free_margin);
    assert_eq!(user_before.locked_margin, user_after.locked_margin);

    // The next print completes the hysteresis.
    h.warp(102, NOW);
    w.set_price(&mut h, P142, 5, NOW, 102);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert!(h.slot(&t, &w.market).is_none(), "liquidated on print 2");
    assert_eq!(
        h.positions(&t.positions).history[0].reason,
        CloseReason::Liquidated.as_u8()
    );
    assert_invariant(&h, &w, &[&t]);
}

/// Final review C1, the other half: an increase that leaves the position
/// healthy still works, and it does not reset a non-zero `liq_ticks` by
/// itself — only a healthy check (`liq_due`) does.
#[test]
fn a_healthy_increase_works_and_does_not_reset_liq_ticks() {
    let mut h = Harness::new();
    let (w, t) = world_with_long(&mut h, P142);
    let o = t.kp.pubkey();
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 1);
    // +0.01 SOL with +100 $ margin: healthy at the 142 mark afterwards.
    h.send(
        &[ixs::increase_position(
            &o,
            &t,
            &w,
            10_000_000,
            100_000_000,
            u64::MAX,
        )],
        &[&t.kp],
    )
    .unwrap();
    let s = h.slot(&t, &w.market).expect("open");
    assert_eq!(s.size, SOL10 + 10_000_000);
    assert_eq!(s.margin, M150 + 100_000_000);
    assert_eq!(s.liq_ticks, 1, "an increase never resets the counter");
    // The next check on a new print sees a healthy position and resets it.
    h.warp(102, NOW);
    w.set_price(&mut h, P142, 5, NOW, 102);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 0);
    assert_invariant(&h, &w, &[&t]);
}

/// Final review C2: a sample is a DIFFERENT print (`posted_slot !=
/// last_print`), not a newer one. With `>` a single high `posted_slot` would
/// freeze every later sample and nobody would ever be liquidated again.
#[test]
fn prints_with_a_lower_posted_slot_still_count_as_samples() {
    let mut h = Harness::new();
    let (w, t) = world_with_long(&mut h, P142);
    let seq0 = h.account::<Market>(&w.market).sample_seq;
    h.warp(102, NOW);
    w.set_price(&mut h, P142, 5, NOW, 5_000);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.account::<Market>(&w.market).sample_seq, seq0 + 1);
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 1);
    // The feed's posted_slot goes backwards.
    h.warp(103, NOW);
    w.set_price(&mut h, P142, 5, NOW, 200);
    h.send(
        &[ixs::crank_tick(&w.crank.pubkey(), &w, &[&t])],
        &[&w.crank],
    )
    .unwrap();
    let m: Market = h.account(&w.market);
    assert_eq!(m.sample_seq, seq0 + 2, "a lower posted_slot is a new print");
    assert_eq!(m.last_print, 200);
    assert!(h.slot(&t, &w.market).is_none(), "liquidated on print 2");
    assert_invariant(&h, &w, &[&t]);
}

/// Final review C3: a print on which `crank_tick` tripped its deviation
/// breaker is not a sample — `liquidation_check` must not count or liquidate
/// on it. The same print, accepted by a later crank call, counts.
#[test]
fn a_print_the_crank_tripped_on_is_not_a_sample() {
    let mut h = Harness::new();
    // Mark 142 (hard EMA), sample 1; the position ticks once on it.
    let (w, t) = world_with_long(&mut h, P142);
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    assert_eq!(h.slot(&t, &w.market).expect("open").liq_ticks, 1);
    let seq = h.account::<Market>(&w.market).sample_seq;
    // Back to the default EMA (0.3) and deviation guard (2 %).
    h.send(
        &[ixs::set_params(
            &w.admin.pubkey(),
            &w.config,
            &w.market,
            MarketParams::sol_perp_defaults(),
        )],
        &[&w.admin],
    )
    .unwrap();
    // 138 vs mark 142 = 2.8 %: the crank trips. The EMA still absorbs it
    // (mark 140.8), which is within 2 % of 138 for `liquidation_check`.
    h.warp(102, NOW);
    w.set_price(&mut h, 138_000_000, 5, NOW, 102);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let m: Market = h.account(&w.market);
    assert!(m.paused_open, "the crank tripped on this print");
    assert_eq!(m.mark, 140_800_000);
    assert_eq!(m.sample_seq, seq, "a tripped print is not a sample");
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    let s = h
        .slot(&t, &w.market)
        .expect("not liquidated on a tripped print");
    assert_eq!(s.liq_ticks, 1);
    // The same print, now within 2 % of the mark: accepted, and it counts.
    h.warp(103, NOW);
    h.send(&[ixs::crank_tick(&w.crank.pubkey(), &w, &[])], &[&w.crank])
        .unwrap();
    let m: Market = h.account(&w.market);
    assert!(!m.paused_open);
    assert_eq!(m.sample_seq, seq + 1);
    h.send(
        &[ixs::liquidation_check(&w.crank.pubkey(), &w, &t)],
        &[&w.crank],
    )
    .unwrap();
    assert!(
        h.slot(&t, &w.market).is_none(),
        "liquidated on the accepted print"
    );
    assert_invariant(&h, &w, &[&t]);
}

fn bytemuck_bytes(s: &PositionSlot) -> Vec<u8> {
    anchor_lang::__private::bytemuck::bytes_of(s).to_vec()
}
