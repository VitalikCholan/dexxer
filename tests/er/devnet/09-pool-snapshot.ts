// tests/er/devnet/09-pool-snapshot.ts
//
// Task 3, M-F: measures the private live aggregate (`PoolLive`) vs. the
// public step-rounded snapshot (`Pool`) end to end on real devnet +
// devnet-tee, after the week-4 PoolLive migration (Tasks 0-3).
//
// (a) `Pool` read on base AND on the ER (crank connection) before and after
//     an `open_position` call — unchanged (trading no longer writes `Pool`,
//     only `PoolLive` — see task-1-report.md).
// (b) `PoolLive` read via the crank TEE connection — `locked_total`
//     increased by the opened position's margin.
// (c) `PoolLive` read via a fresh, unrelated ("stranger") TEE connection —
//     access error or null (the TEE read-filter denies non-members) AND
//     the permission PDA is confirmed owned by the permission program
//     (positive proof, not just "the stranger read failed") — PASS
//     "M-F private live aggregate".
// (d) `commit_aggregate` (fee_payer-signed, matching 03/06/08) publishes a
//     step-rounded snapshot into the base-layer `Pool`: poll base for
//     `Pool.last_commit_slot` to advance (<=120s), then assert
//     `locked_total % 100_000_000 == 0 && locked_total >= live.locked_total
//     && capital_total <= live.capital_total` — PASS "M-F rounded snapshot".
// (e) `MarketRisk` read via the same stranger connection — access
//     error/null, same permission-PDA-owner confirmation as (c)
//     (permissioned by `init_market_permissions`, Task 2/3).
//
// Run: `npm run devnet:snapshot` (from tests/er). Requires
// `devnet-bootstrap.ts` to have run (PoolLive init/delegate +
// init_market_permissions — Task 3 migration).

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

import { readFileSync } from "fs";
import { resolve } from "path";

const { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, sleep } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { onboardTrader, openPosition, closePosition } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:snapshot`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC
const OPEN_SIZE_SOL = 1.0;
const OPEN_MARGIN_USD = 20;
const OPEN_LIMIT_USD = 1_000_000; // effectively "no slippage protection" for a Long open
const SNAPSHOT_STEP = 100_000_000n; // matches state/mod.rs SNAPSHOT_STEP
const COMMIT_POLL_MS = 120_000;

async function pollBaseCommitSlot(core: ReturnType<typeof dexxerCoreProgram>, pool: InstanceType<typeof import("@solana/web3.js").PublicKey>, prevSlot: bigint, timeoutMs = COMMIT_POLL_MS, delayMs = 2000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await accountNs(core).pool.fetch(pool);
    const slot = BigInt(p.lastCommitSlot.toString());
    if (slot > prevSlot) return slot;
    await sleep(delayMs);
  }
  throw new Error(`timeout (${timeoutMs}ms) waiting for base-layer Pool.last_commit_slot to advance past ${prevSlot}`);
}

/** Returns `null` on either a thrown fetch error or a genuinely-absent account — both count as "the TEE denied/filtered this read" for a non-member connection. Logs the caught error's name/message so a PASS is explainable (not just "something threw"). */
async function tryFetchPoolLive(core: ReturnType<typeof dexxerCoreProgram>, poolLive: InstanceType<typeof import("@solana/web3.js").PublicKey>): Promise<unknown | null> {
  try {
    return await accountNs(core).poolLive.fetch(poolLive);
  } catch (e) {
    console.log(`tryFetchPoolLive: caught ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return null;
  }
}

