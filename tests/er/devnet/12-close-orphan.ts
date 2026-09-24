// tests/er/devnet/12-close-orphan.ts
//
// Week-5 Task 5, part A proof: the second program upgrade fixes the orphan
// signal `close_orphan_queue` reads.
//
// Task 4 measured (§Task 4 (c) of week5-results.md) that after a partial
// `undelegate_user` the TEE keeps serving the BASE clone of the departed
// `UserAccount` — present, owned by `dexxer_core`, `exited = true` — so the
// old signal (`data_is_empty() || owner != crate::ID`) was permanently false
// and a real crank call failed `Custom 6042 NotExited`. Task 4 deliberately
// left the drained orphan queue `DDe6rX…` on devnet as the test case; this
// script closes it end to end on the upgraded program:
//
//   1. `close_orphan_queue` as the crank, inside the ER. The queue is scrubbed
//      and handed back to L1 by `commit_and_undelegate`.
//   2. wait for the undelegation to land on base (`owner == dexxer_core`).
//   3. `close_exited_user` as `Config.fee_payer`, on base: the rent of all
//      three PDAs (`UserAccount`/`Position`/`DisclosureQueue`) comes back.
//
// Run: `DEXXER_NET=devnet npm run devnet:orphan` (from tests/er).
// `ORPHAN_OWNER=<pubkey>` picks a different exited owner; the default is the
// Task-4 leftover. Every step is skip-if-already-done, so a re-run on an
// already-reclaimed owner is a no-op that still reports.

export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const {
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn } = envMod;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:orphan`);
  process.exit(1);
}

// Task 4's leftover: trader `8ZsNG1s…`, queue `DDe6rX…` (`len = 0`, drained).
const DEFAULT_OWNER = "8ZsNG1s1anFhA5ubZM978x4qRYwXwhf7jCoYhmx7Qe5E";
const UNDELEGATION_POLL_MS = 120_000;

async function main() {
  const owner = new PublicKey(process.env.ORPHAN_OWNER ?? DEFAULT_OWNER);
  const crank = loadOrCreateKey("devnet-crank");
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  const crankConn = await teeConn(crank);
  const base = baseConn;
  const crankCore = dexxerCoreProgram(crankConn, crank);
  const feePayerCore = dexxerCoreProgram(base, feePayer);

  const config = pdas.config();
  const market = pdas.market();
  const userAccount = pdas.userAccount(owner);
  const position = pdas.position(owner, market);
  const dq = pdas.disclosureQueue(owner);
  const cfg = await accountNs(feePayerCore).config.fetch(config);
  const out: Record<string, unknown> = { owner: owner.toBase58(), dq: dq.toBase58() };
  console.log("owner:", owner.toBase58(), "\nDisclosureQueue:", dq.toBase58());

  // --- 1. close_orphan_queue (crank, ER) ---------------------------------
  const dqBefore = await crankConn.getAccountInfo(dq, "confirmed");
  if (!dqBefore) {
    console.log("(1) skipped: the queue is not in the ER any more (already closed or never delegated)");
    out.closeOrphanQueue = "skipped";
  } else {
    const q = await accountNs(crankCore).disclosureQueue.fetch(dq);
    out.queueLen = q.len;
    console.log("(1) queue len =", q.len, "owner of the ER clone =", dqBefore.owner.toBase58());
    if (q.len !== 0) throw new Error(`the queue still owes L1 ${q.len} reveal(s) — drain it first`);
    const ix = await crankCore.methods
      .closeOrphanQueue()
      .accounts({
        crank: crank.publicKey,
        config,
        dq,
        userAccount,
        dqPermission: permissionPdaFromAccount(dq),
        ephemeralVault: EPHEMERAL_VAULT_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
        feeEscrow: pdas.feeEscrow(),
        magicFeeVault: cfg.magicFeeVault,
        magicContext: MAGIC_CONTEXT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    const sig = await sendAndConfirmIx(crankConn, crank, ix);
    out.closeOrphanQueueSig = sig;
    console.log("(1) close_orphan_queue OK:", sig);
  }

  // --- 2. wait for the undelegation to land on base ----------------------
  const deadline = Date.now() + UNDELEGATION_POLL_MS;
  let backHome = false;
  for (;;) {
    const info = await base.getAccountInfo(dq, "confirmed");
    if (info && info.owner.equals(DEXXER_CORE_PROGRAM_ID)) {
      backHome = true;
      break;
    }
    if (!info) {
      console.log("(2) the queue is already gone from base — nothing left to reclaim");
      break;
    }
    if (Date.now() > deadline) {
      console.log("(2) TIMEOUT: base still shows the queue owned by", info.owner.toBase58());
      break;
    }
    await sleep(3000);
  }
  out.queueUndelegated = backHome;
  if (!backHome) {
    console.log("12-CLOSE-ORPHAN PARTIAL", JSON.stringify(out));
    return;
  }
  console.log("(2) the queue is back under dexxer_core on base");

  // --- 3. close_exited_user (fee_payer, base) ----------------------------
  const before = await base.getBalance(feePayer.publicKey, "confirmed");
  const ix = await feePayerCore.methods
    .closeExitedUser()
    .accounts({ feePayer: feePayer.publicKey, config, userAccount, position, dq })
    .instruction();
  const sig = await sendAndConfirmIx(base, feePayer, ix);
  const after = await base.getBalance(feePayer.publicKey, "confirmed");
  out.closeExitedUserSig = sig;
  out.feePayerRentReclaimedSol = (after - before) / LAMPORTS_PER_SOL;
  console.log("(3) close_exited_user OK:", sig);
  console.log("    fee_payer delta:", (after - before) / LAMPORTS_PER_SOL, "SOL (rent of three PDAs minus the fee)");
  for (const [name, key] of [["UserAccount", userAccount], ["Position", position], ["DisclosureQueue", dq]] as const) {
    const info = await base.getAccountInfo(key, "confirmed");
    console.log(`    ${name}:`, info ? `STILL PRESENT (${info.owner.toBase58()})` : "closed");
    if (info) throw new Error(`${name} survived close_exited_user`);
  }
  console.log("\n12-CLOSE-ORPHAN PASS", JSON.stringify(out));
}

main().catch((e) => {
  console.error("12-close-orphan FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
