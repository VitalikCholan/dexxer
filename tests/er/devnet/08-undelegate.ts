// tests/er/devnet/08-undelegate.ts
//
// Task 8, script 3 of 3 (M-A on dexxer_core): full exit for the trader
// created by `06-commitment-reveal.ts` — close out its still-open second
// position, drain the disclosure queue, withdraw all margin, then
// `undelegate_user` (owner-TEE) and poll base until `UserAccount`/
// `Position`/`DisclosureQueue` are owned by `dexxer_core` itself (not the
// Delegation Program) with every private field scrubbed.
//
// Week 3 Task 1 already measured `commit_and_undelegate` after
// `CloseEphemeralPermissionCpi` PASSING on a spike program
// (`spikes/01-private-counter-tee`, week3-results.md §Task 1 M-A) — this
// script is the first time the exact same mechanism runs on `dexxer_core`
// itself, hence "M-A confirmed on dexxer_core" rather than a bare "PASS".
//
// Preconditions for `undelegate_user` (instructions/user.rs): `Position.state
// == Empty`, `DisclosureQueue.len == 0`, `UserAccount.free_margin == 0 &&
// locked_margin == 0`. The 06 trader ends its run with: Position #2 still
// `Closed` (its own record was never committed — 06 only drives record #1's
// reveal), DisclosureQueue empty (06's own last step drained it), and
// nonzero free_margin. This script closes that gap: commit+mark_committed
// position #2's record, drain whatever lands in the queue, withdraw(all),
// then undelegate. Task 8b (ruling 9): `Commitment` is now hash-seeded, so
// (unlike the pre-8b version of this file) a single commit is always
// sufficient — no nonce-collision retry loop needed.
//
// Run: `npm run devnet:undelegate` (from tests/er). Requires
// `06-commitment-reveal.ts` to have run (`.keys/devnet-run-mb-latest.json`).

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

