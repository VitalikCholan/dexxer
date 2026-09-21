// scripts/admin/set-scheduler-signer.ts
//
// Task 6 fix round 3 (controller ruling): sets `Config.scheduler_signer` to
// `crank_signer_pda(admin)` via the new base-layer admin ix
// `set_scheduler_signer` — a plain `AdminConfig`-gated write, same pattern as
// `pause`/`unpause`. Runs on `baseConn`, NOT `teeConn`: `Config` is never
// delegated to the ER, so this is an ordinary L1 write with none of the
// `ScheduleCrankCpi`-specific "writable, non-delegated account" restriction
// fix round 2 hit twice (that restriction is scoped to that one CPI's
// `instruction_accounts`, not to base-layer instructions in general — see
// `programs/dexxer_core/src/instructions/admin.rs`'s `set_scheduler_signer`
// doc comment and week2-results.md §Task 6 for the full evidence trail).
//
// Run this ONCE before `schedule-crank.ts` (existing devnet Config; a fresh
// bootstrap already seeds the field correctly via `bootstrapDevnet()`'s
// `init_config` call — see `tests/er/lib/admin.ts`):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/set-scheduler-signer.ts

export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { NET, baseConn, loadOrCreateKey } = await import("../../tests/er/lib/env.js");
const { accountNs, dexxerCoreProgram, pdas } = await import("../../tests/er/lib/program.js");
const { crankSignerPda } = await import("../../tests/er/lib/crank-signer.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). Run: DEXXER_NET=devnet npx tsx scripts/admin/set-scheduler-signer.ts`);
  process.exit(1);
}

async function main(): Promise<void> {
  const admin = loadOrCreateKey("devnet-admin");
  const config = pdas.config();
  const core = dexxerCoreProgram(baseConn, admin);

  const newSchedulerSigner = crankSignerPda(admin.publicKey);
  console.log("admin", admin.publicKey.toBase58());
  console.log("config", config.toBase58());
  console.log("crank_signer_pda(admin) (new scheduler_signer)", newSchedulerSigner.toBase58());

  const before = await accountNs(core).config.fetch(config);
  console.log("Config.scheduler_signer before", (before.schedulerSigner as { toBase58: () => string }).toBase58());

  const sig = await core.methods
    .setSchedulerSigner(newSchedulerSigner)
    .accounts({ admin: admin.publicKey, config })
    .rpc();
  console.log("set_scheduler_signer sig", sig);

  const after = await accountNs(core).config.fetch(config);
  const afterKey = (after.schedulerSigner as { toBase58: () => string }).toBase58();
  console.log("Config.scheduler_signer after", afterKey);
  if (afterKey !== newSchedulerSigner.toBase58()) {
    console.error(`FAIL: Config.scheduler_signer (${afterKey}) != expected (${newSchedulerSigner.toBase58()})`);
    process.exit(1);
  }
  console.log("ok: Config.scheduler_signer == crank_signer_pda(admin), verified on-chain");
}

main().catch((e) => {
  console.error("set-scheduler-signer FAIL", e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
