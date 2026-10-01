// tests/er/devnet/13-liquidation-check.ts
//
// Week-5 Task 7, M-G': liquidation WITHOUT the relayer, via the per-market
// scheduler task alone (week-5 Task 3's `liquidation_check`, registered by
// `open_position`, ticking at ~3.75s independent of anything the relayer's
// own `crank_tick` loop does — week-5 Task 0 measurement 1). The relayer's
// crank loop (`services/relayer/src/crank.ts`, `startCrank`) is the thing
// under test here as a NON-dependency: it also runs `crank_tick`'s
// candidate-liquidation path, so if it stayed on, a liquidation could be
// attributed to either mechanism. `CRANK_ENABLED=false` (Railway env,
// `services/relayer/src/index.ts`) skips `startCrank` entirely while `Market.mark` keeps moving on its own
// (week-4 Task 7's separate, always-on market-wide `schedule_crank` task,
// `iterations = i64::MAX`, unrelated to the relayer process).
//
// Procedure: flip `CRANK_ENABLED=false` on Railway, confirm via `/healthz`,
// onboard a fresh trader (manual sequence, self-funded from `devnet-admin`
// — mirrors 05-crank-liquidation.ts, NOT trader.ts's `onboardTrader`, which
// assumes a local-net faucet airdrop that doesn't exist on real devnet),
// open a ~10x long, force it liquidatable via a temporary `set_params`
// (same shape as 05), then poll the trader's `Positions` (owner TEE token)
// until the SOL slot is gone and the newest history record's reason is
// `liquidated` (spec §2.9).
// `finally`: restore `Market` params AND flip `CRANK_ENABLED` back to
// `true` on Railway, verified via `/healthz` — both are mandatory (shared
// devnet market; the relayer is the only always-on liquidator once this
// script exits).
//
// Run: `npm run devnet:liqcheck` (from tests/er). Needs the Railway CLI
// linked to the `dexxer`/`relayer` service (already the case in this repo's
// dev environment — `railway status` confirms).

