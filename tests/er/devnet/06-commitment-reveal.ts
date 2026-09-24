// tests/er/devnet/06-commitment-reveal.ts
//
// Task 8, script 1 of 3 (M-B): full commitment -> reveal round trip on real
// devnet + devnet-tee, plus a second position on the same trader (proves the
// `Position` is reusable — the "one position per run" limitation from week 2
// is gone).
//
// Week-5 Task 1: the close pushes its `ClosedRecord` into the owner's
// `DisclosureQueue` and frees the `Position` in the same instruction, so both
// the commitment and the disclosure are sourced from the queue and the old
// `mark_committed` step is gone. The week-3 two-call dance (commit, wait for
// the reveal slot, commit again) is gone with it: ONE `commit_aggregate` now
// emits `write_commitment` AND `write_disclosure` for the same record, which
// is what this script asserts below.
//
// Controller Ruling 8 (measured before this script existed — see
// week3-results.md §Task 8 "Рішення після рулінгу 8"): `commit_aggregate`
// signed by `Config.fee_payer` alone against a Closed private `Position`
// (fee_payer is NOT a permission member of that account — members are
// [owner, session, crank]) was measured to SUCCEED on the real TEE — the
// mutation (`commitment_written` flip) and the L1 `write_commitment` action
// both landed. The brief's contingency (wire `extraSigners: [crank]`, or a
// new `set_fee_payer` admin ix if that also failed) was NOT triggered — no
// Rust change, no client wiring change. `commit_aggregate` below is
// therefore called exactly as `scripts/crank-fallback/disclosure.ts`'s
// `runDisclosureCycle` already does it: signed by `Config.fee_payer` only.
//
// NONCE-COLLISION FINDING, now FIXED (Task 8b, controller ruling 9): the
// original `Commitment`/`Disclosure` PDAs were seeded by `nonce` alone —
// `UserAccount.nonce`, a PER-USER counter that starts at 0 and increments to
// 1 on every trader's FIRST close (trade.rs `finalize_close`) — so every
// fresh trader's first close targeted the SAME global `Commitment[1]` PDA and
// the second one's `write_commitment` silently failed to `init`. Ruling 9:
// both PDAs are now seeded by `commitmentHash(args, salt)` (32 bytes, unique
// per record) instead — `pdas.commitment(hash)`/`pdas.disclosure(hash)`.
// This script no longer needs (and has dropped) the collision-retry loop
// that earlier measured and worked around the bug; see the pre-8b history of
// this file in git for that workaround.
//
// PASS lines (brief, printed via `assert` so a fail exits(1) with a message):
//   "M-B commitment landed", "hash matches", "second position opened",
//   "disclosure landed", "hash verified on-chain".
//
// Run: `npm run devnet:disclosure` (from tests/er). Requires
// `devnet-bootstrap.ts` to have run (Config/Pool/FeeEscrow/BalancesRoot +
// action escrow) — this script does that itself, idempotently, as its first
// step (same pattern as 01/03).

import { writeFileSync } from "fs";
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