async function tryFetchMarketRisk(core: ReturnType<typeof dexxerCoreProgram>, marketRisk: InstanceType<typeof import("@solana/web3.js").PublicKey>): Promise<unknown | null> {
  try {
    return await accountNs(core).marketRisk.fetch(marketRisk);
  } catch (e) {
    console.log(`tryFetchMarketRisk: caught ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return null;
  }
}

/** Fetches the `EphemeralPermission` PDA for `account` via `conn` and reports whether it's owned by the permission program — the caller's positive confirmation that a permission genuinely exists (not just "the stranger read failed for some reason"). */
async function permissionPdaOwnedByProgram(
  conn: Awaited<ReturnType<typeof teeConn>>,
  label: string,
  account: InstanceType<typeof import("@solana/web3.js").PublicKey>,
): Promise<boolean> {
  const permission = permissionPdaFromAccount(account);
  const info = await conn.getAccountInfo(permission, "confirmed");
  const owner = info?.owner.toBase58() ?? "null";
  const owned = info !== null && info.owner.equals(PERMISSION_PROGRAM_ID);
  console.log(`permission PDA ${permission.toBase58()} (${label}) owner=${owner}`);
  return owned;
}

/**
 * `onboardTrader`'s own airdrop path (`baseConn.requestAirdrop`) confirms a
 * transaction but can deliver 0 lamports once the devnet faucet's rate
 * limit is exhausted for this session's IP — measured directly during this
 * script's own run (repeatable `TokenAccountNotFoundError` inside
 * `onboardTrader`'s `getOrCreateAssociatedTokenAccount` call, traced to a
 * genuinely-zero balance right after a "confirmed" airdrop). Pre-funding
 * from the well-funded deploy payer (`spikes/keys/payer.json`, devnet-only
 * SOL with no real value) sidesteps the faucet failure mode: even if
 * `onboardTrader`'s own `bal < 2_500_000_000` check still fires and its
 * airdrop silently delivers 0 lamports (as observed), the prefunded
 * balance is already there and unaffected. Fix round 1: lowered from 3 SOL
 * to 0.3 SOL — the prior run's actual spend across the whole M-F flow
 * (onboard + open + commit + close) was ~0.023 SOL, so 0.3 SOL is ample
 * headroom without parking multiple unswept SOL on a throwaway key.
 */
async function prefundFromPayer(recipient: InstanceType<typeof import("@solana/web3.js").PublicKey>, lamports: number): Promise<string> {
  const payerPath = resolve(process.cwd(), "..", "..", "spikes", "keys", "payer.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))));
  return sendAndConfirmTransaction(
    baseConn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports })),
    [payer],
    { commitment: "confirmed" },
  );
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const crank = loadOrCreateKey("devnet-crank");
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  const market = pdas.market();
  const marketRisk = pdas.marketRisk(market);

  const sigs: Record<string, string> = {};

  // === fresh trader: pre-fund (faucet rate-limited this session — see
  // prefundFromPayer's doc comment), then onboard + open ===
  const runId = Date.now();
  const traderName = `devnet-snapshot-${runId}`;
  const traderKp = loadOrCreateKey(traderName);
  const prefundSig = await prefundFromPayer(traderKp.publicKey, Math.round(0.3 * LAMPORTS_PER_SOL));
  sigs.prefundTrader = prefundSig;
  console.log("prefund trader (devnet payer -> trader, 0.3 SOL):", prefundSig);
  console.log("\n=== onboardTrader:", traderName, "===");
  const trader = await onboardTrader(boot, traderName, DEPOSIT);
  Object.assign(sigs, Object.fromEntries(Object.entries(trader.sigs).map(([k, v]) => [`onboard.${k}`, v])));

  const crankConn = await teeConn(crank);
  const crankCore = dexxerCoreProgram(crankConn, crank);
  const coreBase = dexxerCoreProgram(baseConn, boot.admin);

  // === (a) Pool on base AND ER (crank), BEFORE open ===
  console.log("\n=== (a) Pool on base + ER before open ===");
  const poolBaseBefore = await accountNs(coreBase).pool.fetch(boot.pool);
  const poolErBefore = await accountNs(crankCore).pool.fetch(boot.pool);
  console.log("Pool (base) before:", JSON.stringify({ capitalTotal: poolBaseBefore.capitalTotal.toString(), lockedTotal: poolBaseBefore.lockedTotal.toString(), lastCommitSlot: poolBaseBefore.lastCommitSlot.toString() }));
  console.log("Pool (ER) before:", JSON.stringify({ capitalTotal: poolErBefore.capitalTotal.toString(), lockedTotal: poolErBefore.lockedTotal.toString(), lastCommitSlot: poolErBefore.lastCommitSlot.toString() }));

  const poolLiveBefore = await accountNs(crankCore).poolLive.fetch(boot.poolLive);
  console.log("PoolLive (crank) before:", JSON.stringify({ capitalTotal: poolLiveBefore.capitalTotal.toString(), lockedTotal: poolLiveBefore.lockedTotal.toString() }));

  // === open position (margin = OPEN_MARGIN_USD dUSDC) ===
  console.log(`\n=== open_position (margin=${OPEN_MARGIN_USD} dUSDC) ===`);
  const openSig = await openPosition(boot, trader, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, OPEN_LIMIT_USD);
  sigs.openPosition = openSig;
  console.log("open_position (ER)", openSig);

  // === (a) Pool on base AND ER (crank), AFTER open — must be unchanged ===
  const poolBaseAfter = await accountNs(coreBase).pool.fetch(boot.pool);
  const poolErAfter = await accountNs(crankCore).pool.fetch(boot.pool);
  console.log("Pool (base) after:", JSON.stringify({ capitalTotal: poolBaseAfter.capitalTotal.toString(), lockedTotal: poolBaseAfter.lockedTotal.toString(), lastCommitSlot: poolBaseAfter.lastCommitSlot.toString() }));
  console.log("Pool (ER) after:", JSON.stringify({ capitalTotal: poolErAfter.capitalTotal.toString(), lockedTotal: poolErAfter.lockedTotal.toString(), lastCommitSlot: poolErAfter.lastCommitSlot.toString() }));
  const poolUnchangedBase =
    poolBaseBefore.lockedTotal.toString() === poolBaseAfter.lockedTotal.toString() &&
    poolBaseBefore.capitalTotal.toString() === poolBaseAfter.capitalTotal.toString() &&
    poolBaseBefore.lastCommitSlot.toString() === poolBaseAfter.lastCommitSlot.toString();
  const poolUnchangedEr =
    poolErBefore.lockedTotal.toString() === poolErAfter.lockedTotal.toString() &&
    poolErBefore.capitalTotal.toString() === poolErAfter.capitalTotal.toString() &&
    poolErBefore.lastCommitSlot.toString() === poolErAfter.lastCommitSlot.toString();
  assert(poolUnchangedBase, "(a) Pool unchanged on base after open_position");
  assert(poolUnchangedEr, "(a) Pool unchanged on ER (crank conn) after open_position");

  // === (b) PoolLive via crank connection — locked_total increased by margin ===
  console.log("\n=== (b) PoolLive (crank) after open ===");
  const poolLiveAfter = await accountNs(crankCore).poolLive.fetch(boot.poolLive);
  console.log("PoolLive (crank) after:", JSON.stringify({ capitalTotal: poolLiveAfter.capitalTotal.toString(), lockedTotal: poolLiveAfter.lockedTotal.toString() }));
  const lockedBefore = BigInt(poolLiveBefore.lockedTotal.toString());
  const lockedAfter = BigInt(poolLiveAfter.lockedTotal.toString());
  const marginLamports = BigInt(Math.round(OPEN_MARGIN_USD * 1_000_000));
  console.log(`locked_total: ${lockedBefore} -> ${lockedAfter} (delta ${lockedAfter - lockedBefore}, expected margin=${marginLamports})`);
  assert(lockedAfter === lockedBefore + marginLamports, "(b) PoolLive.locked_total increased by exactly the margin");

  // === (c) PoolLive via stranger connection — denied/null, AND the
  // permission PDA is genuinely owned by the permission program (positive
  // confirmation — a stranger read failing for an unrelated reason must
  // not count as PASS) ===
  console.log("\n=== (c) PoolLive via stranger TEE connection ===");
  const stranger = Keypair.generate();
  console.log("stranger:", stranger.publicKey.toBase58());
  const strangerConn = await teeConn(stranger);
  const strangerCore = dexxerCoreProgram(strangerConn, stranger);
  const strangerPoolLive = await tryFetchPoolLive(strangerCore, boot.poolLive);
  const poolLivePermissioned = await permissionPdaOwnedByProgram(crankConn, "poolLive", boot.poolLive);
  const cPass = strangerPoolLive === null && poolLivePermissioned;
  console.log(strangerPoolLive === null ? "stranger PoolLive read: denied/null (as expected)" : `stranger PoolLive read: UNEXPECTEDLY SUCCEEDED: ${JSON.stringify(strangerPoolLive)}`);
  console.log(cPass ? "PASS M-F private live aggregate" : "FAIL M-F private live aggregate");

  // === (d) commit_aggregate -> poll base Pool -> assert rounded snapshot ===
  console.log("\n=== (d) commit_aggregate -> rounded Pool snapshot ===");
  const feePayerConn = await teeConn(feePayer);
  const feePayerCore = dexxerCoreProgram(feePayerConn, feePayer);
  const cfg = await accountNs(feePayerCore).config.fetch(pdas.config());
  const poolBeforeCommit = await accountNs(coreBase).pool.fetch(boot.pool);
  const prevSlot = BigInt(poolBeforeCommit.lastCommitSlot.toString());
  const commitIx = await feePayerCore.methods
    .commitAggregate()
    .accounts({
      config: pdas.config(),
      payer: feePayer.publicKey,
      pool: boot.pool,
      poolLive: boot.poolLive,
      balancesRoot: boot.balancesRoot,
      feeEscrow: boot.feeEscrow,
      magicFeeVault: cfg.magicFeeVault,
      magicContext: MAGIC_CONTEXT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  const commitSig = await sendAndConfirmIx(feePayerConn, feePayer, commitIx);
  sigs.commitAggregate = commitSig;
  console.log("commit_aggregate (ER) sig:", commitSig);

  const newSlot = await pollBaseCommitSlot(coreBase, boot.pool, prevSlot);
  console.log(`base Pool.last_commit_slot: ${prevSlot} -> ${newSlot}`);

  const poolAfterCommit = await accountNs(coreBase).pool.fetch(boot.pool);
  const poolLiveAtCommit = await accountNs(crankCore).poolLive.fetch(boot.poolLive);
  const committedLocked = BigInt(poolAfterCommit.lockedTotal.toString());
  const committedCapital = BigInt(poolAfterCommit.capitalTotal.toString());
  const liveLocked = BigInt(poolLiveAtCommit.lockedTotal.toString());
  const liveCapital = BigInt(poolLiveAtCommit.capitalTotal.toString());
  console.log(
    `Pool (base, post-commit): locked_total=${committedLocked} capital_total=${committedCapital}; PoolLive (crank): locked_total=${liveLocked} capital_total=${liveCapital}`,
  );
  const roundedOk = committedLocked % SNAPSHOT_STEP === 0n;
  const lockedOk = committedLocked >= liveLocked;
  const capitalOk = committedCapital <= liveCapital;
  console.log(`rounded: ${roundedOk}, locked>=live: ${lockedOk}, capital<=live: ${capitalOk}`);
  const dPass = roundedOk && lockedOk && capitalOk;
  console.log(dPass ? "PASS M-F rounded snapshot" : "FAIL M-F rounded snapshot");
  assert(dPass, "(d) rounded snapshot invariants hold");

  // === (e) MarketRisk via stranger connection — denied/null, AND the
  // permission PDA is genuinely owned by the permission program ===
  console.log("\n=== (e) MarketRisk via stranger TEE connection ===");
  const strangerMarketRisk = await tryFetchMarketRisk(strangerCore, marketRisk);
  const marketRiskPermissioned = await permissionPdaOwnedByProgram(crankConn, "marketRisk", marketRisk);
  const ePass = strangerMarketRisk === null && marketRiskPermissioned;
  console.log(strangerMarketRisk === null ? "stranger MarketRisk read: denied/null (as expected)" : `stranger MarketRisk read: UNEXPECTEDLY SUCCEEDED: ${JSON.stringify(strangerMarketRisk)}`);
  console.log(ePass ? "PASS M-F MarketRisk private" : "FAIL M-F MarketRisk private (informational — MarketRisk permissioning is Task 2/3 scope, not a hard M-F requirement)");

  // === cleanup: close the position ===
  console.log("\n=== close_position (cleanup) ===");
  const closeSig = await closePosition(boot, trader, 0);
  sigs.closePosition = closeSig;
  console.log("close_position (ER)", closeSig);

  console.log("\n=== signatures ===");
  console.log(JSON.stringify(sigs, null, 2));

  const overall = poolUnchangedBase && poolUnchangedEr && cPass && dPass;
  console.log(overall ? "\n09-POOL-SNAPSHOT PASS" : "\n09-POOL-SNAPSHOT FAIL");
  if (!overall) process.exit(1);
}

main().catch((e) => {
  console.error("09-pool-snapshot FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
