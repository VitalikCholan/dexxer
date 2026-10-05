// scripts/admin/cancel-crank.ts
//
// Task 6 fix round 3: exercise `cancel_crank` for real (weeks0-5-history.md#week-2
// Task 1's task-context finding left `CancelCrankCpi`'s account requirements
// UNMEASURED — no `schedule_crank` call had ever succeeded to cancel). Stops
// the Magic Actions task registered by `schedule-crank.ts`.
//
// `task_id`: computed the same deterministic way `schedule-crank.ts` does
// (first 8 bytes of SHA-256(program id), little-endian i64) — NOT read from
// `Config.crank_task_id` (task-6 fix round 3: that field can no longer be
// written on-chain at all, see `programs/dexxer_core/src/instructions/crank.rs`'s
// `ScheduleCrank.config` doc comment, so `cancel_crank` now takes `task_id`
// as an explicit argument instead).
//
// `task_context`: same value `schedule-crank.ts` passed at registration time
// — `admin.publicKey` (task-6 fix round 3; NOT `config`'s address, which
// collides with the separately-passed read-only `config` slot and gets
// rejected — see `schedule-crank.ts`'s header comment for the full
// evidence). `CancelCrankCpi` needs the SAME task-context account the task
// was scheduled with, not an arbitrary one (unlike `schedule_crank`, which
// registers a fresh task and could in principle take any consistent account
// per Task 1's finding, `cancel_crank` targets an EXISTING task by
// `crank_id`, so passing a different task_context here is untested and not
// assumed safe).
//
// Run: cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/cancel-crank.ts

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
const { DEXXER_CORE_PROGRAM_ID, dexxerCoreProgram, pdas } = await import("../../tests/er/lib/program.js");
const { MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). Run: DEXXER_NET=devnet npx tsx scripts/admin/cancel-crank.ts`);
  process.exit(1);
}

async function main(): Promise<void> {
  const admin = loadOrCreateKey("devnet-admin");
  const config = pdas.config();

  const programHash = createHash("sha256").update(DEXXER_CORE_PROGRAM_ID.toBuffer()).digest();
  const taskId = programHash.readBigInt64LE(0);
  console.log("task_id", taskId.toString());

  const conn = await teeConn(admin);
  const core = dexxerCoreProgram(conn, admin);

  console.log("admin", admin.publicKey.toBase58());
  console.log("config", config.toBase58());

  const taskContext = admin.publicKey; // same value schedule-crank.ts registered with (task-6 fix round 3)

  const ix = await core.methods
    .cancelCrank(new BN(taskId.toString()))
    .accounts({ admin: admin.publicKey, config, taskContext, magicProgram: MAGIC_PROGRAM_ID })
    .instruction();

  const sig = await sendAndConfirmIx(conn, admin, ix);
  console.log("cancel_crank sig", sig, "task_id", taskId.toString());
}

main().catch((e) => {
  console.error("cancel-crank FAIL", e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