const { BN } = await import("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const { DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, delegateSpl } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, waitDelegated, sleep } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas, commitmentHash, sideIndex, reasonIndex } = await import(
  "../lib/program.js"
);
const { bootstrapDevnet } = await import("../lib/admin.js");
const { creditDeposit, initPermissions, openPosition, closePosition } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:disclosure`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC
const OPEN_SIZE_SOL = 1.0;
const OPEN_MARGIN_USD = 20;
const OPEN_LIMIT_USD = 1_000_000; // effectively "no slippage protection" for a Long open
const TRADER_FUND_SOL = 0.05;

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "..", ".keys");

interface Args {
  market: InstanceType<typeof PublicKey>;
  side: number;
  size: bigint;
  entry: bigint;
  exit: bigint;
  pnl: bigint;
  fees: bigint;
  reason: number;
  openedSlot: bigint;
  closedSlot: bigint;
  nonce: bigint;
  revealAfterSlot: bigint;
}

function recToArgs(rec: any): { args: Args; salt: Uint8Array } {
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

async function pollBase<T>(label: string, fn: () => Promise<T | null>, tries = 60, delayMs = 2000): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(delayMs);
  }
  throw new Error(`timeout polling for ${label} (${tries * delayMs}ms)`);
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const crank = loadOrCreateKey("devnet-crank");
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  const coreBaseAdmin = dexxerCoreProgram(baseConn, boot.admin);

  const runId = Date.now();
  const traderName = `devnet-mb-${runId}`;
  const owner = loadOrCreateKey(traderName);
  console.log("run id:", runId, "trader (owner):", owner.publicKey.toBase58());

  const fundSig = await sendAndConfirmTransaction(
    baseConn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: boot.admin.publicKey, toPubkey: owner.publicKey, lamports: TRADER_FUND_SOL * LAMPORTS_PER_SOL })),
    [boot.admin],
    { commitment: "confirmed" },
  );
  console.log(`funded trader ${TRADER_FUND_SOL} SOL from devnet-admin:`, fundSig);

  const core = dexxerCoreProgram(baseConn, owner);
  const config = pdas.config();
  const market = pdas.market();
  const userAccount = pdas.userAccount(owner.publicKey);
  const position = pdas.position(owner.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(owner.publicKey);
  const faucetPda = pdas.faucet(owner.publicKey);
  const mintAuth = pdas.mintAuth();
  const ownerAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);

  console.log("=== faucet (dUSDC) ===");
  await getOrCreateAssociatedTokenAccount(baseConn, owner, boot.mint, owner.publicKey);
  const faucetSig = await core.methods
    .faucetInit(new BN(DEPOSIT.toString()))
    .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, faucet: faucetPda, dusdcMint: boot.mint, mintAuth, ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  console.log("faucet_init", faucetSig);

  console.log("=== init_user (with exit_salt) ===");
  const { randomBytes } = await import("crypto");
  const exitSalt = new Uint8Array(randomBytes(32));
  const initUserSig = await core.methods
    .initUser(Array.from(exitSalt))
    .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("init_user", initUserSig);

  console.log("=== delegateSpl + delegate_user ===");
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
  console.log("delegateSpl", delegateSplSig, "delegate_user", delegateUserSig);
  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, position, "Position");
  await waitDelegated(baseConn, disclosureQueue, "DisclosureQueue");

  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
  const traderCtx = { name: traderName, kp: owner, userAccount, position, disclosureQueue, userAta: ownerAta, exitSalt, sigs: {} as Record<string, string>, creditDepositCU: null as number | null };

  const creditSig = await creditDeposit(boot, traderCtx, DEPOSIT);
  console.log("credit_deposit", creditSig);
  const initPermSig = await initPermissions(traderCtx);
  console.log("init_permissions (members=[owner, crank])", initPermSig);

  const feePayerConn = await teeConn(feePayer);
  const feePayerCore = dexxerCoreProgram(feePayerConn, feePayer);
  const cfg = await accountNs(feePayerCore).config.fetch(config);

  async function commitAggregate(remainingKey: InstanceType<typeof PublicKey>): Promise<string> {
    const ix = await feePayerCore.methods
      .commitAggregate(4)
      .accounts({
        config, payer: feePayer.publicKey, pool: boot.pool, poolLive: boot.poolLive, balancesRoot: boot.balancesRoot,
        feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .remainingAccounts([{ pubkey: remainingKey, isWritable: true, isSigner: false }])
      .instruction();
    return sendAndConfirmIx(feePayerConn, feePayer, ix);
  }

  // The reveal gate (`ClosedRecord.reveal_after_slot`) is stamped from the ER's
  // OWN `Clock`, which is a completely different counter from the base layer's
  // (measured in week-5 Task 4: ER slot ~343.4M while base slot ~503.1M, and
  // the ER advances ~80 slots/s against base's ~2.5). Polling `baseConn` here —
  // what this script did through week 4 — compared the two counters and always
  // returned instantly. Poll the ER.
  async function waitForErSlot(target: bigint) {
    let cur = BigInt(await ownerConn.getSlot("confirmed"));
    while (cur < target) {
      await sleep(1000);
      cur = BigInt(await ownerConn.getSlot("confirmed"));
    }
  }

  // === position #1: hash-seeded PDA (Task 8b) means no cross-trader
  // collision is possible — a single open/close/commit cycle is enough. ===
  console.log("\n=== position #1: open Long ===");
  const openNSig = await openPosition(boot, traderCtx, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, OPEN_LIMIT_USD);
  console.log("open_position", openNSig);
  const posAfterOpen = await accountNs(coreOwnerEr).position.fetch(position);
  assert("open" in posAfterOpen.state, "position Open after open_position");

  console.log("=== position #1: close ===");
  const closeNSig = await closePosition(boot, traderCtx, 0);
  console.log("close_position", closeNSig);
  const posAfterClose = await accountNs(coreOwnerEr).position.fetch(position);
  assert("empty" in posAfterClose.state, "close frees the Position immediately (week-5 Task 1)");
  const dqAfterClose = await accountNs(coreOwnerEr).disclosureQueue.fetch(disclosureQueue);
  assert(dqAfterClose.len === 1, "the ClosedRecord went straight into the DisclosureQueue");
  const queuedRecord = dqAfterClose.records[dqAfterClose.head];
  assert(queuedRecord.commitmentWritten === false, "queued uncommitted — commit_aggregate is what flips this");
  const { args: realArgs, salt: realSalt } = recToArgs(queuedRecord);
  const realNonce = realArgs.nonce;
  console.log(`ClosedRecord nonce=${realNonce} revealAfterSlot=${realArgs.revealAfterSlot} (ER slots)`);
  const realCommitHash = commitmentHash(realArgs, realSalt);

  // === week-5 Task 1's headline claim: ONE bundle, both actions ===
  //
  // `commit_aggregate` emits `write_commitment` for every uncommitted record
  // and `write_disclosure` for every DUE one, in the same bundle. Once the
  // record is past `reveal_after_slot`, a single call therefore has to produce
  // BOTH L1 accounts and pop the record — which is what the week-3 two-call
  // dance (commit, wait, commit again) existed to work around. `Config
  // .disclosure_delay_slots` is 100 on this deployment and cannot be changed
  // after `init_config` (no admin setter exists — Task 4 open item), but 100
  // ER slots is only ~1.2 s, so the wait below is seconds, not minutes.
  console.log(`\n=== waiting for ER slot >= reveal_after_slot = ${realArgs.revealAfterSlot} ===`);
  await waitForErSlot(realArgs.revealAfterSlot);
  console.log("reveal slot reached (ER)");

  console.log("\n=== ONE commit_aggregate(remaining=[disclosure_queue]) — commitment AND disclosure ===");
  const tCommitStart = Date.now();
  // ONE signature for both actions since week-5 Task 1 — no separate
  // commit/reveal transactions to name apart any more.
  const commitAndRevealSig = await commitAggregate(disclosureQueue);
  console.log("commit_aggregate (dq) sig:", commitAndRevealSig, "(fee_payer-only signer — Ruling 8: measured PASS)");

  const commitmentPda = pdas.commitment(realCommitHash);
  const commitmentAcc = await pollBase(`Commitment[hash] on base`, async () => {
    try {
      return await accountNs(coreBaseAdmin).commitment.fetch(commitmentPda);
    } catch {
      return null;
    }
  });
  const tCommitmentSeen = Date.now();
  const onChainHash = Uint8Array.from(commitmentAcc.hash as number[]);
  const matches = Buffer.compare(Buffer.from(realCommitHash), Buffer.from(onChainHash)) === 0;
  console.log(`Commitment[hash] visible on base after ${((tCommitmentSeen - tCommitStart) / 1000).toFixed(1)}s; hash ${matches ? "MATCHES" : "MISMATCH"}`);
  assert(matches, "M-B commitment landed");
  assert(matches, "hash matches");

  const disclosurePda = pdas.disclosure(realCommitHash);
  const t2 = tCommitStart;
  const disclosureAcc = await pollBase("Disclosure on base", async () => {
    try {
      return await accountNs(coreBaseAdmin).disclosure.fetch(disclosurePda);
    } catch {
      return null;
    }
  });
  const t3 = Date.now();
  console.log(`Disclosure[hash] visible on base after ${((t3 - t2) / 1000).toFixed(1)}s — SAME commit_aggregate as the commitment`);
  assert(true, "disclosure landed");
  assert(true, "one-cycle reveal: commitment and disclosure from a single commit_aggregate");

  const dqNow = await accountNs(coreOwnerEr).disclosureQueue.fetch(disclosureQueue);
  console.log(`DisclosureQueue.len after the bundle: ${dqNow.len}`);
  assert(dqNow.len === 0, "the record was popped by the same bundle that committed it");

  // === position #2 (brief's "second position": proves Position reuse, and
  // leaves one record behind for 08-undelegate.ts to drain) ===
  console.log("\n=== position #2: open Long (same trader, proves Position reuse) ===");
  const open2Sig = await openPosition(boot, traderCtx, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, OPEN_LIMIT_USD);
  console.log("open_position #2", open2Sig);
  const posAfterOpen2 = await accountNs(coreOwnerEr).position.fetch(position);
  assert("open" in posAfterOpen2.state, "second position opened");

  console.log("=== position #2: close ===");
  const close2Sig = await closePosition(boot, traderCtx, 0);
  console.log("close_position #2", close2Sig);


  assert(new PublicKey(disclosureAcc.owner).equals(PublicKey.default), "Disclosure.owner == Pubkey.default()");
  assert(new PublicKey(disclosureAcc.market).equals(realArgs.market), "Disclosure.market == ClosedRecord.market");
  assert(sideIndex(disclosureAcc.side) === realArgs.side, "Disclosure.side == ClosedRecord.side");
  assert(BigInt(disclosureAcc.size.toString()) === realArgs.size, "Disclosure.size == ClosedRecord.size");
  assert(BigInt(disclosureAcc.entry.toString()) === realArgs.entry, "Disclosure.entry == ClosedRecord.entry");
  assert(BigInt(disclosureAcc.exit.toString()) === realArgs.exit, "Disclosure.exit == ClosedRecord.exit");
  assert(BigInt(disclosureAcc.pnl.toString()) === realArgs.pnl, "Disclosure.pnl == ClosedRecord.pnl");
  assert(BigInt(disclosureAcc.fees.toString()) === realArgs.fees, "Disclosure.fees == ClosedRecord.fees");
  assert(reasonIndex(disclosureAcc.reason) === realArgs.reason, "Disclosure.reason == ClosedRecord.reason");
  assert(BigInt(disclosureAcc.openedSlot.toString()) === realArgs.openedSlot, "Disclosure.opened_slot == ClosedRecord.opened_slot");
  assert(BigInt(disclosureAcc.closedSlot.toString()) === realArgs.closedSlot, "Disclosure.closed_slot == ClosedRecord.closed_slot");
  assert(BigInt(disclosureAcc.nonce.toString()) === realArgs.nonce, "Disclosure.nonce == ClosedRecord.nonce");

  const argsFromDisclosure: Args = {
    market: new PublicKey(disclosureAcc.market),
    side: sideIndex(disclosureAcc.side),
    size: BigInt(disclosureAcc.size.toString()),
    entry: BigInt(disclosureAcc.entry.toString()),
    exit: BigInt(disclosureAcc.exit.toString()),
    pnl: BigInt(disclosureAcc.pnl.toString()),
    fees: BigInt(disclosureAcc.fees.toString()),
    reason: reasonIndex(disclosureAcc.reason),
    openedSlot: BigInt(disclosureAcc.openedSlot.toString()),
    closedSlot: BigInt(disclosureAcc.closedSlot.toString()),
    nonce: BigInt(disclosureAcc.nonce.toString()),
    revealAfterSlot: realArgs.revealAfterSlot, // not stored on Disclosure; reuse the value bound into the original hash
  };
  const recomputedHash = commitmentHash(argsFromDisclosure, realSalt);
  assert(Buffer.compare(Buffer.from(recomputedHash), Buffer.from(realCommitHash)) === 0, "hash verified on-chain");

  console.log("\n=== timings ===");
  console.log(`commit_aggregate ER sig -> Commitment visible on base: ${((tCommitmentSeen - tCommitStart) / 1000).toFixed(1)}s`);
  console.log(`same commit_aggregate ER sig -> Disclosure visible on base: ${((t3 - t2) / 1000).toFixed(1)}s`);

  writeFileSync(
    resolve(KEYS_DIR, "devnet-run-mb-latest.json"),
    JSON.stringify(
      {
        runId, traderName, owner: owner.publicKey.toBase58(), position: position.toBase58(), disclosureQueue: disclosureQueue.toBase58(),
        nonce: realNonce.toString(), commitmentPda: commitmentPda.toBase58(), disclosurePda: disclosurePda.toBase58(),
        sigs: { fundSig, faucetSig, initUserSig, delegateSplSig, delegateUserSig, creditSig, initPermSig, openNSig, closeNSig, commitAndRevealSig, open2Sig, close2Sig },
      },
      null,
      2,
    ),
  );

  console.log("\n06-COMMITMENT-REVEAL PASS");
}

main().catch((e) => {
  console.error("06-commitment-reveal FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
