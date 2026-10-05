// scripts/admin/schedule-eternal.ts
//
// Task 7 (week 4): register `crank_tick` as a MagicBlock scheduled task on
// devnet-tee with `iterations = i64::MAX` — a liquidation backstop that
// keeps ticking `Market`'s mark/EMA and liquidating candidates even if the
// Railway relayer (`services/relayer`, `scripts/admin/schedule-crank.ts`'s
// finite-iterations sibling) is down or its crank loop is disabled. Tech
// debt #18 (spec §7.1): week 3's `spikes/05-crank-tee` measured
// `iterations = i64::MAX` PASS/ticking on a throwaway spike program
// (weeks0-5-history.md#week-3 §M-D); this script is the first time it's applied to
// the real `dexxer_core` deployment.
//
// Structure mirrors `schedule-crank.ts` closely (same task_id derivation,
// same account set, same `MAGIC_PROGRAM_ID` CPI shape) — differences:
//   1. Self-heals `Config.scheduler_signer` instead of failing when it's
//      wrong: if it doesn't already equal `crank_signer_pda(admin)`, this
//      script runs `set_scheduler_signer` itself (same ix
//      `set-scheduler-signer.ts` calls) rather than telling the operator to
//      run a separate script first.
//   2. `iterations = 9_223_372_036_854_775_807` (i64::MAX) instead of the
//      finite `86_400` (24h) `schedule-crank.ts` uses.
//   3. Same deterministic `task_id` as `schedule-crank.ts` (both are
//      first-8-bytes-of-sha256(program id), i.e. the SAME on-chain task) —
//      re-running `schedule_crank` against an existing task_id with the
//      same authority is documented as an update, not a collision (see
//      schedule-crank.ts's header comment, `magicblock` skill's
//      `references/cranks.md`), so this REPLACES schedule-crank.ts's
//      24h-then-stops registration with an i64::MAX one under the same
//      task_id — there is exactly one scheduled `crank_tick` task per
//      deployment, not two. If the update is ever rejected outright (not
//      observed in week 3's measurement, but not proven impossible either),
//      this script falls back to `cancel_crank(old task_id)` then retries
//      `schedule_crank` fresh, logging both attempts.
//   4. After a successful (re)schedule, polls `Market.mark`/`mark_slot` on
//      the TEE for 60s to prove the task is actually ticking, printing a
//      PASS/FAIL verdict — the same style of live proof week 3's M-D spike
//      measurement used, just against the real market this time.
//
// Run (after devnet-bootstrap.ts / schedule-crank.ts have run at least
// once, so Config/Market/MarketRisk/PoolLive exist):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/schedule-eternal.ts
// or: npm run admin:schedule-eternal --prefix scripts

export {}; // module marker: top-level await below requires this file to be a module

