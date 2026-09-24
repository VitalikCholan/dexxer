// tests/er/devnet/15-exit-debt.ts
//
// Week-5 Task 7, M-I: a wallet that has held 0 SOL for its entire life,
// onboarded purely through `POST /sponsor` (the same L1a/L1b leg shapes
// `app/src/features/onboard/batchOnboarding.ts` builds and
// `services/relayer/src/sponsor.ts` whitelists), trades once, exits with a
// disclosure debt still owed (`undelegate_user` while `DisclosureQueue.len
// > 0`), and is observed all the way through the relayer's automatic
// recovery: disclosure cycle drains the queue -> orphan janitor's ER pass
// (`close_orphan_queue`) -> orphan janitor's base pass (`close_exited_user`,
// rent back to `fee_payer`) -> re-onboarding.
//
// Two wallets:
//   wallet 1 — full path, observed to completion (fee_payer rent-back +
//     `init_user` on the closed trio).
//   wallet 2 — the race: re-onboard is attempted IMMEDIATELY after
//     `undelegate_user` (queue still delegated -> expected failure), then
//     retried the moment the queue comes back under `dexxer_core` on base
//     (the janitor's ER pass landed) but — per `instructions/user.rs`'s
//     `InitUserReuseQueue`/`CloseExitedUser` doc comments — BEFORE the
//     janitor's base pass has closed the trio (`init_user_reuse_queue`'s
//     window). Whichever instruction the on-chain state actually calls for
//     at retry time is used, and the outcome is recorded either way.
//
// Real finding under test: `POST /sponsor` never sponsors the ER leg
// (`init_permissions`+`set_session` — devnet-tee rejects a foreign
// `fee_payer` as an ER tx's own fee payer, week-5 Task 5) or any later
// owner-signed ER instruction (`credit_deposit`, `open_position`,
// `close_position`, `withdraw`, `undelegate_user`). A wallet that has NEVER
// held any L1 SOL is therefore attempted first, exactly as is; if the ER
// leg is rejected for insufficient funds, the exact error is recorded and
// a minimal `TOPUP_LAMPORTS` top-up (from `devnet-admin`, NOT the sponsor)
// unblocks the rest of the measurement — this is the actual "how far does
// 0-SOL onboarding get you" answer the task wants.
//
// Run: `npm run devnet:exitdebt` (from tests/er).

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
const { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { NET, baseConn, confirmSignature, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { closePosition, openPosition, U64_MAX } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:exitdebt`);
  process.exit(1);
}

const RELAYER_URL = process.env.RELAYER_URL ?? "https://relayer-production-1ae7.up.railway.app";
const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC
// 05/06's proven sizing (see 14-close-reopen.ts's note): notional must
// exceed margin or open_position hard-fails InvalidInput (math.rs: margin >
// notional has no liquidation price).
const OPEN_SIZE_SOL = 1.0;
const OPEN_MARGIN_USD = 20;
// A dust top-up, sourced from devnet-admin (never the sponsor), used ONLY if
// the ER leg genuinely rejects a 0-lamport owner — see the file header.
// Covers ~dozens of ER tx fees (init_permissions, set_session,
// credit_deposit, open, close, withdraw, undelegate_user).
const TOPUP_LAMPORTS = 10_000_000; // 0.01 SOL
const JANITOR_POLL_MS = 240_000; // 4 min ceiling on the full auto-drain wait
const RACE_POLL_MS = 150_000; // wallet-2 race window poll ceiling

interface SponsorResult {
  ok: boolean;
  tx?: InstanceType<typeof Transaction>;
  error?: string;
  status?: number;
}

async function postSponsor(tx: InstanceType<typeof Transaction>): Promise<SponsorResult> {
  const body = JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") });
  const res = await fetch(`${RELAYER_URL}/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const payload = (await res.json().catch(() => ({}))) as { tx?: string; error?: string };
  if (!res.ok) return { ok: false, error: payload.error ?? `HTTP ${res.status}`, status: res.status };
  if (!payload.tx) return { ok: false, error: "200 without a tx", status: res.status };
  return { ok: true, tx: Transaction.from(Buffer.from(payload.tx, "base64")) };
}

/** Build, owner-partial-sign, POST /sponsor, submit + confirm on base. Throws on any failure (sponsor rejection or on-chain failure) with a descriptive message. */
async function sponsoredSend(owner: InstanceType<typeof Keypair>, feePayerPubkey: InstanceType<typeof PublicKey>, ixs: InstanceType<typeof import("@solana/web3.js").TransactionInstruction>[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayerPubkey;
  tx.recentBlockhash = (await baseConn.getLatestBlockhash()).blockhash;
  tx.partialSign(owner);
  const result = await postSponsor(tx);
  if (!result.ok) throw new Error(`${label}: /sponsor rejected (${result.status}): ${result.error}`);
  const sig = await baseConn.sendRawTransaction(result.tx!.serialize(), { skipPreflight: true });
  await confirmSignature(baseConn, sig);
  console.log(`${label} (sponsored):`, sig);
  return sig;
}

interface ZeroSolCtx {
  name: string;
  owner: InstanceType<typeof Keypair>;
  userAccount: InstanceType<typeof PublicKey>;
  position: InstanceType<typeof PublicKey>;
  disclosureQueue: InstanceType<typeof PublicKey>;
  ownerAta: InstanceType<typeof PublicKey>;
  sigs: Record<string, string>;
  topUpSig: string | null;
  topUpLamports: number;
  erLegZeroSolError: string | null;
}

/**
 * Full onboard-trade-exit-with-debt for one NEVER-FUNDED wallet, through
 * `undelegate_user`. Returns the context; does NOT wait for the janitor.
 */
async function zeroSolOnboardTradeExit(boot: Awaited<ReturnType<typeof bootstrapDevnet>>, name: string): Promise<ZeroSolCtx> {
  const admin = loadOrCreateKey("devnet-admin");
  const feePayerPubkey = boot.feePayer.publicKey;
  const owner = Keypair.generate(); // genuinely fresh, never persisted, never funded
  console.log(`\n--- ${name}: owner ${owner.publicKey.toBase58()} (0 SOL, never funded) ---`);

  const config = pdas.config();
  const market = pdas.market();
  const userAccount = pdas.userAccount(owner.publicKey);
  const position = pdas.position(owner.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(owner.publicKey);
  const faucetPda = pdas.faucet(owner.publicKey);
  const mintAuth = pdas.mintAuth();
  const ownerAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);
  const core = dexxerCoreProgram(baseConn, owner);
  const sigs: Record<string, string> = {};

  console.log(`${name}: balance before anything =`, await baseConn.getBalance(owner.publicKey, "confirmed"), "lamports");

  // --- L1a: ATA(payer=feePayer) + faucet_init(payer=feePayer) + init_user(payer=feePayer) ---
  const exitSalt = new Uint8Array(randomBytes(32));
  const l1a = [
    createAssociatedTokenAccountIdempotentInstruction(feePayerPubkey, ownerAta, owner.publicKey, boot.mint),
    await core.methods
      .faucetInit(new BN(DEPOSIT.toString()))
      .accounts({ owner: owner.publicKey, payer: feePayerPubkey, config, faucet: faucetPda, dusdcMint: boot.mint, mintAuth, ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction(),
    await core.methods
      .initUser(Array.from(exitSalt))
      .accounts({ owner: owner.publicKey, payer: feePayerPubkey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
      .instruction(),
  ];
  sigs.l1a = await sponsoredSend(owner, feePayerPubkey, l1a, `${name} L1a (ata+faucet_init+init_user)`);

  // --- L1b: delegateSpl(payer=feePayer) + delegate_user(payer=feePayer) ---
  const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { payer: feePayerPubkey, validator: envMod.ER_VALIDATOR, initVaultIfMissing: false, idempotent: false });
  const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
  const pt = delegationTriple(position, DEXXER_CORE_PROGRAM_ID);
  const dt = delegationTriple(disclosureQueue, DEXXER_CORE_PROGRAM_ID);
  const l1b = [
    ...delegateSplIxs,
    await core.methods
      .delegateUser()
      .accounts({
        owner: owner.publicKey, payer: feePayerPubkey, config, market,
        bufferUserAccount: ut.buffer, delegationRecordUserAccount: ut.record, delegationMetadataUserAccount: ut.metadata, userAccount,
        bufferPosition: pt.buffer, delegationRecordPosition: pt.record, delegationMetadataPosition: pt.metadata, position,
        bufferDisclosureQueue: dt.buffer, delegationRecordDisclosureQueue: dt.record, delegationMetadataDisclosureQueue: dt.metadata, disclosureQueue,
        ownerProgram: DEXXER_CORE_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .instruction(),
  ];
  sigs.l1b = await sponsoredSend(owner, feePayerPubkey, l1b, `${name} L1b (delegateSpl+delegate_user)`);
  await envMod.waitDelegated(baseConn, userAccount, `${name} UserAccount`);
  await envMod.waitDelegated(baseConn, position, `${name} Position`);
  await envMod.waitDelegated(baseConn, disclosureQueue, `${name} DisclosureQueue`);
  console.log(`${name}: owner balance after both sponsored L1 legs (should be unchanged, still 0) =`, await baseConn.getBalance(owner.publicKey, "confirmed"), "lamports");

  // --- ER leg: init_permissions + set_session — UNSPONSORABLE (week-5 Task
  // 5 finding). Attempt it exactly as a real 0-SOL owner would first. ---
  const ownerTee = await teeConn(owner);
  const coreEr = dexxerCoreProgram(ownerTee, owner);
  const session = Keypair.generate();
  const userPermission = permissionPdaFromAccount(userAccount);
  const positionPermission = permissionPdaFromAccount(position);
  const dqPermission = permissionPdaFromAccount(disclosureQueue);
  const permAccounts = { owner: owner.publicKey, config, market, userAccount, position, disclosureQueue, userPermission, positionPermission, dqPermission, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const erLegIxs = [
    await coreEr.methods.initPermissions().accounts(permAccounts).instruction(),
    await coreEr.methods.setSession(session.publicKey, new BN(expiry), 20).accounts(permAccounts).instruction(),
  ];

  let erLegZeroSolError: string | null = null;
  let topUpSig: string | null = null;
  let topUpLamports = 0;
  try {
    const tx = new Transaction().add(...erLegIxs);
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await ownerTee.getLatestBlockhash()).blockhash;
    tx.sign(owner);
    const sig = await ownerTee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await confirmSignature(ownerTee, sig);
    sigs.erLeg = sig;
    console.log(`${name}: ER leg (init_permissions+set_session) SUCCEEDED at 0 SOL:`, sig, "— real finding: no ER balance floor observed");
  } catch (e: any) {
    erLegZeroSolError = e.message ?? String(e);
    console.log(`${name}: ER leg FAILED at 0 SOL (expected finding): ${erLegZeroSolError}`);
    console.log(`${name}: topping up ${TOPUP_LAMPORTS} lamports from devnet-admin (NOT the sponsor) to unblock the rest of the measurement`);
    topUpSig = await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: TOPUP_LAMPORTS })),
      [admin],
      { commitment: "confirmed" },
    );
    topUpLamports = TOPUP_LAMPORTS;
    console.log(`${name}: top-up`, topUpSig, `— owner base balance now`, await baseConn.getBalance(owner.publicKey, "confirmed"));

    const tx2 = new Transaction().add(...erLegIxs);
    tx2.feePayer = owner.publicKey;
    tx2.recentBlockhash = (await ownerTee.getLatestBlockhash()).blockhash;
    tx2.sign(owner);
    const sig2 = await ownerTee.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
    await confirmSignature(ownerTee, sig2);
    sigs.erLeg = sig2;
    console.log(`${name}: ER leg SUCCEEDED after top-up:`, sig2);
  }

  // --- credit_deposit (ER, owner-paid) ---
  const creditIx = await coreEr.methods
    .creditDeposit(new BN(DEPOSIT.toString()))
    .accounts({ owner: owner.publicKey, userAccount, pool: boot.pool, poolLive: boot.poolLive, ownerAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction();
  sigs.creditDeposit = await sendAndConfirmIx(ownerTee, owner, creditIx);
  console.log(`${name}: credit_deposit`, sigs.creditDeposit);

  // --- Long -> Close (owner-signed, no session needed for this measurement) ---
  const traderCtx = { name, kp: owner, userAccount, position, disclosureQueue, userAta: ownerAta, exitSalt, sigs: {} as Record<string, string>, creditDepositCU: null as number | null };
  sigs.open = await openPosition(boot, traderCtx as any, "long", OPEN_SIZE_SOL, OPEN_MARGIN_USD, 1_000_000);
  console.log(`${name}: open_position`, sigs.open);
  sigs.close = await closePosition(boot, traderCtx as any, 0);
  console.log(`${name}: close_position`, sigs.close);
  const dqAfterClose = await accountNs(coreEr).disclosureQueue.fetch(disclosureQueue);
  assert(dqAfterClose.len === 1, `${name}: DisclosureQueue.len == 1 after close (got ${dqAfterClose.len})`);

  // --- withdraw(all) ---
  const uaBefore = await accountNs(coreEr).userAccount.fetch(userAccount);
  const freeMargin = BigInt(uaBefore.freeMargin.toString());
  const cfg = await accountNs(coreEr).config.fetch(config);
  const withdrawIx = await coreEr.methods
    .withdraw(new BN(freeMargin.toString()))
    .accounts({
      owner: owner.publicKey, userAccount, pool: boot.pool, poolLive: boot.poolLive, ownerAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID,
      config, feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  sigs.withdraw = await sendAndConfirmIx(ownerTee, owner, withdrawIx);
  console.log(`${name}: withdraw(${freeMargin})`, sigs.withdraw);

  // --- undelegate_user (partial — DisclosureQueue.len == 1, left behind on purpose) ---
  const undelegateIx = await coreEr.methods
    .undelegateUser()
    .accounts({
      owner: owner.publicKey, config, userAccount, position, dq: disclosureQueue,
      userPermission, positionPermission, dqPermission,
      ephemeralVault: EPHEMERAL_VAULT_ID, permissionProgram: PERMISSION_PROGRAM_ID,
      feeEscrow: boot.feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  sigs.undelegateUser = await sendAndConfirmIx(ownerTee, owner, undelegateIx);
  console.log(`${name}: undelegate_user (partial — dq.len=1 left behind)`, sigs.undelegateUser);

  return { name, owner, userAccount, position, disclosureQueue, ownerAta, sigs, topUpSig, topUpLamports, erLegZeroSolError };
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const feePayerPubkey = boot.feePayer.publicKey;
  const out: Record<string, unknown> = {};

  const feePayerBalBefore = await baseConn.getBalance(feePayerPubkey, "confirmed");
  console.log("fee_payer balance before:", feePayerBalBefore / LAMPORTS_PER_SOL, "SOL");
  out.feePayerBalBeforeSol = feePayerBalBefore / LAMPORTS_PER_SOL;

  // =====================================================================
  // Wallet 1: full path, observed to the janitor's completion + re-onboard.
  // =====================================================================
  console.log("\n\n########## wallet 1: full auto-drain observed to completion ##########");
  const w1 = await zeroSolOnboardTradeExit(boot, "wallet1");
  out.w1 = { owner: w1.owner.publicKey.toBase58(), sigs: w1.sigs, erLegZeroSolError: w1.erLegZeroSolError, topUpSig: w1.topUpSig, topUpLamports: w1.topUpLamports };

  console.log(`\n=== waiting (<=${JANITOR_POLL_MS / 1000}s) for: disclosure drain -> orphan ER pass -> orphan base pass (fee_payer rent-back) ===`);
  const crank = loadOrCreateKey("devnet-crank");
  const crankConn = await teeConn(crank);
  const crankCore = dexxerCoreProgram(crankConn, crank);

  let dqDrainedAt: number | null = null;
  let erUndelegatedAt: number | null = null;
  let baseClosedAt: number | null = null;
  const t0 = Date.now();
  const deadline1 = t0 + JANITOR_POLL_MS;
  while (Date.now() < deadline1) {
    // Base pass: all three PDAs gone.
    const uaInfo = await baseConn.getAccountInfo(w1.userAccount, "confirmed");
    if (uaInfo === null) {
      baseClosedAt = Date.now();
      break;
    }
    // ER pass: DisclosureQueue back under dexxer_core on BASE (not the crank-token ER read — the base owner is the ground truth for "undelegated").
    if (erUndelegatedAt === null) {
      const dqBaseInfo = await baseConn.getAccountInfo(w1.disclosureQueue, "confirmed");
      if (dqBaseInfo && dqBaseInfo.owner.equals(DEXXER_CORE_PROGRAM_ID)) {
        erUndelegatedAt = Date.now();
        console.log(`  orphan ER pass landed (DisclosureQueue back under dexxer_core on base) at t+${((erUndelegatedAt - t0) / 1000).toFixed(1)}s`);
      }
    }
    if (dqDrainedAt === null) {
      try {
        const dq = await accountNs(crankCore).disclosureQueue.fetch(w1.disclosureQueue);
        if (dq.len === 0) {
          dqDrainedAt = Date.now();
          console.log(`  disclosure cycle drained the queue (len 1 -> 0) at t+${((dqDrainedAt - t0) / 1000).toFixed(1)}s`);
        }
      } catch {
        // already undelegated/closed; the base-owned checks above cover it
      }
    }
    await sleep(5000);
  }
  out.w1DqDrainedAfterSeconds = dqDrainedAt ? (dqDrainedAt - t0) / 1000 : null;
  out.w1ErUndelegatedAfterSeconds = erUndelegatedAt ? (erUndelegatedAt - t0) / 1000 : null;
  out.w1BaseClosedAfterSeconds = baseClosedAt ? (baseClosedAt - t0) / 1000 : null;

  const feePayerBalAfterJanitor = await baseConn.getBalance(feePayerPubkey, "confirmed");
  out.feePayerBalAfterJanitorSol = feePayerBalAfterJanitor / LAMPORTS_PER_SOL;
  out.feePayerRentBackSol = (feePayerBalAfterJanitor - feePayerBalBefore) / LAMPORTS_PER_SOL;
  console.log(
    baseClosedAt
      ? `wallet1: FULL JANITOR CYCLE OBSERVED — trio closed, fee_payer balance +${((feePayerBalAfterJanitor - feePayerBalBefore) / LAMPORTS_PER_SOL).toFixed(9)} SOL`
      : `wallet1 FAIL: trio did not close within ${JANITOR_POLL_MS / 1000}s (dqDrained=${!!dqDrainedAt}, erUndelegated=${!!erUndelegatedAt})`,
  );

  if (baseClosedAt) {
    console.log("\n=== wallet1: re-onboard (fresh trio, faucet already exists -> init_user only) ===");
    const config = pdas.config();
    const market = pdas.market();
    const initUserSig = await sponsoredSend(
      w1.owner, feePayerPubkey,
      [
        await dexxerCoreProgram(baseConn, w1.owner).methods
          .initUser(Array.from(new Uint8Array(randomBytes(32))))
          .accounts({ owner: w1.owner.publicKey, payer: feePayerPubkey, config, market, userAccount: w1.userAccount, position: w1.position, disclosureQueue: w1.disclosureQueue, systemProgram: SystemProgram.programId })
          .instruction(),
      ],
      "wallet1 re-onboard (init_user)",
    );
    out.w1ReonboardSig = initUserSig;
    out.w1ReonboardOk = true;
    console.log("wallet1: re-onboard init_user SUCCEEDED:", initUserSig);
  } else {
    out.w1ReonboardOk = false;
  }

  // =====================================================================
  // Wallet 2: the race — re-onboard attempted immediately, then at the
  // moment the queue comes back to base (before the base pass runs).
  // =====================================================================
  console.log("\n\n########## wallet 2: race — re-onboard immediately, then at the ER-pass window ##########");
  const w2 = await zeroSolOnboardTradeExit(boot, "wallet2");
  out.w2 = { owner: w2.owner.publicKey.toBase58(), sigs: w2.sigs, erLegZeroSolError: w2.erLegZeroSolError, topUpSig: w2.topUpSig, topUpLamports: w2.topUpLamports };

  const config = pdas.config();
  const market = pdas.market();
  function initUserReuseQueueIx(w: ZeroSolCtx) {
    return dexxerCoreProgram(baseConn, w.owner).methods
      .initUserReuseQueue(Array.from(new Uint8Array(randomBytes(32))))
      .accounts({ owner: w.owner.publicKey, payer: feePayerPubkey, config, market, userAccount: w.userAccount, position: w.position, disclosureQueue: w.disclosureQueue, systemProgram: SystemProgram.programId })
      .instruction();
  }

  console.log("\n=== wallet2: attempt #1 — init_user_reuse_queue IMMEDIATELY after undelegate_user (expect failure: queue still delegated) ===");
  let immediateResult: { ok: boolean; sig?: string; error?: string };
  try {
    const sig = await sponsoredSend(w2.owner, feePayerPubkey, [await initUserReuseQueueIx(w2)], "wallet2 immediate init_user_reuse_queue");
    immediateResult = { ok: true, sig };
    console.log("wallet2: UNEXPECTED — immediate re-onboard succeeded:", sig);
  } catch (e: any) {
    immediateResult = { ok: false, error: e.message ?? String(e) };
    console.log("wallet2: immediate re-onboard FAILED as expected:", immediateResult.error);
  }
  out.w2ImmediateAttempt = immediateResult;

  console.log(`\n=== wallet2: polling (<=${RACE_POLL_MS / 1000}s) for the window — DisclosureQueue back under dexxer_core on base (ER pass landed), racing the base pass ===`);
  const t2 = Date.now();
  let windowOpenedAt: number | null = null;
  let raceResult: { ok: boolean; sig?: string; error?: string; usedInstruction?: string } | null = null;
  const deadline2 = t2 + RACE_POLL_MS;
  while (Date.now() < deadline2) {
    const dqInfo = await baseConn.getAccountInfo(w2.disclosureQueue, "confirmed");
    const uaInfo = await baseConn.getAccountInfo(w2.userAccount, "confirmed");
    if (uaInfo === null) {
      // Base pass already ran (trio closed) before we could race it — record and use init_user.
      console.log(`  base pass beat the race at t+${((Date.now() - t2) / 1000).toFixed(1)}s (trio already closed) — falling back to init_user`);
      try {
        const sig = await sponsoredSend(
          w2.owner, feePayerPubkey,
          [
            await dexxerCoreProgram(baseConn, w2.owner).methods
              .initUser(Array.from(new Uint8Array(randomBytes(32))))
              .accounts({ owner: w2.owner.publicKey, payer: feePayerPubkey, config, market, userAccount: w2.userAccount, position: w2.position, disclosureQueue: w2.disclosureQueue, systemProgram: SystemProgram.programId })
              .instruction(),
          ],
          "wallet2 post-janitor init_user",
        );
        raceResult = { ok: true, sig, usedInstruction: "init_user (base pass had already closed the trio)" };
      } catch (e: any) {
        raceResult = { ok: false, error: e.message ?? String(e), usedInstruction: "init_user (attempted)" };
      }
      break;
    }
    if (dqInfo && dqInfo.owner.equals(DEXXER_CORE_PROGRAM_ID)) {
      windowOpenedAt = Date.now();
      console.log(`  window opened at t+${((windowOpenedAt - t2) / 1000).toFixed(1)}s (DisclosureQueue back under dexxer_core, trio not yet closed) — racing init_user_reuse_queue now`);
      try {
        const sig = await sponsoredSend(w2.owner, feePayerPubkey, [await initUserReuseQueueIx(w2)], "wallet2 windowed init_user_reuse_queue");
        raceResult = { ok: true, sig, usedInstruction: "init_user_reuse_queue (won the race)" };
      } catch (e: any) {
        raceResult = { ok: false, error: e.message ?? String(e), usedInstruction: "init_user_reuse_queue (lost the race after the window looked open)" };
      }
      break;
    }
    await sleep(3000);
  }
  out.w2WindowOpenedAfterSeconds = windowOpenedAt ? (windowOpenedAt - t2) / 1000 : null;
  out.w2RaceResult = raceResult ?? { ok: false, error: `timeout after ${RACE_POLL_MS / 1000}s waiting for the window` };
  console.log("wallet2 race result:", JSON.stringify(out.w2RaceResult));

  const feePayerBalFinal = await baseConn.getBalance(feePayerPubkey, "confirmed");
  out.feePayerBalFinalSol = feePayerBalFinal / LAMPORTS_PER_SOL;
  out.feePayerNetDeltaSol = (feePayerBalFinal - feePayerBalBefore) / LAMPORTS_PER_SOL;

  const overallPass = out.w1ReonboardOk === true && (out.w2RaceResult as { ok: boolean }).ok === true && immediateResult.ok === false;
  console.log("\n15-EXIT-DEBT", overallPass ? "PASS" : "PARTIAL/FAIL — see individual flags above", JSON.stringify(out, null, 2));
  if (!overallPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error("15-exit-debt FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