const { BN } = await import("@coral-xyz/anchor");
const { PublicKey } = await import("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
const {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  PERMISSION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, sleep } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, pdas, commitmentHash, sideIndex, reasonIndex } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { openPosition, closePosition } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:undelegate`);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "..", ".keys");
const UNDELEGATE_POLL_MS = 180_000;

function recToArgsAndSalt(rec: any) {
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
  const pointerPath = resolve(KEYS_DIR, "devnet-run-mb-latest.json");
  const runState = JSON.parse(readFileSync(pointerPath, "utf8"));
  console.log("loaded 06 run state:", pointerPath, "trader:", runState.owner);

  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const crank = loadOrCreateKey("devnet-crank");
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  const coreBaseAdmin = dexxerCoreProgram(baseConn, boot.admin);

  const owner = loadOrCreateKey(runState.traderName);
  const market = pdas.market();
  const userAccount = pdas.userAccount(owner.publicKey);
  const position = pdas.position(owner.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(owner.publicKey);
  const userAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);
  console.log("owner:", owner.publicKey.toBase58(), "position:", position.toBase58(), "dq:", disclosureQueue.toBase58());

  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
  const crankConn = await teeConn(crank);
  const crankCore = dexxerCoreProgram(crankConn, crank);
  const feePayerConn = await teeConn(feePayer);
  const feePayerCore = dexxerCoreProgram(feePayerConn, feePayer);
  const cfg = await accountNs(feePayerCore).config.fetch(pdas.config());

  const sigs: Record<string, string> = {};

  async function commitAggregate(remainingKey: InstanceType<typeof PublicKey> | null): Promise<string> {
    const ix = await feePayerCore.methods
      .commitAggregate()
      .accounts({
        config: pdas.config(), payer: feePayer.publicKey, pool: boot.pool, balancesRoot: boot.balancesRoot,
        feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .remainingAccounts(remainingKey ? [{ pubkey: remainingKey, isWritable: true, isSigner: false }] : [])
      .instruction();
    return sendAndConfirmIx(feePayerConn, feePayer, ix);
  }

  async function markCommitted(): Promise<string> {
    return sendAndConfirmIx(crankConn, crank, await crankCore.methods.markCommitted().accounts({ crank: crank.publicKey, config: pdas.config(), position, dq: disclosureQueue }).instruction());
  }

  async function waitForSlot(target: bigint) {
    let cur = BigInt(await baseConn.getSlot("confirmed"));
    while (cur < target) {
      await sleep(3000);
      cur = BigInt(await baseConn.getSlot("confirmed"));
    }
  }

  // === Step 1: if Position is Closed (06's second position, never
  // committed), commit+mark_committed it. If already Empty (a re-run), skip.
  // Task 8b: Commitment is hash-seeded, so a single commit always lands at
  // its own dedicated PDA — no collision, no retry loop needed.
  const posNow = await accountNs(coreOwnerEr).position.fetch(position);
  if ("closed" in posNow.state) {
    console.log("\n=== closing out the still-Closed position from 06's second close ===");
    const { args, salt } = recToArgsAndSalt(posNow.closed);
    const hash = commitmentHash(args, salt);
    const sig = await commitAggregate(position);
    console.log(`commit_aggregate(position) sig=${sig}`);
    const commitmentAcc = await pollBase(`Commitment[hash]`, async () => {
      try {
        return await accountNs(coreBaseAdmin).commitment.fetch(pdas.commitment(hash));
      } catch {
        return null;
      }
    });
    const onChainHash = Uint8Array.from(commitmentAcc.hash as number[]);
    const matches = Buffer.compare(Buffer.from(hash), Buffer.from(onChainHash)) === 0;
    assert(matches, "closeout commitment hash matches (hash-seeded, no collision possible)");
    const markSig = await markCommitted();
    sigs.closeoutMark = markSig;
    await waitForSlot(args.revealAfterSlot);
    const drainSig = await commitAggregate(disclosureQueue);
    console.log(`drained via commit_aggregate(dq): ${drainSig}`);
    await sleep(3000);
    const posAfter = await accountNs(coreOwnerEr).position.fetch(position);
    assert("empty" in posAfter.state, "Position.state == Empty before undelegate_user");
  } else {
    console.log("Position already Empty (re-run) — skipping closeout");
  }

  const dqNow = await accountNs(coreOwnerEr).disclosureQueue.fetch(disclosureQueue);
  assert(dqNow.len === 0, `DisclosureQueue.len == 0 before undelegate_user (got ${dqNow.len})`);

  // === Step 2: withdraw(all) ===
  const uaBefore = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  const freeMarginBefore = BigInt(uaBefore.freeMargin.toString());
  console.log(`\n=== withdraw(all=${freeMarginBefore}) ===`);
  if (freeMarginBefore > 0n) {
    const withdrawIx = await coreOwnerEr.methods
      .withdraw(new BN(freeMarginBefore.toString()))
      .accounts({
        owner: owner.publicKey, userAccount, pool: boot.pool, ownerAta: userAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID,
        config: pdas.config(), feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    sigs.withdraw = await sendAndConfirmIx(ownerConn, owner, withdrawIx);
    console.log("withdraw", sigs.withdraw);
  } else {
    console.log("free_margin already 0 — skipping withdraw call");
  }
  const uaAfter = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  const freeMarginAfter = BigInt(uaAfter.freeMargin.toString());
  const lockedMarginAfter = BigInt(uaAfter.lockedMargin.toString());
  console.log("ER UserAccount after withdraw: free_margin=", freeMarginAfter, "locked_margin=", lockedMarginAfter);
  assert(freeMarginAfter === 0n && lockedMarginAfter === 0n, "free_margin == 0 && locked_margin == 0 before undelegate_user");

  // === Step 3: undelegate_user (owner-TEE) ===
  console.log("\n=== undelegate_user (owner-TEE) ===");
  const userPermission = permissionPdaFromAccount(userAccount);
  const positionPermission = permissionPdaFromAccount(position);
  const dqPermission = permissionPdaFromAccount(disclosureQueue);
  const undelegateIx = await coreOwnerEr.methods
    .undelegateUser()
    .accounts({
      owner: owner.publicKey,
      config: pdas.config(),
      userAccount,
      position,
      dq: disclosureQueue,
      userPermission,
      positionPermission,
      dqPermission,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      feeEscrow: boot.feeEscrow,
      magicFeeVault: cfg.magicFeeVault,
      magicContext: MAGIC_CONTEXT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  const t0 = Date.now();
  sigs.undelegateUser = await sendAndConfirmIx(ownerConn, owner, undelegateIx);
  console.log("undelegate_user (ER)", sigs.undelegateUser);

  // === Step 4: poll base <=180s for owner flip + scrub verification ===
  console.log("\n=== polling base (<=180s) for UserAccount/Position/DisclosureQueue owner == dexxer_core, scrubbed bytes ===");
  let landed = false;
  let finalUserAccount: any = null;
  let finalPosition: any = null;
  let finalDq: any = null;
  const deadline = Date.now() + UNDELEGATE_POLL_MS;
  while (Date.now() < deadline) {
    const [uaInfo, posInfo, dqInfo] = await Promise.all([
      baseConn.getAccountInfo(userAccount, "confirmed"),
      baseConn.getAccountInfo(position, "confirmed"),
      baseConn.getAccountInfo(disclosureQueue, "confirmed"),
    ]);
    const ownersOk =
      !!uaInfo && uaInfo.owner.equals(DEXXER_CORE_PROGRAM_ID) &&
      !!posInfo && posInfo.owner.equals(DEXXER_CORE_PROGRAM_ID) &&
      !!dqInfo && dqInfo.owner.equals(DEXXER_CORE_PROGRAM_ID);
    if (ownersOk) {
      const coreBaseOwner = dexxerCoreProgram(baseConn, owner);
      finalUserAccount = coreBaseOwner.coder.accounts.decode("userAccount", uaInfo!.data);
      finalPosition = coreBaseOwner.coder.accounts.decode("position", posInfo!.data);
      finalDq = coreBaseOwner.coder.accounts.decode("disclosureQueue", dqInfo!.data);
      landed = true;
      break;
    }
    await sleep(3000);
  }
  const t1 = Date.now();
  console.log(`base owner-flip poll took ${((t1 - t0) / 1000).toFixed(1)}s, landed=${landed}`);

  if (!landed) {
    console.log("08-UNDELEGATE: DID NOT LAND within 180s. Recording signatures and current base state for the report.");
    const [uaInfo, posInfo, dqInfo] = await Promise.all([
      baseConn.getAccountInfo(userAccount, "confirmed"),
      baseConn.getAccountInfo(position, "confirmed"),
      baseConn.getAccountInfo(disclosureQueue, "confirmed"),
    ]);
    console.log("UserAccount owner:", uaInfo?.owner.toBase58() ?? "null");
    console.log("Position owner:", posInfo?.owner.toBase58() ?? "null");
    console.log("DisclosureQueue owner:", dqInfo?.owner.toBase58() ?? "null");
    console.log("sigs:", JSON.stringify(sigs, null, 2));
    process.exit(1);
  }

  console.log("\n=== scrub verification ===");
  assert(new PublicKey(finalUserAccount.sessionKey).equals(PublicKey.default), "UserAccount.session_key == default");
  const exitSaltBytes = Uint8Array.from(finalUserAccount.exitSalt as number[]);
  assert(exitSaltBytes.every((b: number) => b === 0), "UserAccount.exit_salt == 0");
  assert(BigInt(finalUserAccount.lastWithdrawSlot.toString()) === 0n, "UserAccount.last_withdraw_slot == 0");
  assert(finalDq.len === 0, "DisclosureQueue.len == 0 (base, post-undelegate)");
  assert("empty" in finalPosition.state, "Position.state == Empty (base, post-undelegate)");

  console.log("\nM-A confirmed on dexxer_core", {
    owner: owner.publicKey.toBase58(),
    sigs,
    baseOwnerFlipSeconds: ((t1 - t0) / 1000).toFixed(1),
  });
  console.log("\n08-UNDELEGATE PASS");
}

main().catch((e) => {
  console.error("08-undelegate FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
