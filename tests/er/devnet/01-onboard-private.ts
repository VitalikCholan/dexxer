// tests/er/devnet/01-onboard-private.ts
//
// Task 5, script 1 of 4: the full private onboarding sequence against real
// devnet + devnet-tee.magicblock.app, on `dexxer_core` itself (not a spike).
//
// Sequence (spec §8 Q1/Q2, task-5 brief):
//   faucet -> init_user -> delegateSpl -> delegate_user -> credit_deposit (ER,
//   owner token) -> init_permissions (private, members [owner, session,
//   crank]) -> set_session -> fund session's own ER fee balance ->
//   open_position signed ONLY by the session key.
//
// Run: `npm run devnet:onboard` (from tests/er). Requires
// `DEXXER_NET=devnet` and a prior `devnet-bootstrap.ts` run (Task 5 Step 0).
//
// Fresh identities per run (task-5 brief: an eSPL re-cycle bug found in
// week-2 Task 1's M4 makes repeating deposit->undelegate->withdraw on the
// same identity fail `InvalidAccountOwner` — generate a fresh trader/session
// pair every run, funded from `devnet-admin`, not `requestAirdrop`, which is
// unreliable on real devnet). The trader/session keys are persisted under
// `.keys/devnet-trader-<run>.json` / `.keys/devnet-session-<run>.json` (via
// `loadOrCreateKey`, so a unique per-run name never collides with a prior
// run's identity) and the run's pointer + Position pre-delegation snapshot
// are written to `.keys/devnet-run-latest.json` for 02/03/04 to pick up.
//
// Session funding deviates from the brief's literal
// `lamportsDelegatedTransferIx(payer, session, 0.01 SOL)`: that SDK
// instruction requires its `destination` to already be a *delegated*
// base-layer account (confirmed both by the SDK's own
// `references/lamports-topup.md` — "Destination must already be delegated"
// — and empirically here: the same instruction, tried against the
// similarly-undelegated `devnet-fee-payer` while preparing this task, failed
// on-chain with `require!(destination_info.owned_by(&DELEGATION_PROGRAM_ID))
// failed` / `InvalidAccountOwner`). `session` is a plain, never-delegated
// keypair (not a program PDA), so it can never satisfy that precondition.
// The mechanism that actually gives a plain wallet a usable ER fee balance —
// proven across all of week-2 Task 1's M1-M4 measurements, where `payer`,
// `user`, and `crank` all paid ER transaction fees as ordinary, never-
// delegated wallets — is simply holding base-layer SOL (the ER clones a
// referenced non-delegated account's current base state, balance included).
// So session funding here is a plain `SystemProgram.transfer` from the
// trader (owner) to `session` on base layer, same 0.01 SOL amount the brief
// specifies, satisfying its actual intent ("session pays its own ER fees").
import { randomBytes } from "crypto";
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
const {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { ER_VALIDATOR, NET, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { creditDeposit, initPermissions, U64_MAX, usd, solSize } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:onboard`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)
// Live devnet-tee SOL/USD feed read ~$110 while preparing this script — size
// picked so notional (size * price) comfortably exceeds margin (else
// math::liq_price sees leverage < 1x and rejects with InvalidInput) while
// staying inside sol_perp_defaults' 10x max leverage / 10% IMR even if the
// live price moves before this runs (notional/margin ~= 5.5x at $110).
const OPEN_SIZE_SOL = 1.0;
const OPEN_MARGIN_USD = 20;
const SESSION_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const TRADER_FUND_SOL = 0.05;

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = resolve(HERE, "..", ".keys");
const RUN_POINTER_PATH = resolve(KEYS_DIR, "devnet-run-latest.json");

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const crank = loadOrCreateKey("devnet-crank");

  const runId = Date.now();
  const traderName = `devnet-trader-${runId}`;
  const sessionName = `devnet-session-${runId}`;
  const owner = loadOrCreateKey(traderName);
  const session = loadOrCreateKey(sessionName);
  console.log("run id:", runId);
  console.log("trader (owner):", owner.publicKey.toBase58());
  console.log("session:", session.publicKey.toBase58());
  console.log("crank (permission member, devnet-crank):", crank.publicKey.toBase58());

  // --- fund the fresh trader from devnet-admin (real devnet: no faucet on
  // baseConn, requestAirdrop is unreliable/rate-limited) ---
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
    .accounts({
      owner: owner.publicKey,
      payer: owner.publicKey,
      config,
      faucet: faucetPda,
      dusdcMint: boot.mint,
      mintAuth,
      ownerAta,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("faucet_init", faucetSig);

  console.log("=== init_user ===");
  // Week 3: per-user secret salting this account's leaf in the public `BalancesRoot`.
  const exitSalt = new Uint8Array(randomBytes(32));
  const initUserSig = await core.methods
    .initUser(Array.from(exitSalt))
    .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("init_user", initUserSig);

  // --- pre-delegation Position byte snapshot (task-5 brief: for 02's
  // leak-test comparison against what base RPC still shows post-delegation) ---
  const positionPreDelegateInfo = await baseConn.getAccountInfo(position, "confirmed");
  assert(positionPreDelegateInfo !== null, "Position account exists pre-delegation (readable snapshot)");
  const positionSnapshotB64 = positionPreDelegateInfo!.data.toString("base64");
  console.log("Position pre-delegation snapshot:", positionPreDelegateInfo!.data.length, "bytes, owner", positionPreDelegateInfo!.owner.toBase58());

  console.log("=== delegateSpl (deposit) ===");
  const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, {
    validator: ER_VALIDATOR,
    initVaultIfMissing: false,
    idempotent: false,
  });
  const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateSplIxs), [owner], { commitment: "confirmed" });
  console.log("delegateSpl", delegateSplSig);

  console.log("=== delegate_user ===");
  const ut = delegationTriple(userAccount, DEXXER_CORE_PROGRAM_ID);
  const pt = delegationTriple(position, DEXXER_CORE_PROGRAM_ID);
  const dt = delegationTriple(disclosureQueue, DEXXER_CORE_PROGRAM_ID);
  const delegateUserSig = await core.methods
    .delegateUser()
    .accounts({
      owner: owner.publicKey,
      config,
      market,
      bufferUserAccount: ut.buffer,
      delegationRecordUserAccount: ut.record,
      delegationMetadataUserAccount: ut.metadata,
      userAccount,
      bufferPosition: pt.buffer,
      delegationRecordPosition: pt.record,
      delegationMetadataPosition: pt.metadata,
      position,
      bufferDisclosureQueue: dt.buffer,
      delegationRecordDisclosureQueue: dt.record,
      delegationMetadataDisclosureQueue: dt.metadata,
      disclosureQueue,
      ownerProgram: DEXXER_CORE_PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("delegate_user", delegateUserSig);

  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, position, "Position");
  await waitDelegated(baseConn, disclosureQueue, "DisclosureQueue");

  console.log("=== credit_deposit (ER, owner token) ===");
  const trader = { kp: owner, userAccount, position, disclosureQueue, userAta: ownerAta };
  const creditSig = await creditDeposit(boot, trader, DEPOSIT);
  console.log("credit_deposit", creditSig);

  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
  const userAccountAfterDeposit = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  assert(
    userAccountAfterDeposit.freeMargin.toString() === DEPOSIT.toString(),
    `ER UserAccount.free_margin == ${DEPOSIT} (got ${userAccountAfterDeposit.freeMargin.toString()})`,
  );

  console.log("=== init_permissions (ER, private, members=[owner, crank] — session not set yet) ===");
  const initPermSig = await initPermissions(trader);
  console.log("init_permissions", initPermSig);

  console.log("=== set_session (ER, rebuilds members=[owner, session, crank]) ===");
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const userPermission = permissionPdaFromAccount(userAccount);
  const positionPermission = permissionPdaFromAccount(position);
  const dqPermission = permissionPdaFromAccount(disclosureQueue);
  const setSessionIx = await coreOwnerEr.methods
    .setSession(session.publicKey, new BN(expiry), 20)
    .accounts({
      owner: owner.publicKey,
      config,
      market,
      userAccount,
      position,
      disclosureQueue,
      userPermission,
      positionPermission,
      dqPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction();
  const setSessionSig = await sendAndConfirmIx(ownerConn, owner, setSessionIx);
  console.log("set_session", setSessionSig, "expiry", expiry, "actions", 20);

  console.log("=== fund session's own ER fee balance (0.01 SOL, base-layer transfer — see header comment) ===");
  const fundSessionSig = await sendAndConfirmTransaction(
    baseConn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: session.publicKey, lamports: SESSION_LAMPORTS })),
    [owner],
    { commitment: "confirmed" },
  );
  console.log("fund session", fundSessionSig, `(${SESSION_LAMPORTS} lamports)`);

  console.log("=== open_position (ER, signed ONLY by session) ===");
  const sessionConn = await teeConn(session);
  const coreSessionEr = dexxerCoreProgram(sessionConn, session);
  const marketRisk = pdas.marketRisk(market);
  const openIx = await coreSessionEr.methods
    .openPosition({ long: {} }, new BN(solSize(OPEN_SIZE_SOL).toString()), new BN(usd(OPEN_MARGIN_USD).toString()), new BN(U64_MAX.toString()))
    .accounts({
      signer: session.publicKey,
      config,
      market,
      marketRisk,
      poolLive: boot.poolLive,
      userAccount,
      position,
      feed: boot.feed,
    })
    .instruction();
  const openSig = await sendAndConfirmIx(sessionConn, session, openIx);
  console.log("open_position (session-signed)", openSig);

  // --- assert: Position.state == Open, read via OWNER token (proves owner
  // retains read visibility even though session signed the tx) ---
  const positionAfterOpen = await accountNs(coreOwnerEr).position.fetch(position);
  assert("open" in positionAfterOpen.state, `Position.state == Open (got ${JSON.stringify(positionAfterOpen.state)})`);
  console.log("Position after open (owner-token read):", {
    state: positionAfterOpen.state,
    side: positionAfterOpen.side,
    size: positionAfterOpen.size.toString(),
    entry: positionAfterOpen.entry.toString(),
    margin: positionAfterOpen.margin.toString(),
  });

  // --- persist run state for 02/03/04 ---
  const runState = {
    runId,
    traderName,
    sessionName,
    owner: owner.publicKey.toBase58(),
    session: session.publicKey.toBase58(),
    crank: crank.publicKey.toBase58(),
    mint: boot.mint.toBase58(),
    market: market.toBase58(),
    marketRisk: marketRisk.toBase58(),
    pool: boot.pool.toBase58(),
    poolAta: boot.poolAta.toBase58(),
    feed: boot.feed.toBase58(),
    config: config.toBase58(),
    userAccount: userAccount.toBase58(),
    position: position.toBase58(),
    disclosureQueue: disclosureQueue.toBase58(),
    userAta: ownerAta.toBase58(),
    positionSnapshotB64,
    sigs: {
      fundSig,
      faucetSig,
      initUserSig,
      delegateSplSig,
      delegateUserSig,
      creditSig,
      initPermSig,
      setSessionSig,
      fundSessionSig,
      openSig,
    },
  };
  writeFileSync(RUN_POINTER_PATH, JSON.stringify(runState, null, 2));
  console.log("\nrun state persisted:", RUN_POINTER_PATH);
  console.log("\n01-ONBOARD-PRIVATE PASS", { owner: runState.owner, session: runState.session, position: runState.position, openSig });
}

main().catch((e) => {
  console.error("01-onboard-private FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
