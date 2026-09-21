// tests/er/devnet/05-crank-liquidation.ts
//
// Task 6 verification (c): end-to-end liquidation via the crank-fallback
// script running against devnet-tee. Onboards a fresh private trader
// (mirroring 01-onboard-private.ts's sequence, reusing the same
// lib/trader.ts helpers it uses: `creditDeposit`/`initPermissions`), opens a
// ~10x long, then — as admin — raises `Market.mmr_bps` far above the
// position's actual margin ratio (`set_params`) so it becomes liquidatable
// on the very next tick that reads it. Polls `Position.liq_ticks`/`state`
// (owner-token read) until the crank (running separately —
// `scripts/crank-fallback/index.ts` with `DEXXER_NET=devnet`, started
// beforehand) liquidates it, then restores the market's original params —
// mandatory: this is a shared devnet market, other Task 6 verification runs
// depend on it having sane params afterward — and verifies the restore
// on-chain before exiting.
//
// This script does NOT itself run any crank ticks: the whole point is to
// exercise the fallback script as the actual crank membership/candidate-
// discovery mechanism under test. Run scripts/crank-fallback/index.ts
// (DEXXER_NET=devnet) in another process first, then this script.
//
// Run: `npm run devnet:liquidation` (from tests/er), or directly:
//   cd tests/er && DEXXER_NET=devnet npx tsx devnet/05-crank-liquidation.ts

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
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { ER_VALIDATOR, NET, baseConn, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, delegationTriple, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const { creditDeposit, initPermissions, U64_MAX } = await import("../lib/trader.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:liquidation`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)
const OPEN_SIZE_SOL = 1.0;
const SESSION_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const TRADER_FUND_SOL = 0.05;
// Extreme-liquidation params (task-6 brief: `set_params(mmr_bps: 9_500)`).
// `imr_bps` bumped alongside it purely to keep `MarketParams::validate()`
// happy (`imr_bps > mmr_bps` is enforced on-chain, state/market.rs) — the
// already-open position's leverage was checked against the ORIGINAL imr_bps
// at open time and is never re-checked against imr_bps afterward, only
// against mmr_bps at each crank tick (risk::liquidatable_now), so this
// temporary bump has no effect on the test besides satisfying validate().
const LIQ_MMR_BPS = 9_500;
const LIQ_IMR_BPS = 9_600;
const POLL_TRIES = 90;
const POLL_DELAY_MS = 1000;

const MARKET_PARAM_FIELDS = [
  "maxLevBps",
  "imrBps",
  "mmrBps",
  "openFeeBps",
  "closeFeeBps",
  "liqFeeBps",
  "oiCap",
  "maxPosition",
  "minSize",
  "maxStalenessSecs",
  "maxConfBps",
  "maxDeviationBps",
  "emaAlphaBps",
  "liqHysteresisTicks",
  "maxStaleTicks",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractParams(marketAcc: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of MARKET_PARAM_FIELDS) out[f] = marketAcc[f];
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paramsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return MARKET_PARAM_FIELDS.every((f) => String(a[f]) === String(b[f]));
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const admin = loadOrCreateKey("devnet-admin");
  const crank = loadOrCreateKey("devnet-crank");

  const runId = Date.now();
  const traderName = `devnet-trader-liq-${runId}`;
  const sessionName = `devnet-session-liq-${runId}`;
  const owner = loadOrCreateKey(traderName);
  const session = loadOrCreateKey(sessionName);
  console.log("run id:", runId, "owner:", owner.publicKey.toBase58(), "session:", session.publicKey.toBase58(), "crank (permission member):", crank.publicKey.toBase58());

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

  console.log("=== faucet + init_user ===");
  await getOrCreateAssociatedTokenAccount(baseConn, owner, boot.mint, owner.publicKey);
  const faucetSig = await core.methods
    .faucetInit(new BN(DEPOSIT.toString()))
    .accounts({ owner: owner.publicKey, config, faucet: faucetPda, dusdcMint: boot.mint, mintAuth, ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  const exitSalt = new Uint8Array(randomBytes(32));
  const initUserSig = await core.methods
    .initUser(Array.from(exitSalt))
    .accounts({ owner: owner.publicKey, config, market, userAccount, position, disclosureQueue, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("faucet_init", faucetSig, "init_user", initUserSig);

  console.log("=== delegateSpl + delegate_user ===");
  const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { validator: ER_VALIDATOR, initVaultIfMissing: false, idempotent: false });
  const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateSplIxs), [owner], { commitment: "confirmed" });
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
  console.log("delegateSpl", delegateSplSig, "delegate_user", delegateUserSig);
  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, position, "Position");
  await waitDelegated(baseConn, disclosureQueue, "DisclosureQueue");

  console.log("=== credit_deposit + init_permissions (ER) ===");
  const trader = { kp: owner, userAccount, position, disclosureQueue, userAta: ownerAta };
  const creditSig = await creditDeposit(boot, trader, DEPOSIT);
  const initPermSig = await initPermissions(trader);
  console.log("credit_deposit", creditSig, "init_permissions", initPermSig);

  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);

  console.log("=== set_session ===");
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const userPermission = permissionPdaFromAccount(userAccount);
  const positionPermission = permissionPdaFromAccount(position);
  const dqPermission = permissionPdaFromAccount(disclosureQueue);
  const setSessionIx = await coreOwnerEr.methods
    .setSession(session.publicKey, new BN(expiry), 20)
    .accounts({ owner: owner.publicKey, config, market, userAccount, position, disclosureQueue, userPermission, positionPermission, dqPermission, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID })
    .instruction();
  const setSessionSig = await sendAndConfirmIx(ownerConn, owner, setSessionIx);
  const fundSessionSig = await sendAndConfirmTransaction(
    baseConn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: session.publicKey, lamports: SESSION_LAMPORTS })),
    [owner],
    { commitment: "confirmed" },
  );
  console.log("set_session", setSessionSig, "fund session", fundSessionSig);

  console.log("=== open_position (~10x long, session-signed) ===");
  const marketRisk = pdas.marketRisk(market);
  const marketBeforeOpen = await accountNs(coreOwnerEr).market.fetch(market);
  const price = BigInt(marketBeforeOpen.mark.toString()); // 1e6-scaled USD, per math.rs PRICE_SCALE
  assert(price > 0n, `Market.mark is seeded (nonzero) before opening — got ${price.toString()}. Run crank-fallback or schedule-crank first so the market has a mark.`);
  const sizeLamports = BigInt(Math.round(OPEN_SIZE_SOL * 1_000_000_000)); // math.rs SIZE_SCALE
  const notional = (sizeLamports * price) / 1_000_000_000n; // matches math::notional's scale
  // ~10x leverage with headroom above the market's imr_bps (10% at open
  // time) and its own required-margin rounding (CLAUDE.md: rounding always
  // favors the pool, i.e. required_margin rounds UP) — 11% instead of an
  // exact 10% to avoid a false InsufficientMargin from that rounding.
  const marginUsd = (notional * 11n) / 100n;
  console.log(`price(mark)=${price} notional=${notional} margin=${marginUsd} leverage~=${(Number(notional) / Number(marginUsd)).toFixed(2)}x`);

  const sessionConn = await teeConn(session);
  const coreSessionEr = dexxerCoreProgram(sessionConn, session);
  const openIx = await coreSessionEr.methods
    .openPosition({ long: {} }, new BN(sizeLamports.toString()), new BN(marginUsd.toString()), new BN(U64_MAX.toString()))
    .accounts({ signer: session.publicKey, config, market, marketRisk, pool: boot.pool, userAccount, position, feed: boot.feed })
    .instruction();
  const openSig = await sendAndConfirmIx(sessionConn, session, openIx);
  console.log("open_position (session-signed)", openSig);

  const positionAfterOpen = await accountNs(coreOwnerEr).position.fetch(position);
  assert("open" in positionAfterOpen.state, `Position.state == Open after open_position (got ${JSON.stringify(positionAfterOpen.state)})`);
  console.log("Position after open:", { entry: positionAfterOpen.entry.toString(), margin: positionAfterOpen.margin.toString(), size: positionAfterOpen.size.toString() });

  // --- admin: snapshot original params, then force liquidation via extreme mmr_bps ---
  const adminConn = await teeConn(admin);
  const coreAdminEr = dexxerCoreProgram(adminConn, admin);
  const marketBeforeParams = await accountNs(coreAdminEr).market.fetch(market);
  const origParams = extractParams(marketBeforeParams);
  console.log("original Market params snapshot:", origParams);

  const liqParams = { ...origParams, mmrBps: LIQ_MMR_BPS, imrBps: LIQ_IMR_BPS };
  let liquidated = false;
  let liqTicksSeen: number[] = [];
  let closedInfo: unknown = null;
  let setParamsSig = "";
  let liqPollTries = 0;
  try {
    setParamsSig = await sendAndConfirmIx(
      adminConn,
      admin,
      await coreAdminEr.methods.setParams(liqParams).accounts({ admin: admin.publicKey, config, market }).instruction(),
    );
    console.log(`set_params(mmr_bps=${LIQ_MMR_BPS}, imr_bps=${LIQ_IMR_BPS})`, setParamsSig);
    const tSetParams = Date.now();

    for (let i = 0; i < POLL_TRIES; i++) {
      liqPollTries = i + 1;
      const pos = await accountNs(coreOwnerEr).position.fetch(position);
      liqTicksSeen.push(Number(pos.liqTicks));
      if ("closed" in pos.state) {
        liquidated = true;
        closedInfo = pos.closed;
        console.log(`Position liquidated after ${((Date.now() - tSetParams) / 1000).toFixed(1)}s, ${liqPollTries} polls, liq_ticks history: ${JSON.stringify(liqTicksSeen)}`);
        break;
      }
      await sleep(POLL_DELAY_MS);
    }
    if (!liquidated) {
      console.error(`FAIL: position not liquidated within ${POLL_TRIES}s. liq_ticks history: ${JSON.stringify(liqTicksSeen)}. Is crank-fallback (DEXXER_NET=devnet) running?`);
    }
  } finally {
    // --- mandatory restore: this is a shared devnet market ---
    console.log("=== restoring original Market params (mandatory) ===");
    const restoreSig = await sendAndConfirmIx(
      adminConn,
      admin,
      await coreAdminEr.methods.setParams(origParams).accounts({ admin: admin.publicKey, config, market }).instruction(),
    );
    const marketAfterRestore = await accountNs(coreAdminEr).market.fetch(market);
    const restoredParams = extractParams(marketAfterRestore);
    const restoredOk = paramsEqual(origParams, restoredParams);
    console.log("restore set_params sig", restoreSig, "restored params match original:", restoredOk);
    console.log("restored params (on-chain, post-restore):", restoredParams);
    if (!restoredOk) {
      console.error("FAIL: restored params do NOT match the original snapshot — manual intervention needed on this shared devnet market.");
      process.exitCode = 1;
    }

    console.log(
      "\n05-CRANK-LIQUIDATION",
      liquidated ? "PASS" : "FAIL (not liquidated within window)",
      JSON.stringify({
        owner: owner.publicKey.toBase58(),
        position: position.toBase58(),
        openSig,
        setParamsSig,
        liqPollTries,
        liqTicksSeen,
        closedInfo,
        restoreSig,
        restoredOk,
      }),
    );
  }
}

main().catch((e) => {
  console.error("05-crank-liquidation FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
