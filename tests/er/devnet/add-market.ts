// tests/er/devnet/add-market.ts — `npm run devnet:add-market -- BTC`
//
// Spec §2.8.1: L1 init_market + delegate_market → eSPL rent top-up for the
// MarketRisk permission (the sanctioned week-4 path) → ER
// init_market_permissions (MarketRisk private [crank, admin]; PoolLive's
// permission is updated in place) → optional schedule_crank (mark-only
// backstop, own task id). Every step skips itself when already done, so a
// failed run is simply re-run.
export {};
if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}
const { BN } = await import("@coral-xyz/anchor");
const { SystemProgram } = await import("@solana/web3.js");
const { MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const { NET, ORACLE, baseConn, loadOrCreateKey, sendAndConfirmIx, teeConn, waitDelegated } = await import("../lib/env.js");
const { DELEGATION_PROGRAM_ID, DEXXER_CORE_PROGRAM_ID, accountNs, delegationTriple, dexxerCoreProgram, pdas, symbolBytes } = await import("../lib/program.js");
const { fundMarketPermissions, initMarketPermissions } = await import("../lib/admin.js");
const { MARKET_CATALOG, marketTaskId } = await import("../lib/markets.js");
const { crankSignerPda } = await import("../lib/crank-signer.js");

const symbol = process.argv[2];
const schedule = process.argv.includes("--schedule");
if (NET !== "devnet") throw new Error("DEXXER_NET=devnet required");
if (!symbol || symbol === "SOL" || !MARKET_CATALOG[symbol]) {
  throw new Error(`usage: add-market <${Object.keys(MARKET_CATALOG).filter((s) => s !== "SOL").join("|")}> [--schedule]`);
}
const { lazerFeedId, params } = MARKET_CATALOG[symbol];
const sym = Array.from(symbolBytes(symbol));
const admin = loadOrCreateKey("devnet-admin");
const core = dexxerCoreProgram(baseConn, admin);
const config = pdas.config();
const market = pdas.marketFor(symbol);
const marketRisk = pdas.marketRisk(market);
const sigs: Record<string, string> = {};

// 1. init_market (L1)
if (!(await baseConn.getAccountInfo(market, "confirmed"))) {
  sigs.initMarket = await core.methods
    .initMarket(sym, params, lazerFeedId)
    .accounts({ admin: admin.publicKey, config, market, marketRisk, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("init_market", sigs.initMarket);
} else console.log("init_market: exists, skipped");

// 2. delegate_market (+ market_risk) (L1)
const mInfo = await baseConn.getAccountInfo(market, "confirmed");
if (!mInfo || !mInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
  const mt = delegationTriple(market, DEXXER_CORE_PROGRAM_ID);
  const rt = delegationTriple(marketRisk, DEXXER_CORE_PROGRAM_ID);
  sigs.delegateMarket = await core.methods
    .delegateMarket(sym)
    .accounts({
      admin: admin.publicKey, config,
      bufferMarket: mt.buffer, delegationRecordMarket: mt.record, delegationMetadataMarket: mt.metadata, market,
      bufferMarketRisk: rt.buffer, delegationRecordMarketRisk: rt.record, delegationMetadataMarketRisk: rt.metadata, marketRisk,
      ownerProgram: DEXXER_CORE_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("delegate_market", sigs.delegateMarket);
  await waitDelegated(baseConn, market, "market");
  await waitDelegated(baseConn, marketRisk, "market_risk");
} else console.log("delegate_market: already delegated, skipped");

// 3-4. rent top-up + init_market_permissions (ER): MarketRisk private [crank, admin]
const cfg = await accountNs(core).config.fetch(config);
const poolLive = pdas.poolLive(cfg.dusdcMint);
await fundMarketPermissions(admin, marketRisk, poolLive, sigs);
const perm = await initMarketPermissions(admin, config, market, marketRisk, poolLive, sigs);
if (!perm.riskPermissioned) throw new Error(`init_market_permissions: ${symbol} MarketRisk is NOT private — stop, risk #24`);

// 5. optional scheduler backstop (mark-only; the relayer crank ticks every market anyway).
// `--schedule`: since risk #38 a relayer-less liquidation on this market needs
// this task (or the relayer) to keep sampling prices — spec §2.9.
if (schedule) {
  const conn = await teeConn(admin);
  const erCore = dexxerCoreProgram(conn, admin);
  const feed = pdas.feedUnder(ORACLE, lazerFeedId);
  const crank = crankSignerPda(admin.publicKey);
  const taskContext = admin.publicKey;
  const ix = await erCore.methods
    .scheduleCrank(new BN(marketTaskId(market).toString()), new BN(1_000), new BN("9223372036854775807"))
    .accounts({ admin: admin.publicKey, config, market, marketRisk, poolLive, feed, crank, taskContext, magicProgram: MAGIC_PROGRAM_ID })
    .remainingAccounts([
      { pubkey: taskContext, isWritable: true, isSigner: false },
      { pubkey: crank, isWritable: false, isSigner: false },
      { pubkey: config, isWritable: false, isSigner: false },
      { pubkey: market, isWritable: true, isSigner: false },
      { pubkey: marketRisk, isWritable: true, isSigner: false },
      { pubkey: poolLive, isWritable: true, isSigner: false },
      { pubkey: feed, isWritable: false, isSigner: false },
    ])
    .instruction();
  sigs.scheduleCrank = await sendAndConfirmIx(conn, admin, ix);
  console.log("schedule_crank", sigs.scheduleCrank, "task_id", marketTaskId(market).toString());
}
console.log(JSON.stringify({ symbol, market: market.toBase58(), marketRisk: marketRisk.toBase58(), sigs }, null, 2));
