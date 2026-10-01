// tests/er/devnet/11-liq-task-migration.ts
//
// Week-5 Task 4, measurements (a)/(b) — two devnet facts the program's
// liquidation-task wiring rests on but that cannot be verified locally. Since
// position slots (spec §2.9) the task is per (Positions, market):
// `liq_task_id(positions, market)`, and `task_context` is the trader's
// `Positions` account.
//
//   (b) `open_position` really registers the per-market `liquidation_check`
//       task (`ScheduleTask` CPI into the Magic Program, payer/authority =
//       the `FeeEscrow` PDA) — and the Magic Program accepts `task_context`
//       being the SAME key as `positions` (week-5 Task 0 measurement 6 said an
//       arbitrary writable account is fine; this pins the duplicate-key case
//       on the real instruction). MEASURED THE HARD WAY: devnet-tee returns
//       NEITHER `logMessages` NOR `computeUnitsConsumed` for ER transactions
//       (`getTransaction` gives `CU: 0` and no logs; `simulateTransaction`
//       gives no logs either), and week-5 Task 0 measurement 4 already showed
//       the task registry is invisible from every endpoint. So the evidence
//       here is that the transaction was ACCEPTED: the `ScheduleTask` CPI in
//       `open_position` is unconditional (gated only on
//       `magic_program.executable`, true on devnet-tee), so a rejected
//       registration — or a rejected duplicate `task_context` key — would have
//       failed the whole instruction.
//   (a) cancelling an UNKNOWN `task_id` is not an error (M-I, liquidation.rs).
//       `close_position` cancels the live task; `undelegate_user` then cancels
//       the very same id a second time (the SOL market is passed in its
//       remaining accounts), when it no longer exists. A failing CPI cannot be
//       caught from inside a program, so if the validator errored here every
//       exit would abort — this is the measurement that decides whether the
//       in-path cancels can stay.
//
// The week-5 (c) measurement (exit with disclosure debt, orphan queue) is gone
// with the disclosure queue itself.
//
// Run: `npm run devnet:liqtask` (from tests/er). Independent of every other
// devnet script — it onboards its own trader, funded from `devnet-admin`.

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
const { SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { ER_VALIDATOR, NET, baseConn, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const {
  creditDeposit, delegateUserAccounts, initPermissions, initUserAccounts, readPositions, tradeAccounts, undelegateUserAccounts, U64_MAX,
} = await import("../lib/trader.js");
const { liqTaskId, slotFor } = await import("../lib/positions.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:liqtask`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)
const OPEN_SIZE_SOL = 1.0;
const TRADER_FUND_SOL = 0.05;

/**
 * What devnet-tee is willing to tell us about an ER transaction. Measured in
 * Task 4: `logMessages` comes back empty and `computeUnitsConsumed` is 0 for
 * every ER transaction, so this is recorded as a finding rather than used as
 * evidence. `err` is still meaningful.
 */
async function txMeta(conn: any, sig: string): Promise<Record<string, unknown>> {
  if (!sig.startsWith("(")) {
    for (let i = 0; i < 10; i++) {
      const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) return { err: tx.meta?.err ?? null, computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null, logCount: tx.meta?.logMessages?.length ?? 0 };
      await sleep(500);
    }
  }
  return { unavailable: true };
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const feePayer = loadOrCreateKey("devnet-fee-payer");

  // `LIQTASK_TRADER=<key name>` resumes an earlier, half-finished run instead
  // of stranding its position and its live task in the ER. Every step below is
  // skip-if-already-done, exactly like `onboardTrader`.
  const runId = Date.now();
  const traderName = process.env.LIQTASK_TRADER ?? `devnet-liqtask-${runId}`;
  const owner = loadOrCreateKey(traderName);

  const market = boot.market;
  const config = pdas.config();
  const userAccount = pdas.userAccount(owner.publicKey);
  const positions = pdas.positions(owner.publicKey);
  const taskId = liqTaskId(positions, market);
  console.log("run id:", runId, "trader:", traderName, "owner:", owner.publicKey.toBase58(), "positions:", positions.toBase58(), "liq task_id (SOL):", taskId.toString());

  if ((await baseConn.getBalance(owner.publicKey, "confirmed")) < 0.02 * LAMPORTS_PER_SOL) {
    const fundSig = await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: boot.admin.publicKey, toPubkey: owner.publicKey, lamports: TRADER_FUND_SOL * LAMPORTS_PER_SOL })),
      [boot.admin],
      { commitment: "confirmed" },
    );
    console.log(`funded trader ${TRADER_FUND_SOL} SOL from devnet-admin:`, fundSig);
  } else {
    console.log("trader already funded, skipped");
  }

  // A trader that has already exited cannot be re-run through the flow below
  // (its `UserAccount` is undelegated and `exited`, and `delegateSpl` would
  // fail on the eATA) — and there is nothing left on it to measure.
  const uaL1Pre = await baseConn.getAccountInfo(userAccount, "confirmed");
  if (uaL1Pre && uaL1Pre.owner.equals(DEXXER_CORE_PROGRAM_ID) && dexxerCoreProgram(baseConn, owner).coder.accounts.decode("userAccount", uaL1Pre.data).exited) {
    console.log("\n=== trader has already exited — nothing left to measure; start a fresh run ===");
    return;
  }

  // === onboarding (same sequence as 05, self-paid) ===
  const core = dexxerCoreProgram(baseConn, owner);
  const ownerAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);
  await getOrCreateAssociatedTokenAccount(baseConn, owner, boot.mint, owner.publicKey);
  const faucetSig = (await baseConn.getAccountInfo(pdas.faucet(owner.publicKey), "confirmed"))
    ? "(exists, skipped)"
    : await core.methods
        .faucetInit(new BN(DEPOSIT.toString()))
        .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, faucet: pdas.faucet(owner.publicKey), dusdcMint: boot.mint, mintAuth: pdas.mintAuth(), ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();
  const exitSalt = Array.from(randomBytes(32));
  const userInfoPre = await baseConn.getAccountInfo(userAccount, "confirmed");
  const initUserSig = userInfoPre
    ? "(exists, skipped)"
    : await core.methods.initUser(exitSalt).accounts(initUserAccounts(owner.publicKey, owner.publicKey)).rpc();
  console.log("faucet_init", faucetSig, "init_user", initUserSig);

  if (userInfoPre && userInfoPre.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.log("delegate_user: already delegated, skipped");
  } else {
  const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { validator: ER_VALIDATOR, initVaultIfMissing: false, idempotent: false });
  const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateSplIxs), [owner], { commitment: "confirmed" });
  const delegateUserSig = await core.methods
    .delegateUser()
    .accounts(delegateUserAccounts(owner.publicKey, owner.publicKey))
    .rpc();
  console.log("delegateSpl", delegateSplSig, "delegate_user", delegateUserSig);
  }
  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, positions, "Positions");

  const trader = { kp: owner, userAccount, positions, userAta: ownerAta };
  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
  const uaEr = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  const creditSig = BigInt(uaEr.freeMargin.toString()) + BigInt(uaEr.lockedMargin.toString()) > 0n
    ? "(already funded, skipped)"
    : await creditDeposit(boot, trader, DEPOSIT);
  const permInfo = await ownerConn.getAccountInfo(permissionPdaFromAccount(userAccount), "confirmed");
  const initPermSig = permInfo && permInfo.owner.equals(PERMISSION_PROGRAM_ID) ? "(exists, skipped)" : await initPermissions(trader);
  console.log("credit_deposit", creditSig, "init_permissions", initPermSig);
  const feePayerConn = await teeConn(feePayer);
  const cfg = await accountNs(dexxerCoreProgram(feePayerConn, feePayer)).config.fetch(config);

  const out: Record<string, unknown> = { owner: owner.publicKey.toBase58(), positions: positions.toBase58(), taskId: taskId.toString() };

  // === (b) open_position registers the liquidation task ===
  console.log("\n=== (b) open_position -> ScheduleTask ===");
  const mkt = await accountNs(coreOwnerEr).market.fetch(market);
  const price = BigInt(mkt.mark.toString());
  assert(price > 0n, `Market.mark is seeded (nonzero) — got ${price}`);
  const sizeLamports = BigInt(Math.round(OPEN_SIZE_SOL * 1_000_000_000));
  const notional = (sizeLamports * price) / 1_000_000_000n;
  const marginUsd = (notional * 11n) / 100n; // ~9x, with headroom over imr_bps rounding
  const accts = tradeAccounts({ config, poolLive: boot.poolLive }, trader, boot);
  console.log(`price(mark)=${price} notional=${notional} margin=${marginUsd}; task_context == positions? ${accts.taskContext.equals(positions)}`);
  const openIx = await coreOwnerEr.methods
    .openPosition({ long: {} }, new BN(sizeLamports.toString()), new BN(marginUsd.toString()), new BN(U64_MAX.toString()))
    .accounts({ signer: owner.publicKey, ...accts })
    .instruction();
  const openSig = slotFor(await readPositions(ownerConn, positions), market)
    ? "(SOL slot already open from an earlier run, skipped)"
    : await sendAndConfirmIx(ownerConn, owner, openIx);
  console.log("open_position", openSig);
  const openMeta = await txMeta(ownerConn, openSig);
  console.log("open_position tx meta from devnet-tee:", JSON.stringify(openMeta));
  assert(slotFor(await readPositions(ownerConn, positions), market) !== null, "Positions has an open SOL slot after open_position");
  assert(accts.taskContext.equals(positions), "(b) task_context is the Positions account's own key — the duplicate-key case, and it was accepted");
  out.openSig = openSig;
  out.openTxMeta = openMeta;
  out.taskContextEqualsPositions = accts.taskContext.equals(positions);
  out.liqCrankSigner = accts.liqCrankSigner.toBase58();

  // === (a) part 1: close_position cancels the LIVE task ===
  console.log("\n=== (a1) close_position -> CancelTask (live id) ===");
  const closeIx = await coreOwnerEr.methods
    .closePosition(new BN("0"))
    .accounts({ signer: owner.publicKey, ...accts })
    .instruction();
  const closeSig = await sendAndConfirmIx(ownerConn, owner, closeIx);
  console.log("close_position", closeSig, "meta:", JSON.stringify(await txMeta(ownerConn, closeSig)));
  assert(slotFor(await readPositions(ownerConn, positions), market) === null, "the SOL slot is free right after close");
  out.closeSig = closeSig;

  // === withdraw(all): undelegate_user requires zero margin ===
  const uaBefore = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  const freeMargin = BigInt(uaBefore.freeMargin.toString());
  console.log(`\n=== withdraw(all=${freeMargin}) ===`);
  const withdrawIx = await coreOwnerEr.methods
    .withdraw(new BN(freeMargin.toString()))
    .accounts({
      owner: owner.publicKey, userAccount, pool: boot.pool, poolLive: boot.poolLive, ownerAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID,
      config, feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  const withdrawSig = await sendAndConfirmIx(ownerConn, owner, withdrawIx);
  console.log("withdraw", withdrawSig);
  out.withdrawSig = withdrawSig;

  // === (a) part 2: undelegate_user — cancels the SAME (positions, SOL) id, now unknown ===
  console.log("\n=== (a2) undelegate_user (cancel of an unknown task_id) ===");
  const undelegateIx = await coreOwnerEr.methods
    .undelegateUser()
    .accounts(undelegateUserAccounts(owner.publicKey, cfg.magicFeeVault))
    .remainingAccounts([{ pubkey: market, isWritable: false, isSigner: false }])
    .instruction();
  let undelegateSig = "";
  let undelegateErr = "";
  try {
    undelegateSig = await sendAndConfirmIx(ownerConn, owner, undelegateIx);
    console.log("undelegate_user", undelegateSig);
  } catch (e: any) {
    undelegateErr = e.message ?? String(e);
    console.error("undelegate_user FAILED:", undelegateErr);
  }
  out.undelegateSig = undelegateSig;
  out.undelegateErr = undelegateErr;
  out.cancelUnknownTaskIdAccepted = undelegateSig !== "";
  assert(undelegateSig !== "", "(a) cancelling an unknown task_id is accepted — undelegate_user succeeded");

  console.log("\n11-LIQ-TASK-MIGRATION PASS", JSON.stringify(out));
}

main().catch((e) => {
  console.error("11-liq-task-migration FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
