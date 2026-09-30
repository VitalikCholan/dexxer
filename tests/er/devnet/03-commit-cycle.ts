// tests/er/devnet/03-commit-cycle.ts
//
// Task 5, script 3 of 4: `commit_aggregate` x12, >=5s apart, transaction
// signed by `Config.fee_payer` via a TEE-authenticated connection — proving
// the fee-vault-scoped commit path crosses M3's plain-commit limit of 10
// (week2-results.md §Task 1). After each commit, polls base-layer `Pool`
// until `last_commit_slot` propagates; records the `FeeEscrow` PDA's ER
// lamport balance before/after every commit — the real per-commit cost
// measurement M3 could not pin, and the first attempt at this script
// couldn't either (the fee-vault path never activated — see task-5-report.md
// "fix round 1"). This settles decision (c). Asserts `Positions`/`UserAccount`
// on base layer are unchanged throughout (`commit_aggregate` commits `Pool`
// and `BalancesRoot` — week 3, Task 5/6 — never a raw private account).
//
// Task 5 fix round 1 (controller ruling): `commit_aggregate`'s CPI intent
// payer is now the dedicated, delegated `FeeEscrow` PDA (not `Config.fee_payer`
// — a plain wallet can never satisfy the fee-vault path's "delegated, signs
// via seeds" requirement; see programs/dexxer_core/src/instructions/commit.rs).
// `payer` (`Config.fee_payer`, still `devnet-fee-payer`) remains the outer
// transaction's signer/authorizer only.
//
// Run: `npm run devnet:commit` (from tests/er). Requires 01 to have run at
// least once (uses its persisted owner/positions/userAccount for the
// unchanged-on-base assertion), `devnet-bootstrap.ts` to have created +
// delegated `FeeEscrow`, and `fund-fee-payer.ts` to have topped it up.

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { PublicKey } = await import("@solana/web3.js");
const { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, sleep } = envMod;
const { accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");
const { bootstrapDevnet, MAGIC_FEE_VAULT } = await import("../lib/admin.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:commit`);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_POINTER_PATH = resolve(HERE, "..", ".keys", "devnet-run-latest.json");
const NUM_COMMITS = 12;
const MIN_INTERVAL_MS = 5_000;

interface RunState {
  owner: string;
  positions: string;
  userAccount: string;
}

async function pollBaseCommitSlot(pool: InstanceType<typeof PublicKey>, prevSlot: bigint, tries = 60, delayMs = 1000): Promise<bigint> {
  const coreBase = dexxerCoreProgram(baseConn, loadOrCreateKey("devnet-admin"));
  for (let i = 0; i < tries; i++) {
    const p = await accountNs(coreBase).pool.fetch(pool);
    const slot = BigInt(p.lastCommitSlot.toString());
    if (slot > prevSlot) return slot;
    await sleep(delayMs);
  }
  throw new Error(`timeout waiting for base-layer Pool.last_commit_slot to advance past ${prevSlot}`);
}

async function main() {
  const run: RunState = JSON.parse(readFileSync(RUN_POINTER_PATH, "utf8"));
  console.log("loaded run state:", RUN_POINTER_PATH);

  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  console.log("fee-payer (Config.fee_payer, tx signer only):", feePayer.publicKey.toBase58());
  console.log("fee-escrow (CPI intent payer):", boot.feeEscrow.toBase58());
  console.log("magic_fee_vault (Config.magic_fee_vault):", MAGIC_FEE_VAULT.toBase58());

  const feePayerBaseBal = await baseConn.getBalance(feePayer.publicKey, "confirmed");
  console.log("fee-payer base SOL balance:", feePayerBaseBal / 1e9, "SOL");

  const feePayerConn = await teeConn(feePayer);
  const core = dexxerCoreProgram(feePayerConn, feePayer);
  const config = pdas.config();

  const escrowInfo = await baseConn.getAccountInfo(boot.feeEscrow, "confirmed");
  const { DELEGATION_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
  if (!escrowInfo || !escrowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.error(`FAIL: fee-escrow is not delegated (owner=${escrowInfo?.owner.toBase58() ?? "null"}). Re-run devnet-bootstrap.ts.`);
    process.exit(1);
  }

  const position = new PublicKey(run.positions);
  const userAccount = new PublicKey(run.userAccount);
  const positionBefore = await baseConn.getAccountInfo(position, "confirmed");
  const userAccountBefore = await baseConn.getAccountInfo(userAccount, "confirmed");

  const poolBefore = await accountNs(core).pool.fetch(boot.pool);
  let lastSlot = BigInt(poolBefore.lastCommitSlot.toString());
  console.log("Pool.last_commit_slot before cycle:", lastSlot.toString());

  const results: { i: number; ok: boolean; sig?: string; err?: string; escrowBefore: number; escrowAfter: number; baseSlot?: string }[] = [];

  for (let i = 1; i <= NUM_COMMITS; i++) {
    const escrowBefore = await feePayerConn.getBalance(boot.feeEscrow, "confirmed").catch(() => -1);
    try {
      const ix = await core.methods
        .commitAggregate()
        .accounts({
          config,
          payer: feePayer.publicKey,
          pool: boot.pool,
          // week-4 Task 1: `CommitAggregate` reads `PoolLive` (read-only) to
          // publish the step-rounded `Pool` snapshot.
          poolLive: boot.poolLive,
          // Task 5 added `balances_root` to `CommitAggregate` (commit.rs) —
          // required by the IDL since then; this script predates that change
          // (task-7 fix round 1, week 3).
          balancesRoot: pdas.balancesRoot(),
          feeEscrow: boot.feeEscrow,
          magicFeeVault: MAGIC_FEE_VAULT,
          magicContext: MAGIC_CONTEXT_ID,
          magicProgram: MAGIC_PROGRAM_ID,
        })
        .instruction();
      const sig = await sendAndConfirmIx(feePayerConn, feePayer, ix);
      const escrowAfter = await feePayerConn.getBalance(boot.feeEscrow, "confirmed").catch(() => -1);
      console.log(
        `commit #${i}: OK sig=${sig} escrow balance ${escrowBefore} -> ${escrowAfter} (delta ${escrowBefore >= 0 && escrowAfter >= 0 ? escrowAfter - escrowBefore : "n/a"})`,
      );
      const newSlot = await pollBaseCommitSlot(boot.pool, lastSlot);
      console.log(`  base Pool.last_commit_slot propagated: ${lastSlot} -> ${newSlot}`);
      lastSlot = newSlot;
      results.push({ i, ok: true, sig, escrowBefore, escrowAfter, baseSlot: newSlot.toString() });
    } catch (e: any) {
      const escrowAfter = await feePayerConn.getBalance(boot.feeEscrow, "confirmed").catch(() => -1);
      const msg = e?.message ?? String(e);
      console.log(`commit #${i}: FAILED — ${msg}`);
      if (e?.logs) console.log("  logs:", e.logs);
      results.push({ i, ok: false, err: msg, escrowBefore, escrowAfter });
      if (i === NUM_COMMITS) break; // still record the last attempt's evidence, then stop
      // Keep going is pointless once the mechanism has failed once — but per
      // the task's "timebox" rule, try up to a couple more before giving up
      // entirely, in case of one-off devnet flakiness rather than a
      // structural limit.
      if (results.filter((r) => !r.ok).length >= 3) {
        console.log("3 consecutive/total failures — stopping the cycle early (see results below).");
        break;
      }
    }
    if (i < NUM_COMMITS) await sleep(MIN_INTERVAL_MS);
  }

  const positionAfter = await baseConn.getAccountInfo(position, "confirmed");
  const userAccountAfter = await baseConn.getAccountInfo(userAccount, "confirmed");
  const positionUnchanged = Buffer.compare(positionBefore?.data ?? Buffer.alloc(0), positionAfter?.data ?? Buffer.alloc(0)) === 0;
  const userAccountUnchanged = Buffer.compare(userAccountBefore?.data ?? Buffer.alloc(0), userAccountAfter?.data ?? Buffer.alloc(0)) === 0;

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(
      `#${r.i}: ${r.ok ? "OK" : "FAIL"} escrow ${r.escrowBefore}->${r.escrowAfter} (delta ${r.escrowBefore >= 0 && r.escrowAfter >= 0 ? r.escrowAfter - r.escrowBefore : "n/a"})${r.sig ? ` sig=${r.sig}` : ""}${r.err ? ` err=${r.err.slice(0, 150)}` : ""}`,
    );
  }
  console.log("Positions unchanged on base:", positionUnchanged);
  console.log("UserAccount unchanged on base:", userAccountUnchanged);

  const succeeded = results.filter((r) => r.ok).length;
  const twelfthOk = results.length === NUM_COMMITS && results[NUM_COMMITS - 1].ok;
  const pass = twelfthOk && positionUnchanged && userAccountUnchanged;
  console.log(`\nsucceeded=${succeeded}/${NUM_COMMITS}, 12th OK=${twelfthOk}`);
  console.log(pass ? "03-COMMIT-CYCLE PASS" : "03-COMMIT-CYCLE FAIL");
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error("03-commit-cycle FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
