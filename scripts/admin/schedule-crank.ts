// scripts/admin/schedule-crank.ts
//
// Task 6: register `crank_tick` as a Magic Actions scheduled task on
// devnet-tee, so the ER's own scheduler keeps ticking `Market`'s EMA/mark
// forward even when the crank-fallback script (scripts/crank-fallback) isn't
// running — spec §8 Q2 / week-2 controller ruling task-4 #2.
// `programs/dexxer_core/src/instructions/crank.rs`'s `schedule_crank` is
// ER-only (writes `Market`/`MarketRisk`/`Pool`, all delegated — see that
// file's header comment on `ScheduleCrank`), so this script's admin call
// goes through `teeConn(admin)`, not `baseConn`, unlike most of
// `devnet-bootstrap.ts`. Kept as a separate script rather than folded into
// `devnet-bootstrap.ts` (task-6 brief left this as a judgment call) because
// every other bootstrap step runs on the base layer before the relevant PDA
// is delegated — this one only makes sense to run *after* `delegate_market`/
// `delegate_pool`, strictly on the ER, which would make it an odd outlier in
// that file's mostly-L1 sequence.
//
// `task_id`: first 8 bytes of SHA-256(program id bytes), read as a signed
// little-endian i64 (task-6 brief's formula: "task_id = hash(program
// id)[..8] as i64"). Deterministic per-deployment, not per-run, so this
// script is idempotent the same way `devnet-bootstrap.ts` is: if
// `Config.crank_task_id` already equals this value, scheduling is skipped.
//
// Run (same DEXXER_NET requirement/order as devnet-bootstrap.ts — run that
// first so Config/Market/MarketRisk/Pool exist and are delegated):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/schedule-crank.ts
//
// task_context (ScheduleCrank's 7th remaining_account, matches the on-chain
// `expected` order [task_context, crank, config, market, market_risk, pool,
// feed]): week2-results.md Task 1's task-context finding — neither
// `ephemeral-rollups-sdk` 0.16.2 nor `magicblock-magic-program-api` 0.10.1
// expose an on-chain PDA derivation for this account, and empirically *any*
// consistent, already-existing account works at this position (a spike
// passed a duplicate payer and ticks still ran). This script uses the
// `config` PDA — the controller-recommended choice recorded there — rather
// than inventing a new one.

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
const { NET, ER_VALIDATOR, loadOrCreateKey, sendAndConfirmIx, teeConn } = await import("../../tests/er/lib/env.js");
const { accountNs, dexxerCoreProgram, pdas } = await import("../../tests/er/lib/program.js");
const { MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");

if (NET !== "devnet") {
  console.error(
    `FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). ` +
      "Run: DEXXER_NET=devnet npx tsx scripts/admin/schedule-crank.ts",
  );
  process.exit(1);
}

const INTERVAL_MS = 1_000;
const ITERATIONS = 86_400; // 1000ms * 86_400 == 24h of ticks

async function main(): Promise<void> {
  const admin = loadOrCreateKey("devnet-admin");
  const config = pdas.config();
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);

  const conn = await teeConn(admin);
  const core = dexxerCoreProgram(conn, admin);

  const configBefore = await accountNs(core).config.fetch(config);
  const pool = pdas.pool(configBefore.dusdcMint);
  const marketAcc = await accountNs(core).market.fetch(market);
  const feed = marketAcc.feed;

  const { DEXXER_CORE_PROGRAM_ID } = await import("../../tests/er/lib/program.js");
  const programHash = createHash("sha256").update(DEXXER_CORE_PROGRAM_ID.toBuffer()).digest();
  const taskId = programHash.readBigInt64LE(0);
  console.log("program id", DEXXER_CORE_PROGRAM_ID.toBase58(), "-> task_id", taskId.toString());

  console.log("admin", admin.publicKey.toBase58());
  console.log("config", config.toBase58(), "current crank_task_id", configBefore.crankTaskId.toString());
  console.log("scheduler_signer (crank account)", (configBefore.schedulerSigner as { toBase58: () => string }).toBase58());
  console.log("market", market.toBase58(), "market_risk", marketRisk.toBase58(), "pool", pool.toBase58(), "feed", feed.toBase58());

  if (BigInt(configBefore.crankTaskId.toString()) === taskId) {
    console.log("schedule_crank: Config.crank_task_id already == computed task_id, skipping (idempotent)");
    return;
  }

  const taskContext = config; // controller-recommended choice, see header comment

  const ix = await core.methods
    .scheduleCrank(new BN(taskId.toString()), new BN(INTERVAL_MS), new BN(ITERATIONS))
    .accounts({
      admin: admin.publicKey,
      config,
      market,
      marketRisk,
      pool,
      feed,
      crank: ER_VALIDATOR,
      taskContext,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: taskContext, isWritable: true, isSigner: false },
      { pubkey: ER_VALIDATOR, isWritable: false, isSigner: false },
      { pubkey: config, isWritable: true, isSigner: false },
      { pubkey: market, isWritable: true, isSigner: false },
      { pubkey: marketRisk, isWritable: true, isSigner: false },
      { pubkey: pool, isWritable: true, isSigner: false },
      { pubkey: feed, isWritable: false, isSigner: false },
    ])
    .instruction();

  const sig = await sendAndConfirmIx(conn, admin, ix);
  console.log("schedule_crank sig", sig);

  const configAfter = await accountNs(core).config.fetch(config);
  console.log("Config.crank_task_id after (read via ER)", configAfter.crankTaskId.toString());
}

main().catch((e) => {
  console.error("schedule-crank FAIL", e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
