// tests/er/devnet/14-close-reopen.ts
//
// Week-5 Task 7:
//
//   M-H (inline, part A below) — `set_disclosure_delay(0)` (the admin ix
//   Task 5 shipped but never called on devnet) + the live relayer's
//   `COMMIT_INTERVAL_TICKS=60` (already on Railway): open+close a fresh
//   trader, then time Close -> a real L1 `Disclosure` account, relying on
//   the LIVE relayer's own disclosure cycle (no manual `commit_aggregate`
//   here, unlike 06/08 — this measures the deployed service end to end).
//
//   M-J (part B) — `open -> close -> open` in the very next tx on the same
//   trader (week-5 Task 1: a close frees `Position` to `Empty` on the spot,
//   so nothing should block an immediate reopen), then a SEPARATE trader
//   loops 8x (open+close) to fill `DisclosureQueue` (`DQ_CAPACITY = 8`,
//   `state/disclosure.rs`) and proves the 9th close hits `QueueFull`
//   (error 6023) — then recovers once the queue frees a slot.
//
// `disclosure_delay_slots` is per-record, stamped into `ClosedRecord.
// reveal_after_slot` AT CLOSE TIME from whatever `Config.disclosure_delay_
// slots` was then (`finalize_close`, week-5 Task 1/3) — restoring the admin
// config value does NOT retroactively change already-queued records. So the
// overflow test deliberately sets a LARGE delay (`OVERFLOW_DELAY_SLOTS`)
// before the 8-close loop (guarantees none of the 8 records are due before
// the loop and the 9th-close attempt finish, regardless of how long the
// live relayer's disclosure cycle takes to notice them at delay 0), then
// restores 0 for cleanliness — the actual unblock the script waits on is
// simply real ER-slot time catching up to the FIRST queued record's own
// `reveal_after_slot`, then one relayer disclosure cycle (<=60s) to reveal
// and pop it.
//
// Run: `npm run devnet:reopen` (from tests/er).

