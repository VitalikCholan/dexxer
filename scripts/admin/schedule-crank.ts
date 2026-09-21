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
// PREREQUISITE (task-6 fix round 3): `Config.scheduler_signer` must already
// equal `crank_signer_pda(admin)` before running this script — run
// `scripts/admin/set-scheduler-signer.ts` once first (a fresh
// `bootstrapDevnet()` seeds it correctly at `init_config` time instead, see
// `tests/er/lib/admin.ts`). This script asserts that precondition below
// rather than silently sending a `crank` account that won't match
// `crank_tick`'s own signer constraint.
//
// `crank` account / signer identity history (see
// `tests/er/lib/crank-signer.ts` for the current derivation and its pinned
// validator source, and week2-results.md §Task 6 for the full evidence
// trail across all three fix rounds):
//   - fix round 1: flat `CRANK_SIGNER` — failed on-chain ("only the crank
//     signer PDA can be a signer in cranks").
//   - fix round 2: `schedule_crank` computed `crank_signer_pda(admin)`
//     in-program and WROTE it into `Config.scheduler_signer` before its own
//     CPI — failed on-chain twice independently
//     (`TransactionError::InvalidWritableAccount`: a writable, non-delegated
//     account other than `task_context` is unconditionally rejected in
//     `ScheduleCrankCpi`'s `instruction_accounts`, and `config` must be in
//     that list).
//   - fix round 3 (current): the write moved to a NEW base-layer admin ix,
//     `set_scheduler_signer` (`instructions/admin.rs`) — base-layer writes to
//     `Config` have no such restriction. `schedule_crank` itself is back to
//     read-only on `config`, just like fix round 1, and simply trusts
//     whatever `Config.scheduler_signer` already holds.
//
// `task_id`: first 8 bytes of SHA-256(program id bytes), read as a signed
// little-endian i64 (task-6 brief's formula: "task_id = hash(program
// id)[..8] as i64"). Deterministic per-deployment, not per-run. NOT
// idempotency-checked against `Config.crank_task_id`: that field is never
// written by `schedule_crank` (see its doc comment in `crank.rs`) — it
// always reads back `0`. Re-running this script re-sends `schedule_crank`
// with the same task_id every time; per the `magicblock` skill's
// `references/cranks.md`, "Rescheduling an existing task_id is an update
// only when the existing authority authorizes it" — same admin, same
// task_id here, so this is a safe reschedule/update, not a collision.
//
// Run (same DEXXER_NET requirement/order as devnet-bootstrap.ts — run that
// first so Config/Market/MarketRisk/Pool exist and are delegated, then
// set-scheduler-signer.ts if Config predates fix round 3):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/schedule-crank.ts
//
// task_context (ScheduleCrank's 7th remaining_account, matches the on-chain
// `expected` order [task_context, crank, config, market, market_risk, pool,
// feed]): week2-results.md Task 1's task-context finding — neither
// `ephemeral-rollups-sdk` 0.16.2 nor `magicblock-magic-program-api` 0.10.1
// expose an on-chain PDA derivation for this account, and empirically *any*
// consistent, already-existing account works at this position (a spike
// passed a duplicate payer and ticks still ran). This script uses
// `admin.publicKey` (fix round 3, unchanged from round 3's original client
// fix) — NOT `config`'s address: `task_context` legitimately needs to be
// writable, and Solana's transaction compiler deduplicates repeated pubkeys
// to the WIDEST privilege requested anywhere in the message, so reusing
// `config`'s address there would force `config` writable too (exactly the
// bug fix round 3 first found and fixed, independent of the round-2
// writable-account restriction above).

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
const { NET, loadOrCreateKey, sendAndConfirmIx, teeConn } = await import("../../tests/er/lib/env.js");
const { accountNs, dexxerCoreProgram, pdas, DEXXER_CORE_PROGRAM_ID } = await import("../../tests/er/lib/program.js");
const { crankSignerPda } = await import("../../tests/er/lib/crank-signer.js");
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
  const expectedCrankSigner = crankSignerPda(admin.publicKey);

  const conn = await teeConn(admin);
  const core = dexxerCoreProgram(conn, admin);

  const configBefore = await accountNs(core).config.fetch(config);
  const pool = pdas.pool(configBefore.dusdcMint);
  const marketAcc = await accountNs(core).market.fetch(market);
  const feed = marketAcc.feed;

  const programHash = createHash("sha256").update(DEXXER_CORE_PROGRAM_ID.toBuffer()).digest();
  const taskId = programHash.readBigInt64LE(0);
  console.log("program id", DEXXER_CORE_PROGRAM_ID.toBase58(), "-> task_id", taskId.toString());

  console.log("admin", admin.publicKey.toBase58());
  console.log("config", config.toBase58());
  const crankSigner = configBefore.schedulerSigner as { toBase58: () => string };
  console.log("Config.scheduler_signer (== crank account below)", crankSigner.toBase58());
  console.log("market", market.toBase58(), "market_risk", marketRisk.toBase58(), "pool", pool.toBase58(), "feed", feed.toBase58());

  if (crankSigner.toBase58() !== expectedCrankSigner.toBase58()) {
    console.error(
      `FAIL: Config.scheduler_signer (${crankSigner.toBase58()}) != crank_signer_pda(admin) (${expectedCrankSigner.toBase58()}). ` +
        "Run scripts/admin/set-scheduler-signer.ts first.",
    );
    process.exit(1);
  }

  const taskContext = admin.publicKey; // must NOT collide with config's address — see header comment

  const ix = await core.methods
    .scheduleCrank(new BN(taskId.toString()), new BN(INTERVAL_MS), new BN(ITERATIONS))
    .accounts({
      admin: admin.publicKey,
      config,
      market,
      marketRisk,
      pool,
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
      { pubkey: pool, isWritable: true, isSigner: false },
      { pubkey: feed, isWritable: false, isSigner: false },
    ])
    .instruction();

  const sig = await sendAndConfirmIx(conn, admin, ix);
  console.log("schedule_crank sig", sig, "task_id", taskId.toString());
}

main().catch((e) => {
  console.error("schedule-crank FAIL", e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