export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { execFileSync } = await import("child_process");
const { BN } = await import("@coral-xyz/anchor");
const { SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const { delegateSpl } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { ER_VALIDATOR, NET, baseConn, loadOrCreateKey, sendAndConfirmIx, sleep, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const {
  creditDeposit, delegateUserAccounts, initPermissions, initUserAccounts, permissionAccounts, readPositions, tradeAccounts, U64_MAX,
} = await import("../lib/trader.js");
const { slotFor } = await import("../lib/positions.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: DEXXER_NET=devnet npm run devnet:liqcheck`);
  process.exit(1);
}

const RELAYER_URL = process.env.RELAYER_URL ?? "https://relayer-production-1ae7.up.railway.app";
const RAILWAY_SERVICE = "relayer";

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC
const OPEN_SIZE_SOL = 1.0;
const SESSION_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const TRADER_FUND_SOL = 0.05;
// Same extreme-liquidation shape as 05-crank-liquidation.ts.
const LIQ_MMR_BPS = 9_500;
const LIQ_IMR_BPS = 9_600;
const POLL_TRIES = 90; // 90 * 2s = 3 min
const POLL_DELAY_MS = 2000;
const HEALTHZ_POLL_TRIES = 60; // 60 * 5s = 5 min (Railway redeploy is ~1-2 min)
const HEALTHZ_POLL_DELAY_MS = 5000;

const MARKET_PARAM_FIELDS = [
  "maxLevBps", "imrBps", "mmrBps", "openFeeBps", "closeFeeBps", "liqFeeBps", "oiCap",
  "maxPosition", "minSize", "maxStalenessSecs", "maxConfBps", "maxDeviationBps",
  "emaAlphaBps", "liqHysteresisTicks", "maxStaleTicks",
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

interface Healthz {
  ok: boolean;
  crankEnabled: boolean;
  tick: number;
  [k: string]: unknown;
}

async function getHealthz(): Promise<Healthz> {
  const r = await fetch(`${RELAYER_URL}/healthz`);
  if (!r.ok) throw new Error(`/healthz HTTP ${r.status}`);
  return r.json();
}

/** `railway variables --set K=V --service relayer` — triggers a redeploy. */
function railwaySetCrankEnabled(value: "true" | "false"): void {
  console.log(`railway variables --set CRANK_ENABLED=${value} --service ${RAILWAY_SERVICE}`);
  const out = execFileSync("railway", ["variables", "--set", `CRANK_ENABLED=${value}`, "--service", RAILWAY_SERVICE], {
    encoding: "utf8",
    cwd: new URL("../../../services/relayer", import.meta.url).pathname,
  });
  console.log(out.trim());
}

async function waitHealthzCrankEnabled(expected: boolean): Promise<Healthz> {
  let last: Healthz | null = null;
  for (let i = 0; i < HEALTHZ_POLL_TRIES; i++) {
    try {
      last = await getHealthz();
      console.log(`  /healthz poll ${i}: crankEnabled=${last.crankEnabled} tick=${last.tick}`);
      if (last.crankEnabled === expected) return last;
    } catch (e) {
      console.log(`  /healthz poll ${i}: fetch failed (${String(e)}) — redeploy likely mid-flight`);
    }
    await sleep(HEALTHZ_POLL_DELAY_MS);
  }
  throw new Error(`timeout waiting for /healthz.crankEnabled == ${expected} (last seen: ${JSON.stringify(last)})`);
}

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const admin = loadOrCreateKey("devnet-admin");

  let crankDisabled = false;
  let restoredParams = false;
  let restoredCrankEnabled = false;
  let liquidated = false;
  let liqTicksSeen: number[] = [];
  let closedInfo: unknown = null;
  let marketMarkSeen: string[] = [];
  const out: Record<string, unknown> = {};

  try {
    console.log("\n=== step 1: CRANK_ENABLED=false on Railway (relayer) ===");
    const before = await getHealthz();
    console.log("healthz before:", JSON.stringify(before));
    if (before.crankEnabled) {
      railwaySetCrankEnabled("false");
      const after = await waitHealthzCrankEnabled(false);
      console.log("healthz confirmed crankEnabled=false:", JSON.stringify(after));
    } else {
      console.log("crankEnabled already false — skipping the toggle (unexpected pre-state, noted)");
    }
    crankDisabled = true;

    console.log("\n=== step 2: onboard a fresh trader (manual sequence, self-funded from devnet-admin) ===");
    const runId = Date.now();
    const traderName = `devnet-trader-liqcheck-${runId}`;
    const sessionName = `devnet-session-liqcheck-${runId}`;
    const owner = loadOrCreateKey(traderName);
    const session = loadOrCreateKey(sessionName);
    console.log("run id:", runId, "owner:", owner.publicKey.toBase58(), "session:", session.publicKey.toBase58());

    const fundSig = await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: TRADER_FUND_SOL * LAMPORTS_PER_SOL })),
      [admin],
      { commitment: "confirmed" },
    );
    console.log(`funded trader ${TRADER_FUND_SOL} SOL from devnet-admin:`, fundSig);
    out.fundSig = fundSig;

    const core = dexxerCoreProgram(baseConn, owner);
    const config = pdas.config();
    const market = boot.market;
    const userAccount = pdas.userAccount(owner.publicKey);
    const positions = pdas.positions(owner.publicKey);
    const faucetPda = pdas.faucet(owner.publicKey);
    const mintAuth = pdas.mintAuth();
    const ownerAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);

    await getOrCreateAssociatedTokenAccount(baseConn, owner, boot.mint, owner.publicKey);
    const faucetSig = await core.methods
      .faucetInit(new BN(DEPOSIT.toString()))
      .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, faucet: faucetPda, dusdcMint: boot.mint, mintAuth, ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    const { randomBytes } = await import("crypto");
    const exitSalt = Array.from(randomBytes(32));
    const initUserSig = await core.methods.initUser(exitSalt).accounts(initUserAccounts(owner.publicKey, owner.publicKey)).rpc();
    console.log("faucet_init", faucetSig, "init_user", initUserSig);

    const delegateSplIxs = await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { validator: ER_VALIDATOR, initVaultIfMissing: false, idempotent: false });
    const delegateSplSig = await sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateSplIxs), [owner], { commitment: "confirmed" });
    const delegateUserSig = await core.methods
      .delegateUser()
      .accounts(delegateUserAccounts(owner.publicKey, owner.publicKey))
      .rpc();
    console.log("delegateSpl", delegateSplSig, "delegate_user", delegateUserSig);
    out.faucetSig = faucetSig;
    out.initUserSig = initUserSig;
    out.delegateSplSig = delegateSplSig;
    out.delegateUserSig = delegateUserSig;
    await waitDelegated(baseConn, userAccount, "UserAccount");
    await waitDelegated(baseConn, positions, "Positions");

    const trader = { kp: owner, userAccount, positions, userAta: ownerAta };
    const creditSig = await creditDeposit(boot, trader, DEPOSIT);
    const initPermSig = await initPermissions(trader);
    console.log("credit_deposit", creditSig, "init_permissions", initPermSig);
    out.creditSig = creditSig;
    out.initPermSig = initPermSig;

    const ownerConn = await teeConn(owner);
    const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);

    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const setSessionIx = await coreOwnerEr.methods
      .setSession(session.publicKey, new BN(expiry), 20)
      .accounts(permissionAccounts(owner.publicKey))
      .instruction();
    const setSessionSig = await sendAndConfirmIx(ownerConn, owner, setSessionIx);
    const fundSessionSig = await sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: session.publicKey, lamports: SESSION_LAMPORTS })),
      [owner],
      { commitment: "confirmed" },
    );
    console.log("set_session", setSessionSig, "fund session", fundSessionSig);
    out.setSessionSig = setSessionSig;

    console.log("\n=== step 3: open_position (~10x long, session-signed) — this registers the per-market liquidation_check task ===");
    const marketBeforeOpen = await accountNs(coreOwnerEr).market.fetch(market);
    const price = BigInt(marketBeforeOpen.mark.toString());
    assert(price > 0n, `Market.mark is seeded before opening — got ${price.toString()}`);
    const sizeLamports = BigInt(Math.round(OPEN_SIZE_SOL * 1_000_000_000));
    const notional = (sizeLamports * price) / 1_000_000_000n;
    const marginUsd = (notional * 11n) / 100n; // ~9x, headroom over imr_bps rounding
    console.log(`price(mark)=${price} notional=${notional} margin=${marginUsd} leverage~=${(Number(notional) / Number(marginUsd)).toFixed(2)}x`);

    const sessionConn = await teeConn(session);
    const coreSessionEr = dexxerCoreProgram(sessionConn, session);
    const openIx = await coreSessionEr.methods
      .openPosition({ long: {} }, new BN(sizeLamports.toString()), new BN(marginUsd.toString()), new BN(U64_MAX.toString()))
      .accounts({ signer: session.publicKey, ...tradeAccounts({ config, poolLive: boot.poolLive }, { userAccount, positions }, boot) })
      .instruction();
    const openSig = await sendAndConfirmIx(sessionConn, session, openIx);
    console.log("open_position (session-signed)", openSig);
    out.openSig = openSig;

    const slotAfterOpen = slotFor(await readPositions(ownerConn, positions), market);
    assert(slotAfterOpen !== null, "Positions has an open SOL slot after open_position");
    console.log("SOL slot after open:", { index: slotAfterOpen.index, entry: slotAfterOpen.entry.toString(), margin: slotAfterOpen.margin.toString(), size: slotAfterOpen.size.toString() });

    console.log("\n=== step 4: admin set_params to force liquidatable (temporary, mandatory restore) ===");
    const adminConn = await teeConn(admin);
    const coreAdminEr = dexxerCoreProgram(adminConn, admin);
    const marketBeforeParams = await accountNs(coreAdminEr).market.fetch(market);
    const origParams = extractParams(marketBeforeParams);
    console.log("original Market params snapshot:", origParams);
    const liqParams = { ...origParams, mmrBps: LIQ_MMR_BPS, imrBps: LIQ_IMR_BPS };

    let setParamsSig = "";
    let liqPollTries = 0;
    try {
      setParamsSig = await sendAndConfirmIx(
        adminConn, admin,
        await coreAdminEr.methods.setParams(liqParams).accounts({ admin: admin.publicKey, config, market }).instruction(),
      );
      console.log(`set_params(mmr_bps=${LIQ_MMR_BPS}, imr_bps=${LIQ_IMR_BPS})`, setParamsSig);
      out.setParamsSig = setParamsSig;
      const tSetParams = Date.now();

      console.log("\n=== step 5: poll Positions (owner TEE token) up to 3 min for liquidation, WITHOUT the relayer ===");
      for (let i = 0; i < POLL_TRIES; i++) {
        liqPollTries = i + 1;
        const p = await readPositions(ownerConn, positions);
        const slot = slotFor(p, market);
        if (slot) liqTicksSeen.push(slot.liqTicks);
        const mkt = await accountNs(coreOwnerEr).market.fetch(market);
        marketMarkSeen.push(mkt.mark.toString());
        // Spec §2.9: a liquidation frees the slot and appends a `liquidated`
        // record to the private history ring (a fresh trader: no older record).
        const last = p.history.at(-1);
        if (!slot && last?.reason === "liquidated") {
          liquidated = true;
          closedInfo = last;
          console.log(`Position liquidated after ${((Date.now() - tSetParams) / 1000).toFixed(1)}s, ${liqPollTries} polls, liq_ticks history: ${JSON.stringify(liqTicksSeen)}, reason=${last.reason}`);
          out.liquidatedAfterSeconds = (Date.now() - tSetParams) / 1000;
          out.reason = last.reason;
          out.historyLen = p.history.length;
          break;
        }
        await sleep(POLL_DELAY_MS);
      }
      if (!liquidated) {
        console.error(`FAIL: position not liquidated within ${(POLL_TRIES * POLL_DELAY_MS) / 1000}s. liq_ticks history: ${JSON.stringify(liqTicksSeen)}. Market.mark history: ${JSON.stringify(marketMarkSeen)}`);
      }
    } finally {
      console.log("\n=== restoring original Market params (mandatory, shared devnet market) ===");
      const restoreSig = await sendAndConfirmIx(
        adminConn, admin,
        await coreAdminEr.methods.setParams(origParams).accounts({ admin: admin.publicKey, config, market }).instruction(),
      );
      const marketAfterRestore = await accountNs(coreAdminEr).market.fetch(market);
      const restoredParamsNow = extractParams(marketAfterRestore);
      restoredParams = paramsEqual(origParams, restoredParamsNow);
      console.log("restore set_params sig", restoreSig, "restored params match original:", restoredParams);
      out.restoreSig = restoreSig;
      out.restoredParamsOk = restoredParams;
      if (!restoredParams) {
        console.error("FAIL: restored params do NOT match the original snapshot — manual intervention needed on this shared devnet market.");
        process.exitCode = 1;
      }
    }

    out.liqTicksSeen = liqTicksSeen;
    out.liqPollTries = liqPollTries;
    out.closedInfo = closedInfo;
    out.owner = owner.publicKey.toBase58();
    out.positions = positions.toBase58();
  } finally {
    console.log("\n=== step 6: CRANK_ENABLED=true on Railway (mandatory) ===");
    if (crankDisabled) {
      try {
        railwaySetCrankEnabled("true");
        const after = await waitHealthzCrankEnabled(true);
        restoredCrankEnabled = true;
        console.log("healthz confirmed crankEnabled=true:", JSON.stringify(after));
      } catch (e) {
        console.error("FAIL: could not confirm CRANK_ENABLED=true was restored:", String(e));
        process.exitCode = 1;
      }
    } else {
      restoredCrankEnabled = true; // never touched it
      console.log("CRANK_ENABLED was never flipped off — nothing to restore");
    }

    console.log(
      "\n13-LIQUIDATION-CHECK",
      liquidated && restoredParams && restoredCrankEnabled ? "PASS" : "FAIL",
      JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
    if (!liquidated) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("13-liquidation-check FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