export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { randomBytes } = await import("crypto");
const { BN } = await import("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const { DELEGATION_PROGRAM_ID, delegateSpl } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sleep, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas, commitmentHash, sideIndex, reasonIndex } = await import(
  "../lib/program.js"
);
const { bootstrapDevnet, setDisclosureDelay } = await import("../lib/admin.js");
const { creditDeposit, initPermissions, openPosition, closePosition } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:reopen`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC
// 05/06's proven sizing: 1.0 SOL notional (~$114 at current mark) against
// $20 margin (~5.7x). A smaller size was tried first and failed InvalidInput
// (math.rs: margin > notional has no liquidation price, since 0.1 SOL's
// ~$11.4 notional was BELOW the $20 margin — leverage under 1x).
const OPEN_SIZE_SOL = 1.0;
const OPEN_MARGIN_USD = 20;
const TRADER_FUND_SOL = 0.05;
// See the file header: large enough to outlast the 8-close loop plus the
// 9th-close QueueFull attempt (measured: see the report), stamped once per
// close and NOT retroactively changed by restoring Config afterward.
const OVERFLOW_DELAY_SLOTS = 12_000n; // ~150s at the ER's measured ~80 slots/s
const MH_DISCLOSURE_POLL_MS = 100_000; // brief: expect <=~70s; generous margin
const OVERFLOW_DRAIN_POLL_MS = 360_000; // 6 min ceiling on the recovery wait

async function onboardManual(boot: Awaited<ReturnType<typeof bootstrapDevnet>>, name: string) {
  const admin = loadOrCreateKey("devnet-admin");
  const owner = loadOrCreateKey(name);
  const fundSig = await sendAndConfirmTransaction(
    baseConn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: TRADER_FUND_SOL * LAMPORTS_PER_SOL })),
    [admin],
    { commitment: "confirmed" },
  );
  console.log(`funded ${name} ${TRADER_FUND_SOL} SOL from devnet-admin:`, fundSig);

  const core = dexxerCoreProgram(baseConn, owner);
  const config = pdas.config();
  const market = pdas.market();
  const userAccount = pdas.userAccount(owner.publicKey);
  const position = pdas.position(owner.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(owner.publicKey);
  const faucetPda = pdas.faucet(owner.publicKey);
  const mintAuth = pdas.mintAuth();
  const ownerAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);

  await getOrCreateAssociatedTokenAccount(baseConn, owner, boot.mint, owner.publicKey);
  const faucetSig = await core.methods
    .faucetInit(new BN(DEPOSIT.toString()))
    .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, faucet: faucetPda, dusdcMint: boot.mint, mintAuth, ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  const exitSalt = new Uint8Array(randomBytes(32));
  const initUserSig = await core.methods
    .initUser(Array.from(exitSalt))
    .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`${name}: faucet_init`, faucetSig, "init_user", initUserSig);

  const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { validator: envMod.ER_VALIDATOR, initVaultIfMissing: false, idempotent: false });
  const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateSplIxs), [owner], { commitment: "confirmed" });
  const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
  const pt = delegationTriple(position, DEXXER_CORE_PROGRAM_ID);
  const dt = delegationTriple(disclosureQueue, DEXXER_CORE_PROGRAM_ID);
  const delegateUserSig = await core.methods
    .delegateUser()
    .accounts({
      owner: owner.publicKey, payer: owner.publicKey, config, market,
      bufferUserAccount: ut.buffer, delegationRecordUserAccount: ut.record, delegationMetadataUserAccount: ut.metadata, userAccount,
      bufferPosition: pt.buffer, delegationRecordPosition: pt.record, delegationMetadataPosition: pt.metadata, position,
      bufferDisclosureQueue: dt.buffer, delegationRecordDisclosureQueue: dt.record, delegationMetadataDisclosureQueue: dt.metadata, disclosureQueue,
      ownerProgram: DEXXER_CORE_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`${name}: delegateSpl`, delegateSplSig, "delegate_user", delegateUserSig);
  await waitDelegated(baseConn, userAccount, `${name} UserAccount`);
  await waitDelegated(baseConn, position, `${name} Position`);
  await waitDelegated(baseConn, disclosureQueue, `${name} DisclosureQueue`);

  const traderCtx = { name, kp: owner, userAccount, position, disclosureQueue, userAta: ownerAta, exitSalt, sigs: {} as Record<string, string>, creditDepositCU: null as number | null };
  const creditSig = await creditDeposit(boot, traderCtx, DEPOSIT);
  const initPermSig = await initPermissions(traderCtx);
  console.log(`${name}: credit_deposit`, creditSig, "init_permissions", initPermSig);

  return traderCtx;
}

function recToArgs(rec: any) {
  return {
    args: {
      market: new PublicKey(rec.market),
      side: sideIndex(rec.side),
      size: BigInt(rec.size.toString()),
      entry: BigInt(rec.entry.toString()),
      exit: BigInt(rec.exit.toString()),
      pnl: BigInt(rec.pnl.toString()),
      fees: BigInt(rec.fees.toString()),
      reason: reasonIndex(rec.reason),
      openedSlot: BigInt(rec.openedSlot.toString()),
      closedSlot: BigInt(rec.closedSlot.toString()),
      nonce: BigInt(rec.nonce.toString()),
      revealAfterSlot: BigInt(rec.revealAfterSlot.toString()),
    },
    salt: Uint8Array.from(rec.salt as number[]),
  };
}

/** True if `msg` names custom error `code` (a `sendAndConfirmIx`-thrown `InstructionError` string, or an Anchor `.rpc()` error). */
function isCustomError(msg: string, code: number): boolean {
  return msg.includes(`"Custom":${code}`) || msg.includes(`Custom(${code})`) || msg.includes(`custom program error: 0x${code.toString(16)}`);
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const admin = loadOrCreateKey("devnet-admin");
  const config = pdas.config();
  const coreBaseAdmin = dexxerCoreProgram(baseConn, admin);

  const out: Record<string, unknown> = {};

  // =====================================================================
  // M-H: set_disclosure_delay(0), fresh trader, Close -> L1 Disclosure via
  // the LIVE relayer's own COMMIT_INTERVAL_TICKS=60 cycle.
  // =====================================================================
  console.log("\n\n########## M-H: disclosure_delay=0, one-cycle reveal via the live relayer ##########");
  const delayBefore = (await accountNs(coreBaseAdmin).config.fetch(config)).disclosureDelaySlots.toString();
  console.log("Config.disclosure_delay_slots before:", delayBefore);
  const setDelay0Sig = await setDisclosureDelay(admin, 0n);
  console.log("set_disclosure_delay(0)", setDelay0Sig);
  out.mhSetDelay0Sig = setDelay0Sig;

  const runId = Date.now();
  const mh = await onboardManual(boot, `devnet-mh-${runId}`);
  const mhOpenSig = await openPosition(boot, mh, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, 1_000_000);
  console.log("M-H open_position", mhOpenSig);
  const ownerConnMh = await teeConn(mh.kp);
  const coreOwnerMh = dexxerCoreProgram(ownerConnMh, mh.kp);
  const posBeforeClose = await accountNs(coreOwnerMh).position.fetch(mh.position);
  assert("open" in posBeforeClose.state, "M-H position Open before close");

  const tClose = Date.now();
  const mhCloseSig = await closePosition(boot, mh, 0);
  const tCloseDone = Date.now();
  console.log(`M-H close_position ${mhCloseSig} (send+confirm took ${((tCloseDone - tClose) / 1000).toFixed(1)}s)`);
  out.mhCloseSig = mhCloseSig;
  out.mhCloseSendMs = tCloseDone - tClose;

  const dqAfterClose = await accountNs(coreOwnerMh).disclosureQueue.fetch(mh.disclosureQueue);
  assert(dqAfterClose.len === 1, `M-H DisclosureQueue.len == 1 after close (got ${dqAfterClose.len})`);
  const rec = dqAfterClose.records[dqAfterClose.head];
  const { args, salt } = recToArgs(rec);
  const hash = commitmentHash(args, salt);
  const commitmentPda = pdas.commitment(hash);
  const disclosurePda = pdas.disclosure(hash);
  console.log("Commitment PDA:", commitmentPda.toBase58(), "Disclosure PDA:", disclosurePda.toBase58(), "revealAfterSlot (ER):", args.revealAfterSlot.toString());
  out.mhCommitmentPda = commitmentPda.toBase58();
  out.mhDisclosurePda = disclosurePda.toBase58();

  console.log(`\n=== M-H: polling L1 for Disclosure[hash] via the LIVE relayer (<=${MH_DISCLOSURE_POLL_MS / 1000}s, no manual commit_aggregate) ===`);
  let mhLanded = false;
  const mhDeadline = Date.now() + MH_DISCLOSURE_POLL_MS;
  while (Date.now() < mhDeadline) {
    const info = await baseConn.getAccountInfo(disclosurePda, "confirmed");
    if (info) {
      mhLanded = true;
      break;
    }
    await sleep(3000);
  }
  const mhElapsedS = (Date.now() - tClose) / 1000;
  out.mhCloseToDisclosureSeconds = mhElapsedS;
  out.mhLanded = mhLanded;
  console.log(mhLanded ? `M-H: Disclosure landed on L1 ${mhElapsedS.toFixed(1)}s after the Close tx was sent (relayer-driven)` : `M-H FAIL: Disclosure did NOT land within ${MH_DISCLOSURE_POLL_MS / 1000}s`);
  const dqAfterMh = await accountNs(coreOwnerMh).disclosureQueue.fetch(mh.disclosureQueue);
  out.mhDqLenAfter = dqAfterMh.len;
  console.log("M-H DisclosureQueue.len after:", dqAfterMh.len, "(0 expected once the relayer's bundle popped it)");

  // =====================================================================
  // M-J part 1: open -> close -> open in the immediately next tx.
  // =====================================================================
  console.log("\n\n########## M-J part 1: open -> close -> open (same trader, no wait) ##########");
  const reopen = await onboardManual(boot, `devnet-reopen-${runId}`);
  const r1OpenSig = await openPosition(boot, reopen, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, 1_000_000);
  console.log("open #1", r1OpenSig);
  const r1CloseSig = await closePosition(boot, reopen, 0);
  console.log("close #1", r1CloseSig);
  const ownerConnReopen = await teeConn(reopen.kp);
  const coreOwnerReopen = dexxerCoreProgram(ownerConnReopen, reopen.kp);
  const posAfterClose1 = await accountNs(coreOwnerReopen).position.fetch(reopen.position);
  assert("empty" in posAfterClose1.state, "M-J: Position Empty immediately after close #1 (no wait)");
  const tReopen = Date.now();
  const r2OpenSig = await openPosition(boot, reopen, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, 1_000_000);
  const tReopenDone = Date.now();
  console.log(`open #2 (reopen, immediately next tx) ${r2OpenSig} — took ${((tReopenDone - tReopen) / 1000).toFixed(1)}s, no extra wait`);
  const posAfterReopen = await accountNs(coreOwnerReopen).position.fetch(reopen.position);
  assert("open" in posAfterReopen.state, "M-J: Position Open again after the immediate reopen — PASS");
  out.mjReopenPass = true;
  out.mjReopenOpen1Sig = r1OpenSig;
  out.mjReopenClose1Sig = r1CloseSig;
  out.mjReopenOpen2Sig = r2OpenSig;
  // leave it open — cheap to leave a single open position on a throwaway trader; not touched further.

  // =====================================================================
  // M-J part 2: 8x (open+close) on a fresh trader fills the queue; the
  // 9th close hits QueueFull; recovery once a slot frees up.
  // =====================================================================
  console.log("\n\n########## M-J part 2: fill DisclosureQueue to DQ_CAPACITY=8, 9th close -> QueueFull, recover ##########");
  console.log(`set_disclosure_delay(${OVERFLOW_DELAY_SLOTS}) — large, so none of the 8 records are due before the loop + 9th attempt finish`);
  const setDelayBigSig = await setDisclosureDelay(admin, OVERFLOW_DELAY_SLOTS);
  console.log("set_disclosure_delay(big)", setDelayBigSig);
  out.overflowSetDelayBigSig = setDelayBigSig;

  const overflow = await onboardManual(boot, `devnet-overflow-${runId}`);
  const ownerConnOverflow = await teeConn(overflow.kp);
  const coreOwnerOverflow = dexxerCoreProgram(ownerConnOverflow, overflow.kp);

  const loopSigs: { open: string; close: string }[] = [];
  const tLoopStart = Date.now();
  for (let i = 1; i <= 8; i++) {
    const openSig = await openPosition(boot, overflow, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, 1_000_000);
    const closeSig = await closePosition(boot, overflow, 0);
    loopSigs.push({ open: openSig, close: closeSig });
    const dq = await accountNs(coreOwnerOverflow).disclosureQueue.fetch(overflow.disclosureQueue);
    console.log(`close #${i}: open=${openSig} close=${closeSig} dq.len=${dq.len}`);
    assert(dq.len === i, `DisclosureQueue.len == ${i} after close #${i} (got ${dq.len})`);
  }
  const tLoopDone = Date.now();
  console.log(`8-close loop took ${((tLoopDone - tLoopStart) / 1000).toFixed(1)}s`);
  out.overflowLoopSigs = loopSigs;
  out.overflowLoopSeconds = (tLoopDone - tLoopStart) / 1000;

  console.log("\n=== 9th close attempt: expect QueueFull (error 6023) ===");
  const open9Sig = await openPosition(boot, overflow, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, 1_000_000);
  console.log("open #9 (must succeed — Position was Empty)", open9Sig);
  out.overflowOpen9Sig = open9Sig;
  let queueFullSeen = false;
  let queueFullMsg = "";
  try {
    const close9Sig = await closePosition(boot, overflow, 0);
    console.error("UNEXPECTED: close #9 succeeded:", close9Sig, "— queue was not actually full?");
    out.overflowClose9UnexpectedSig = close9Sig;
  } catch (e: any) {
    queueFullMsg = e.message ?? String(e);
    queueFullSeen = isCustomError(queueFullMsg, 6023);
    console.log(`close #9 FAILED as expected: ${queueFullSeen ? "QueueFull (6023) CONFIRMED" : "FAILED but not confirmed as 6023"} — ${queueFullMsg}`);
  }
  out.overflowQueueFullSeen = queueFullSeen;
  out.overflowQueueFullMsg = queueFullMsg;
  const posAfterFailedClose = await accountNs(coreOwnerOverflow).position.fetch(overflow.position);
  assert("open" in posAfterFailedClose.state, "Position stays Open after the failed (reverted) close #9");

  console.log("\n=== restoring disclosure_delay to 0 (does not retroactively affect the 8 already-queued records — see file header) ===");
  const setDelay0AgainSig = await setDisclosureDelay(admin, 0n);
  console.log("set_disclosure_delay(0)", setDelay0AgainSig);
  out.overflowRestoreDelaySig = setDelay0AgainSig;

  console.log(`\n=== waiting for the queue to free a slot (real ER-slot time + one relayer cycle, <=${OVERFLOW_DRAIN_POLL_MS / 1000}s) ===`);
  const tDrainStart = Date.now();
  let freedAt: number | null = null;
  const drainDeadline = Date.now() + OVERFLOW_DRAIN_POLL_MS;
  let lastLen = 8;
  while (Date.now() < drainDeadline) {
    const dq = await accountNs(coreOwnerOverflow).disclosureQueue.fetch(overflow.disclosureQueue);
    if (dq.len !== lastLen) {
      console.log(`dq.len ${lastLen} -> ${dq.len} at t+${((Date.now() - tDrainStart) / 1000).toFixed(1)}s`);
      lastLen = dq.len;
    }
    if (dq.len < 8) {
      freedAt = Date.now();
      break;
    }
    await sleep(5000);
  }
  out.overflowFreedAfterSeconds = freedAt ? (freedAt - tDrainStart) / 1000 : null;
  if (!freedAt) {
    console.error(`FAIL: queue never freed a slot within ${OVERFLOW_DRAIN_POLL_MS / 1000}s`);
  } else {
    console.log(`queue freed a slot after ${((freedAt - tDrainStart) / 1000).toFixed(1)}s — retrying the close`);
    const close9RetrySig = await closePosition(boot, overflow, 0);
    console.log("close #9 retry SUCCEEDED:", close9RetrySig);
    out.overflowClose9RetrySig = close9RetrySig;
    const posFinal = await accountNs(coreOwnerOverflow).position.fetch(overflow.position);
    assert("empty" in posFinal.state, "Position Empty after the successful retry");
  }

  const finalDelay = (await accountNs(coreBaseAdmin).config.fetch(config)).disclosureDelaySlots.toString();
  out.finalDisclosureDelaySlots = finalDelay;
  console.log("\nConfig.disclosure_delay_slots (final, should be 0):", finalDelay);

  const overallPass = mhLanded && !!out.mjReopenPass && queueFullSeen && !!freedAt && finalDelay === "0";
  console.log("\n14-CLOSE-REOPEN", overallPass ? "PASS" : "PARTIAL/FAIL — see individual flags above", JSON.stringify(out, null, 2));
  if (!overallPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error("14-close-reopen FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
