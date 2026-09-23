// tests/er/devnet/11-liq-task-migration.ts
//
// Week-5 Task 4, measurements (a)/(b)/(c) — the three devnet facts the
// program tasks 1-3 were written against but could not verify locally:
//
//   (b) `open_position` really registers the per-position `liquidation_check`
//       task (`ScheduleTask` CPI into the Magic Program, payer/authority =
//       the `FeeEscrow` PDA) — and the Magic Program accepts `task_context`
//       being the SAME key as `position` (week-5 Task 0 measurement 6 said an
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
//       failed the whole instruction. The behavioural proof that the
//       registered task actually ticks and liquidates is M-G' (Task 7).
//   (a) cancelling an UNKNOWN `task_id` is not an error (M-I, liquidation.rs).
//       `close_position` cancels the live task; `undelegate_user` then cancels
//       the very same id a second time, when it no longer exists. A failing
//       CPI cannot be caught from inside a program, so if the validator
//       errored here every exit would abort — this is the measurement that
//       decides whether the in-path cancels can stay.
//   (c) the exit-with-debt branch: `undelegate_user` with `dq.len > 0` takes
//       `UserAccount`/`Position` out of the ER and deliberately LEAVES the
//       `DisclosureQueue` behind, delegated and crank-only. That orphan is the
//       signal `close_orphan_queue` (Task 2) keys off.
//
// The three run as one trader on purpose: a close is what both arms a debt
// record and cancels the live task, so (a) and (c) are the same exit.
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
const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const { keccak_256 } = await import("@noble/hashes/sha3");
const envMod = await import("../lib/env.js");
const { ER_VALIDATOR, NET, baseConn, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { creditDeposit, initPermissions, tradeAccounts, U64_MAX } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:liqtask`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)
const OPEN_SIZE_SOL = 1.0;
const TRADER_FUND_SOL = 0.05;
const ORPHAN_POLL_MS = 180_000;

/** `state/mod.rs`'s `liq_task_id` — the first 8 bytes of keccak256(position), big-endian into a u64. */
function liqTaskId(position: InstanceType<typeof PublicKey>): bigint {
  const h = keccak_256(position.toBuffer());
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(h[i]);
  return v;
}

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

/**
 * (c) — the shape `undelegate_user`'s debt branch leaves behind, and the shape
 * `close_orphan_queue` (Task 2) keys off.
 *
 * MEASURED (Task 4), and it is not the naive one: the queue does NOT stay
 * readable to its owner. The debt branch rewrites the queue's
 * `EphemeralPermission` to `members = [crank]`, so an owner-token read of it on
 * the TEE returns `null` — the same "invisible" answer a stranger gets. The
 * orphan is visible only to the CRANK, which is exactly who has to find it. And
 * the two accounts that DID leave do not vanish from the ER either: they come
 * back as ordinary `dexxer_core`-owned accounts, no longer under the Delegation
 * Program. Hence the five assertions below, and not "getAccountInfo === null".
 *
 * Idempotent, so it doubles as the re-verification path for a trader that has
 * already exited.
 */
async function verifyOrphanShape(
  owner: any,
  ownerConn: any,
  userAccount: any,
  position: any,
  disclosureQueue: any,
  out: Record<string, unknown>,
): Promise<void> {
  console.log("\n=== (c) polling for the orphan shape (<=180s) ===");
  const crank = loadOrCreateKey("devnet-crank");
  const crankConn = await teeConn(crank);
  const deadline = Date.now() + ORPHAN_POLL_MS;
  let orphanSeen = false;
  const shape: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const [uaL1, posL1, dqL1, dqErCrank, dqErOwner] = await Promise.all([
      baseConn.getAccountInfo(userAccount, "confirmed"),
      baseConn.getAccountInfo(position, "confirmed"),
      baseConn.getAccountInfo(disclosureQueue, "confirmed"),
      crankConn.getAccountInfo(disclosureQueue, "confirmed"),
      ownerConn.getAccountInfo(disclosureQueue, "confirmed"),
    ]);
    shape.l1UserAccountOwner = uaL1?.owner.toBase58() ?? "null";
    shape.l1PositionOwner = posL1?.owner.toBase58() ?? "null";
    shape.l1DisclosureQueueOwner = dqL1?.owner.toBase58() ?? "null";
    shape.erDisclosureQueueAsCrank = dqErCrank === null ? "null" : `owner=${dqErCrank.owner.toBase58()}`;
    shape.erDisclosureQueueAsOwner = dqErOwner === null ? "null" : `owner=${dqErOwner.owner.toBase58()}`;
    const left = !!uaL1 && uaL1.owner.equals(DEXXER_CORE_PROGRAM_ID) && !!posL1 && posL1.owner.equals(DEXXER_CORE_PROGRAM_ID);
    const stayed = !!dqL1 && dqL1.owner.equals(DELEGATION_PROGRAM_ID) && dqErCrank !== null;
    if (left && stayed) { orphanSeen = true; break; }
    await sleep(3000);
  }
  console.log("orphan shape:", shape);
  Object.assign(out, shape);
  out.orphanSeen = orphanSeen;

  const uaL1Final = await baseConn.getAccountInfo(userAccount, "confirmed");
  if (uaL1Final && uaL1Final.owner.equals(DEXXER_CORE_PROGRAM_ID)) {
    const ua = dexxerCoreProgram(baseConn, owner).coder.accounts.decode("userAccount", uaL1Final.data);
    out.l1UserAccountExited = ua.exited;
    out.l1UserAccountVersion = ua.version;
    out.l1UserAccountLen = uaL1Final.data.length;
    console.log("L1 UserAccount:", { version: ua.version, exited: ua.exited, len: uaL1Final.data.length, freeMargin: ua.freeMargin.toString() });
  }
  // The queue's records survived the exit — that is the whole point of the
  // debt branch (they are the only copy of trades already promised to L1).
  if (shape.erDisclosureQueueAsCrank !== "null") {
    const dqLeft = await accountNs(dexxerCoreProgram(crankConn, crank)).disclosureQueue.fetch(disclosureQueue);
    out.orphanQueueLen = dqLeft.len;
    console.log("orphan DisclosureQueue (crank-token read):", { len: dqLeft.len, head: dqLeft.head, owner: dqLeft.owner.toBase58() });
  }

  assert(out.l1UserAccountOwner === DEXXER_CORE_PROGRAM_ID.toBase58(), "(c) L1 UserAccount is back under dexxer_core (undelegated)");
  assert(out.l1PositionOwner === DEXXER_CORE_PROGRAM_ID.toBase58(), "(c) L1 Position is back under dexxer_core (undelegated)");
  assert(out.l1DisclosureQueueOwner === DELEGATION_PROGRAM_ID.toBase58(), "(c) L1 DisclosureQueue is STILL delegated — the queue stayed behind");
  assert(shape.erDisclosureQueueAsCrank !== "null", "(c) the orphan queue is readable in the ER with the CRANK token");
  assert(shape.erDisclosureQueueAsOwner === "null", "(c) the orphan queue is NOT readable with the OWNER token any more (members narrowed to [crank])");
  assert(orphanSeen, "(c) orphan shape reached");
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

  const market = pdas.market();
  const config = pdas.config();
  const userAccount = pdas.userAccount(owner.publicKey);
  const position = pdas.position(owner.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(owner.publicKey);
  const taskId = liqTaskId(position);
  console.log("run id:", runId, "trader:", traderName, "owner:", owner.publicKey.toBase58(), "position:", position.toBase58(), "liq task_id:", taskId.toString());

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
  // fail on the eATA). Re-verify (c) against the state it left instead — the
  // orphan shape is durable, so this is a genuine re-measurement, not a skip.
  const uaL1Pre = await baseConn.getAccountInfo(userAccount, "confirmed");
  if (uaL1Pre && uaL1Pre.owner.equals(DEXXER_CORE_PROGRAM_ID) && dexxerCoreProgram(baseConn, owner).coder.accounts.decode("userAccount", uaL1Pre.data).exited) {
    console.log("\n=== trader has already exited — re-verifying (c) only ===");
    const out: Record<string, unknown> = { owner: owner.publicKey.toBase58(), position: position.toBase58(), disclosureQueue: disclosureQueue.toBase58(), taskId: taskId.toString(), reverifyOnly: true };
    await verifyOrphanShape(owner, await teeConn(owner), userAccount, position, disclosureQueue, out);
    console.log("\n11-LIQ-TASK-MIGRATION (c) RE-VERIFY PASS", JSON.stringify(out));
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
  const exitSalt = new Uint8Array(randomBytes(32));
  const userInfoPre = await baseConn.getAccountInfo(userAccount, "confirmed");
  const initUserSig = userInfoPre
    ? "(exists, skipped)"
    : await core.methods
        .initUser(Array.from(exitSalt))
        .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
        .rpc();
  console.log("faucet_init", faucetSig, "init_user", initUserSig);

  if (userInfoPre && userInfoPre.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.log("delegate_user: already delegated, skipped");
  } else {
  const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { validator: ER_VALIDATOR, initVaultIfMissing: false, idempotent: false });
  const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateSplIxs), [owner], { commitment: "confirmed" });
  const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
  const pt = delegationTriple(position, DEXXER_CORE_PROGRAM_ID);
  const dt = delegationTriple(disclosureQueue, DEXXER_CORE_PROGRAM_ID);
  const delegateUserSig = await core.methods
    .delegateUser()
    .accounts({
      owner: owner.publicKey,
      payer: owner.publicKey,
      config,
      market,
      bufferUserAccount: ut.buffer, delegationRecordUserAccount: ut.record, delegationMetadataUserAccount: ut.metadata, userAccount,
      bufferPosition: pt.buffer, delegationRecordPosition: pt.record, delegationMetadataPosition: pt.metadata, position,
      bufferDisclosureQueue: dt.buffer, delegationRecordDisclosureQueue: dt.record, delegationMetadataDisclosureQueue: dt.metadata, disclosureQueue,
      ownerProgram: DEXXER_CORE_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("delegateSpl", delegateSplSig, "delegate_user", delegateUserSig);
  }
  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, position, "Position");
  await waitDelegated(baseConn, disclosureQueue, "DisclosureQueue");

  const trader = { kp: owner, userAccount, position, disclosureQueue, userAta: ownerAta };
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

  const out: Record<string, unknown> = { owner: owner.publicKey.toBase58(), position: position.toBase58(), disclosureQueue: disclosureQueue.toBase58(), taskId: taskId.toString() };

  // === (b) open_position registers the liquidation task ===
  console.log("\n=== (b) open_position -> ScheduleTask ===");
  const mkt = await accountNs(coreOwnerEr).market.fetch(market);
  const price = BigInt(mkt.mark.toString());
  assert(price > 0n, `Market.mark is seeded (nonzero) — got ${price}`);
  const sizeLamports = BigInt(Math.round(OPEN_SIZE_SOL * 1_000_000_000));
  const notional = (sizeLamports * price) / 1_000_000_000n;
  const marginUsd = (notional * 11n) / 100n; // ~9x, with headroom over imr_bps rounding
  const accts = tradeAccounts(boot, trader);
  console.log(`price(mark)=${price} notional=${notional} margin=${marginUsd}; task_context == position? ${accts.taskContext.equals(position)}`);
  const openIx = await coreOwnerEr.methods
    .openPosition({ long: {} }, new BN(sizeLamports.toString()), new BN(marginUsd.toString()), new BN(U64_MAX.toString()))
    .accounts({ signer: owner.publicKey, ...accts })
    .instruction();
  const posBeforeOpen = await accountNs(coreOwnerEr).position.fetch(position);
  const openSig = "open" in posBeforeOpen.state
    ? "(already Open from an earlier run, skipped)"
    : await sendAndConfirmIx(ownerConn, owner, openIx);
  console.log("open_position", openSig);
  const openMeta = await txMeta(ownerConn, openSig);
  console.log("open_position tx meta from devnet-tee:", JSON.stringify(openMeta));
  const posAfterOpen = await accountNs(coreOwnerEr).position.fetch(position);
  assert("open" in posAfterOpen.state, "Position.state == Open after open_position");
  assert(accts.taskContext.equals(position), "(b) task_context is the position's own key — the duplicate-key case, and it was accepted");
  out.openSig = openSig;
  out.openTxMeta = openMeta;
  out.taskContextEqualsPosition = accts.taskContext.equals(position);
  out.liqCrankSigner = accts.liqCrankSigner.toBase58();

  // === (a) part 1: close_position cancels the LIVE task ===
  console.log("\n=== (a1) close_position -> CancelTask (live id) ===");
  const closeIx = await coreOwnerEr.methods
    .closePosition(new BN("0"))
    .accounts({ signer: owner.publicKey, ...accts })
    .instruction();
  const closeSig = await sendAndConfirmIx(ownerConn, owner, closeIx);
  console.log("close_position", closeSig, "meta:", JSON.stringify(await txMeta(ownerConn, closeSig)));
  const posAfterClose = await accountNs(coreOwnerEr).position.fetch(position);
  const dqAfterClose = await accountNs(coreOwnerEr).disclosureQueue.fetch(disclosureQueue);
  assert("empty" in posAfterClose.state, "Position.state == Empty right after close (week-5 Task 1)");
  assert(dqAfterClose.len === 1, `DisclosureQueue.len == 1 after close (got ${dqAfterClose.len}) — this is the debt (c) needs`);
  out.closeSig = closeSig;
  out.dqLenAfterClose = dqAfterClose.len;

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

  // === (a) part 2 + (c): undelegate_user — cancels the SAME id, now unknown ===
  console.log("\n=== (a2)+(c) undelegate_user with dq.len > 0 (cancel of an unknown task_id) ===");
  const undelegateIx = await coreOwnerEr.methods
    .undelegateUser()
    .accounts({
      owner: owner.publicKey, config, userAccount, position, dq: disclosureQueue,
      userPermission: permissionPdaFromAccount(userAccount),
      positionPermission: permissionPdaFromAccount(position),
      dqPermission: permissionPdaFromAccount(disclosureQueue),
      ephemeralVault: EPHEMERAL_VAULT_ID, permissionProgram: PERMISSION_PROGRAM_ID,
      feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    })
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

  // === (c) the orphan signal: UA/Position leave the ER, the queue stays ===
  await verifyOrphanShape(owner, ownerConn, userAccount, position, disclosureQueue, out);
  console.log("\n11-LIQ-TASK-MIGRATION PASS", JSON.stringify(out));
}

main().catch((e) => {
  console.error("11-liq-task-migration FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
