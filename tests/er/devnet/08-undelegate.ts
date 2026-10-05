// tests/er/devnet/08-undelegate.ts
//
// Week 3 Task 8 (M-A on dexxer_core): full exit for the trader
// created by `01-onboard-private.ts` — close its still-open SOL position,
// withdraw all margin, then `undelegate_user` (owner-TEE) and poll base until
// `UserAccount`/`Positions` are owned by `dexxer_core` itself (not the
// Delegation Program) with every private field scrubbed.
//
// Week 3 Task 1 already measured `commit_and_undelegate` after
// `CloseEphemeralPermissionCpi` PASSING on a spike program
// (`spikes/01-private-counter-tee`, weeks0-5-history.md#week-3 §Task 1 M-A) — this
// script is the first time the exact same mechanism runs on `dexxer_core`
// itself, hence "M-A confirmed on dexxer_core" rather than a bare "PASS".
//
// Position slots (spec §2.9): no disclosure queue to drain any more. The gate
// of `undelegate_user` is `Positions.open_count() == 0` (no open slot) AND
// `free_margin == 0 && locked_margin == 0` — both checked by the program
// (instructions/user.rs). The market keys the trader
// traded (history ring) plus SOL go in as read-only remaining accounts (≤16)
// so the program cancels each market's liquidation task. After the exit the
// `Positions` body — slots and history, bytes [40, 40 + 3072) — must be zero.
//
// Run: `npm run devnet:undelegate` (from tests/er). Requires
// `01-onboard-private.ts` to have run (`.keys/devnet-run-latest.json`).

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
const { MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, sleep } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { closePosition, readPositions, undelegateUserAccounts } = await import("../lib/trader.js");
const { MAX_SLOTS, slotFor } = await import("../lib/positions.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:undelegate`);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "..", ".keys");
const UNDELEGATE_POLL_MS = 180_000;

async function main() {
  const pointerPath = resolve(KEYS_DIR, "devnet-run-latest.json");
  const runState = JSON.parse(readFileSync(pointerPath, "utf8"));
  console.log("loaded 01 run state:", pointerPath, "trader:", runState.owner);

  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const feePayer = loadOrCreateKey("devnet-fee-payer");

  const owner = loadOrCreateKey(runState.traderName);
  const userAccount = pdas.userAccount(owner.publicKey);
  const positions = pdas.positions(owner.publicKey);
  const userAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);
  console.log("owner:", owner.publicKey.toBase58(), "positions:", positions.toBase58());

  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
  const feePayerConn = await teeConn(feePayer);
  const feePayerCore = dexxerCoreProgram(feePayerConn, feePayer);
  const cfg = await accountNs(feePayerCore).config.fetch(pdas.config());

  const sigs: Record<string, string> = {};

  // === Step 1: close the SOL position 01 left open (a re-run finds it closed).
  // Only SOL is closed here: 01 trades nothing else, and another market's
  // feed/risk accounts are not derivable from its key alone.
  const trader = { name: runState.traderName, kp: owner, userAccount, positions, userAta, exitSalt: [], sigs: {}, creditDepositCU: null };
  if (slotFor(await readPositions(ownerConn, positions), boot.market)) {
    console.log("\n=== close_position (SOL slot 01 left open) ===");
    sigs.closePosition = await closePosition(boot, trader, 0);
    console.log("close_position", sigs.closePosition);
    await sleep(3000);
  } else {
    console.log("SOL slot already closed (re-run) — skipping close");
  }
  const positionsBefore = await readPositions(ownerConn, positions);
  assert(positionsBefore.slots.length === 0, `no open slot before undelegate_user (got ${positionsBefore.slots.length})`);

  // === Step 2: withdraw(all) ===
  const uaBefore = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  const freeMarginBefore = BigInt(uaBefore.freeMargin.toString());
  console.log(`\n=== withdraw(all=${freeMarginBefore}) ===`);
  if (freeMarginBefore > 0n) {
    const withdrawIx = await coreOwnerEr.methods
      .withdraw(new BN(freeMarginBefore.toString()))
      .accounts({
        owner: owner.publicKey, userAccount, pool: boot.pool, poolLive: boot.poolLive, ownerAta: userAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID,
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
  // Every market in the history ring plus SOL, deduplicated, read-only, ≤16:
  // the program cancels each market's liquidation task for this trader.
  console.log("\n=== undelegate_user (owner-TEE) ===");
  const marketKeys = [boot.market, ...positionsBefore.history.map((h) => h.market)];
  const markets = marketKeys.filter((m, i) => marketKeys.findIndex((k) => k.equals(m)) === i).slice(0, MAX_SLOTS);
  console.log("markets passed for task cancel:", markets.map((m) => m.toBase58()));
  const undelegateIx = await coreOwnerEr.methods
    .undelegateUser()
    .accounts(undelegateUserAccounts(owner.publicKey, cfg.magicFeeVault))
    .remainingAccounts(markets.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })))
    .instruction();
  const t0 = Date.now();
  sigs.undelegateUser = await sendAndConfirmIx(ownerConn, owner, undelegateIx);
  console.log("undelegate_user (ER)", sigs.undelegateUser);

  // === Step 4: poll base <=180s for owner flip + scrub verification ===
  console.log("\n=== polling base (<=180s) for UserAccount/Positions owner == dexxer_core, scrubbed bytes ===");
  let landed = false;
  let finalUserAccount: any = null;
  let finalPositionsData: Buffer | null = null;
  const deadline = Date.now() + UNDELEGATE_POLL_MS;
  while (Date.now() < deadline) {
    const [uaInfo, posInfo] = await Promise.all([
      baseConn.getAccountInfo(userAccount, "confirmed"),
      baseConn.getAccountInfo(positions, "confirmed"),
    ]);
    const ownersOk =
      !!uaInfo && uaInfo.owner.equals(DEXXER_CORE_PROGRAM_ID) &&
      !!posInfo && posInfo.owner.equals(DEXXER_CORE_PROGRAM_ID);
    if (ownersOk) {
      const coreBaseOwner = dexxerCoreProgram(baseConn, owner);
      finalUserAccount = coreBaseOwner.coder.accounts.decode("userAccount", uaInfo!.data);
      // `Positions` is zero-copy: raw bytes, never the Borsh coder.
      finalPositionsData = posInfo!.data;
      landed = true;
      break;
    }
    await sleep(3000);
  }
  const t1 = Date.now();
  console.log(`base owner-flip poll took ${((t1 - t0) / 1000).toFixed(1)}s, landed=${landed}`);

  if (!landed) {
    console.log("08-UNDELEGATE: DID NOT LAND within 180s. Recording signatures and current base state for the report.");
    const [uaInfo, posInfo] = await Promise.all([
      baseConn.getAccountInfo(userAccount, "confirmed"),
      baseConn.getAccountInfo(positions, "confirmed"),
    ]);
    console.log("UserAccount owner:", uaInfo?.owner.toBase58() ?? "null");
    console.log("Positions owner:", posInfo?.owner.toBase58() ?? "null");
    console.log("sigs:", JSON.stringify(sigs, null, 2));
    // Round 2 (fix round 2 requirement): if undelegate_user still fails,
    // capture the ER-side transaction directly (json + jsonParsed) plus
    // getSignatureStatuses, rather than only the confirm error — the fuller
    // evidence a follow-up investigation needs.
    console.log("\n=== capturing ER tx evidence for undelegate_user (sig:", sigs.undelegateUser, ") ===");
    try {
      const txJson = await ownerConn.getTransaction(sigs.undelegateUser, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log("getTransaction (default/json):", JSON.stringify(txJson, null, 2));
    } catch (e) {
      console.log("getTransaction (default/json) failed:", String(e));
    }
    try {
      // web3.js Connection doesn't expose an encoding param directly on
      // getTransaction; hit the ER RPC's jsonParsed encoding via a raw call.
      const raw = await fetch(ownerConn.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [sigs.undelegateUser, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }],
        }),
      });
      console.log("getTransaction (jsonParsed):", JSON.stringify(await raw.json(), null, 2));
    } catch (e) {
      console.log("getTransaction (jsonParsed) failed:", String(e));
    }
    try {
      const statuses = await ownerConn.getSignatureStatuses([sigs.undelegateUser]);
      console.log("getSignatureStatuses:", JSON.stringify(statuses, null, 2));
    } catch (e) {
      console.log("getSignatureStatuses failed:", String(e));
    }
    process.exit(1);
  }

  console.log("\n=== scrub verification ===");
  assert(new PublicKey(finalUserAccount.sessionKey).equals(PublicKey.default), "UserAccount.session_key == default");
  const exitSaltBytes = Uint8Array.from(finalUserAccount.exitSalt as number[]);
  assert(exitSaltBytes.every((b: number) => b === 0), "UserAccount.exit_salt == 0");
  assert(BigInt(finalUserAccount.lastWithdrawSlot.toString()) === 0n, "UserAccount.last_withdraw_slot == 0");
  // Slots (16 x 96) and history ring (16 x 96) start right after disc(8) + owner(32).
  const body = finalPositionsData!.subarray(40, 40 + 3072);
  assert(body.length === 3072 && body.every((b) => b === 0), "Positions slots + history bytes [40, 3112) are all zero (base, post-undelegate)");

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