import { createHash } from "node:crypto";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { BN } = await import("@coral-xyz/anchor");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn } = await import("../../tests/er/lib/env.js");
const { accountNs, dexxerCoreProgram, pdas, DEXXER_CORE_PROGRAM_ID } = await import("../../tests/er/lib/program.js");
const { crankSignerPda } = await import("../../tests/er/lib/crank-signer.js");
const { MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). Run: DEXXER_NET=devnet npx tsx scripts/admin/schedule-eternal.ts`);
  process.exit(1);
}

const INTERVAL_MS = 1_000;
// i64::MAX — the "effectively forever" value week 3's M-D spike measured as
// accepted and actually ticking (weeks0-5-history.md#week-3 §M-D, 81 ticks / 65s).
const ITERATIONS = "9223372036854775807";
const POLL_SECONDS = 60;
const POLL_DELAY_MS = 5_000;

async function main(): Promise<void> {
  const admin = loadOrCreateKey("devnet-admin");
  const config = pdas.config();
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);
  const expectedCrankSigner = crankSignerPda(admin.publicKey);

  const conn = await teeConn(admin);
  const core = dexxerCoreProgram(conn, admin);

  console.log("admin", admin.publicKey.toBase58());
  console.log("config", config.toBase58());

  // --- step 1: self-heal Config.scheduler_signer if needed (base layer) ---
  let configBefore = await accountNs(core).config.fetch(config);
  const schedulerSignerBefore = (configBefore.schedulerSigner as { toBase58: () => string }).toBase58();
  console.log("Config.scheduler_signer (before)", schedulerSignerBefore, "expected", expectedCrankSigner.toBase58());

  if (schedulerSignerBefore !== expectedCrankSigner.toBase58()) {
    console.log("Config.scheduler_signer mismatch — running set_scheduler_signer on base first");
    const baseCore = dexxerCoreProgram(baseConn, admin);
    const setSig = await baseCore.methods
      .setSchedulerSigner(expectedCrankSigner)
      .accounts({ admin: admin.publicKey, config })
      .rpc();
    console.log("set_scheduler_signer sig", setSig);
    configBefore = await accountNs(core).config.fetch(config);
    const after = (configBefore.schedulerSigner as { toBase58: () => string }).toBase58();
    if (after !== expectedCrankSigner.toBase58()) {
      console.error(`FAIL: Config.scheduler_signer still != expected after set_scheduler_signer (got ${after})`);
      process.exit(1);
    }
    console.log("ok: Config.scheduler_signer == crank_signer_pda(admin), verified on-chain");
  } else {
    console.log("ok: Config.scheduler_signer already == crank_signer_pda(admin), skipping set_scheduler_signer");
  }

  // week-4 Task 1: ScheduleCrank/CrankTick read/write PoolLive, not Pool.
  const poolLive = pdas.poolLive(configBefore.dusdcMint);
  const marketAcc = await accountNs(core).market.fetch(market);
  const feed = marketAcc.feed;

  const programHash = createHash("sha256").update(DEXXER_CORE_PROGRAM_ID.toBuffer()).digest();
  const taskId = programHash.readBigInt64LE(0);
  console.log("program id", DEXXER_CORE_PROGRAM_ID.toBase58(), "-> task_id", taskId.toString());
  console.log("market", market.toBase58(), "market_risk", marketRisk.toBase58(), "pool_live", poolLive.toBase58(), "feed", feed.toBase58());
  console.log(`iterations = ${ITERATIONS} (i64::MAX), interval_ms = ${INTERVAL_MS}`);

  const taskContext = admin.publicKey; // must NOT collide with config's address — see schedule-crank.ts's header comment

  async function buildScheduleIx() {
    return core.methods
      .scheduleCrank(new BN(taskId.toString()), new BN(INTERVAL_MS), new BN(ITERATIONS))
      .accounts({
        admin: admin.publicKey,
        config,
        market,
        marketRisk,
        poolLive,
        feed,
        crank: expectedCrankSigner,
        taskContext,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: taskContext, isWritable: true, isSigner: false },
        { pubkey: expectedCrankSigner, isWritable: false, isSigner: false },
        { pubkey: config, isWritable: false, isSigner: false },
        { pubkey: market, isWritable: true, isSigner: false },
        { pubkey: marketRisk, isWritable: true, isSigner: false },
        { pubkey: poolLive, isWritable: true, isSigner: false },
        { pubkey: feed, isWritable: false, isSigner: false },
      ])
      .instruction();
  }

  // --- step 2: schedule_crank(task_id, interval_ms, iterations=i64::MAX) ---
  let scheduleSig: string;
  try {
    scheduleSig = await sendAndConfirmIx(conn, admin, await buildScheduleIx());
    console.log("schedule_crank sig", scheduleSig, "task_id", taskId.toString());
  } catch (e) {
    console.error("schedule_crank (update) FAILED, falling back to cancel_crank + retry", String((e as Error)?.message ?? e));
    const cancelIx = await core.methods
      .cancelCrank(new BN(taskId.toString()))
      .accounts({ admin: admin.publicKey, config, taskContext, magicProgram: MAGIC_PROGRAM_ID })
      .instruction();
    const cancelSig = await sendAndConfirmIx(conn, admin, cancelIx);
    console.log("cancel_crank sig", cancelSig, "task_id", taskId.toString());
    scheduleSig = await sendAndConfirmIx(conn, admin, await buildScheduleIx());
    console.log("schedule_crank sig (retry after cancel)", scheduleSig, "task_id", taskId.toString());
  }

  // --- step 3: poll Market.mark/mark_slot on the TEE to prove it's actually ticking ---
  console.log(`polling Market.mark/mark_slot for ${POLL_SECONDS}s to confirm the scheduler is ticking...`);
  const samples: Array<{ t: number; mark: string; markSlot: string }> = [];
  const t0 = Date.now();
  while (Date.now() - t0 < POLL_SECONDS * 1000) {
    const m = await accountNs(core).market.fetch(market);
    samples.push({ t: Date.now() - t0, mark: m.mark.toString(), markSlot: m.markSlot.toString() });
    console.log(`  t=${((Date.now() - t0) / 1000).toFixed(1)}s mark=${m.mark.toString()} mark_slot=${m.markSlot.toString()}`);
    await sleep(POLL_DELAY_MS);
  }
  const distinctSlots = new Set(samples.map((s) => s.markSlot)).size;
  const ticking = distinctSlots > 1;
  console.log(
    "\nSCHEDULE-ETERNAL",
    ticking ? "PASS (scheduler ticks without relayer)" : "FAIL (mark_slot did not advance during poll window)",
    JSON.stringify({ taskId: taskId.toString(), scheduleSig, samples: samples.length, distinctSlots }),
  );
  if (!ticking) process.exitCode = 1;
}

main().catch((e) => {
  console.error("schedule-eternal FAIL", e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
