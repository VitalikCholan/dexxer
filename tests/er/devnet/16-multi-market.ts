// tests/er/devnet/16-multi-market.ts
//
// Position slots, plan 4 (M-slots-E): one trader, two markets, one `Positions`.
//
//   onboarding (as 05: faucet, init_user, delegateSpl, delegate_user,
//   credit_deposit, init_permissions, set_session) -> open_position SOL and BTC
//   (two `liquidation_check` tasks on the SAME `Positions`, task ids
//   keccak(positions ‖ market)) -> increase_position SOL -> add_margin SOL ->
//   decrease_position SOL by half (history record reason 2) -> forced
//   liquidation of BTC ONLY (`set_params` on the BTC `Market`, restored in
//   `finally`; the SOL slot must stay open, `liq_ticks` of both logged every
//   2 s; the restore re-reads, resends while the params still differ — at most
//   5 times — and always verifies on-chain; a failed restore prints
//   `16-MULTI-MARKET FAIL (restore)` and exits 1) -> close_position SOL -> withdraw(all) -> undelegate_user with
//   remaining_accounts [SOL, BTC] -> both accounts back under the program on
//   base, `UserAccount.exited` -> (optional) wait for the relayer's janitor
//   (`close_exited_user`), rent back to `UserAccount.rent_payer`.
//
// Every transaction is measured: `bytes` = the signed transaction's
// serialized length before sending, `cu` = `meta.computeUnitsConsumed` from
// `getTransaction` on the connection it was sent to (devnet-tee has returned
// 0 / nothing for ER transactions before — week 5 — the table prints what
// the endpoint gives). The table is printed at the end: `ix | cu | bytes | sig`.
//
// Who liquidates: with the relayer's crank off (or no relayer at all), only
// the per-market `liquidation_check` scheduler task (5 s) can liquidate — a
// repeat of M-G' on two markets. The script probes `RELAYER_URL/healthz` once
// (5 s timeout): unreachable -> "relayer unreachable — scheduler-only run".
// Reachable -> with `RELAYER_TOGGLE=1` it flips `CRANK_ENABLED=false` via
// `railway variables` (as 13 does) and back to `true` in `finally`; without
// it the script only logs that a live relayer crank may be the liquidator.
//
// `--cu-reader crank|admin`: re-read every ER signature with that TEE token
// after the run — devnet-tee blanks the meta (CU 0, no logs) for a reader that
// is not a member of the permissioned accounts the tx wrote (trades write
// `PoolLive`/`MarketRisk`, members [crank, admin]).
//
// Janitor tail: on by default; `--no-janitor` or `JANITOR_WAIT=0` skips it.
// Waits up to 2 × COMMIT_INTERVAL_MS (env, default 300000) + 60 s.
//
// Run: cd tests/er && npm run devnet:multimarket [-- --no-janitor]

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
const { execFileSync } = await import("child_process");
const { BN } = await import("@coral-xyz/anchor");
const { SystemProgram, Transaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
type Connection = import("@solana/web3.js").Connection;
type Keypair = import("@solana/web3.js").Keypair;
type PublicKey = import("@solana/web3.js").PublicKey;
type TransactionInstruction = import("@solana/web3.js").TransactionInstruction;
const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
const { delegateSpl, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");
const envMod = await import("../lib/env.js");
const { ER_VALIDATOR, NET, baseConn, erConn, loadOrCreateKey, sleep, teeConn, waitDelegated } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { DEXXER_CORE_PROGRAM_ID, accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");
const { bootstrapDevnet } = await import("../lib/admin.js");
const {
  delegateUserAccounts, initUserAccounts, permissionAccounts, readPositions, tradeAccounts, undelegateUserAccounts, U64_MAX,
} = await import("../lib/trader.js");
const { liqTaskId, slotFor } = await import("../lib/positions.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}"). Run: npm run devnet:multimarket`);
  process.exit(1);
}

const DEPOSIT = 1_000_000_000n; // 1,000 dUSDC (6 decimals)
const TRADER_FUND_SOL = 0.05;
const SESSION_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const TARGET_NOTIONAL = 100_000_000n; // $100 (1e6) per market
const SIZE_SCALE = 1_000_000_000n; // math.rs SIZE_SCALE
// Same extreme params as 05-crank-liquidation.ts (imr bumped only to satisfy validate()).
const LIQ_MMR_BPS = 9_500;
const LIQ_IMR_BPS = 9_600;
const LIQ_POLL_TRIES = 90;
const LIQ_POLL_DELAY_MS = 2_000;
const RELAYER_URL = process.env.RELAYER_URL ?? "https://relayer-production-1ae7.up.railway.app";
const RAILWAY_SERVICE = process.env.RAILWAY_SERVICE ?? "relayer";
const RELAYER_TOGGLE = process.env.RELAYER_TOGGLE === "1";
const JANITOR = !(process.argv.includes("--no-janitor") || process.env.JANITOR_WAIT === "0");
const COMMIT_INTERVAL_MS = Number(process.env.COMMIT_INTERVAL_MS ?? 300_000);
const RESTORE_ATTEMPTS = 5;
// `--cu-reader crank|admin`: after the run, re-read every ER signature with that key's TEE token.
// devnet-tee blanks `getTransaction` meta (CU 0, no logs) for a reader that is not a member of the
// permissioned accounts the tx wrote; trades write `PoolLive`/`MarketRisk` ([crank, admin]).
const CU_READER = (() => {
  const i = process.argv.indexOf("--cu-reader");
  if (i < 0) return null;
  const who = process.argv[i + 1];
  if (who !== "crank" && who !== "admin") throw new Error("--cu-reader takes crank or admin");
  return who;
})();
const USER_EXITED_OFFSET = 142; // UserAccount byte `exited` (janitor's memcmp, services/relayer/src/janitor.ts)
const USER_ACCOUNT_SIZE = 207;
const SAMPLE_SEQ_OFFSET = 103 + 24; // Market: mark | mark_slot | last_print | sample_seq (15-marks.ts)

const MARKET_PARAM_FIELDS = [
  "maxLevBps", "imrBps", "mmrBps", "openFeeBps", "closeFeeBps", "liqFeeBps", "oiCap", "maxPosition", "minSize",
  "maxStalenessSecs", "maxConfBps", "maxDeviationBps", "emaAlphaBps", "liqHysteresisTicks", "maxStaleTicks",
] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractParams = (m: any): Record<string, unknown> => Object.fromEntries(MARKET_PARAM_FIELDS.map((f) => [f, m[f]]));
const paramsEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => MARKET_PARAM_FIELDS.every((f) => String(a[f]) === String(b[f]));
const showParams = (p: Record<string, unknown>) => JSON.stringify(Object.fromEntries(MARKET_PARAM_FIELDS.map((f) => [f, String(p[f])])));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// ---------------------------------------------------------------- measuring

type Row = { ix: string; cu: number | null; bytes: number; sig: string; net: "L1" | "ER" };
const rows: Row[] = [];

async function waitStatus(conn: Connection, sig: string, timeoutMs: number): Promise<"ok" | "pending"> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const s = value[0];
    if (s) {
      if (s.err) {
        const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        const err = new Error(`transaction ${sig} failed: ${JSON.stringify(s.err)}`) as Error & { logs?: string[] };
        err.logs = tx?.meta?.logMessages ?? undefined;
        throw err;
      }
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return "ok";
    }
    await sleep(400);
  }
  return "pending";
}

async function cuOf(conn: Connection, sig: string): Promise<number | null> {
  for (let i = 0; i < 10; i++) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (tx) return tx.meta?.computeUnitsConsumed ?? null;
    await sleep(1000);
  }
  return null;
}

/**
 * Sign, measure, send, confirm. L1 retries a dropped transaction (no status
 * after 30 s) up to 3 times with a fresh blockhash, re-checking every earlier
 * signature first so a late landing is never sent twice.
 */
async function send(label: string, conn: Connection, net: "L1" | "ER", payer: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []): Promise<string> {
  const sigs: string[] = [];
  const attempts = net === "L1" ? 3 : 1;
  for (let a = 0; a < attempts; a++) {
    for (const prev of sigs) if ((await waitStatus(conn, prev, 2_000)) === "ok") return finish(prev);
    const { blockhash } = await conn.getLatestBlockhash(net === "L1" ? "confirmed" : "processed");
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...ixs);
    tx.sign(payer, ...extra);
    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: true });
    sigs.push(sig);
    if ((await waitStatus(conn, sig, net === "L1" ? 30_000 : 15_000)) === "ok") return finish(sig, raw.length);
    console.log(`  ${label}: no confirmation for ${sig} (attempt ${a + 1}/${attempts})`);
  }
  throw new Error(`${label}: not confirmed after ${attempts} attempt(s): ${sigs.join(", ")}`);

  async function finish(sig: string, bytes = -1): Promise<string> {
    const cu = await cuOf(conn, sig);
    rows.push({ ix: label, cu, bytes, sig, net });
    console.log(`${label} sig=${sig} bytes=${bytes} cu=${cu}`);
    return sig;
  }
}

// ---------------------------------------------------------------- relayer probe

async function healthz(): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5_000);
  try {
    const r = await fetch(`${RELAYER_URL}/healthz`, { signal: ac.signal });
    // Railway's edge answers 404 "Application not found" for a removed service — no relayer.
    // A relayer's own 503 (no tick yet) is reachable — it has a JSON body with `crankEnabled`.
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // Only a relayer's own body (2xx or 503) carries `crankEnabled`; anything else is not our relayer.
    if (typeof body !== "object" || body === null || !("crankEnabled" in body)) {
      console.log(`relayer /healthz HTTP ${r.status}: ${JSON.stringify(body)}`);
      return null;
    }
    return { httpStatus: r.status, ...body };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function railwaySetCrankEnabled(value: "true" | "false"): void {
  console.log(`railway variables --set CRANK_ENABLED=${value} --service ${RAILWAY_SERVICE}`);
  const out = execFileSync("railway", ["variables", "--set", `CRANK_ENABLED=${value}`, "--service", RAILWAY_SERVICE], {
    encoding: "utf8",
    cwd: new URL("../../../services/relayer", import.meta.url).pathname,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(out.trim());
}

async function waitCrankEnabled(expected: boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const h = await healthz();
    console.log(`  /healthz poll ${i}: ${h ? `crankEnabled=${String(h.crankEnabled)} tick=${String(h.tick)}` : "unreachable"}`);
    if (h && h.crankEnabled === expected) return;
    await sleep(5_000);
  }
  throw new Error(`timeout waiting for /healthz.crankEnabled == ${expected}`);
}

// ---------------------------------------------------------------- scenario

async function main() {
  console.log("=== bootstrapDevnet (idempotent) ===");
  const boot = await bootstrapDevnet();
  const admin = boot.admin;
  const config = pdas.config();
  const feeEscrow = pdas.feeEscrow();

  const health = await healthz();
  let relayerToggled = false;
  if (!health) console.log(`relayer unreachable — scheduler-only run (${RELAYER_URL})`);
  else console.log("relayer /healthz:", json(health));

  const runId = Date.now();
  const owner = loadOrCreateKey(`devnet-trader-mm-${runId}`);
  const session = loadOrCreateKey(`devnet-session-mm-${runId}`);
  const userAccount = pdas.userAccount(owner.publicKey);
  const positions = pdas.positions(owner.publicKey);
  console.log("run id:", runId, "owner:", owner.publicKey.toBase58(), "session:", session.publicKey.toBase58(), "positions:", positions.toBase58());

  const adminConn = await teeConn(admin);
  const coreAdminEr = dexxerCoreProgram(adminConn, admin);
  const markets = await Promise.all(["SOL", "BTC"].map(async (symbol) => {
    const market = pdas.marketFor(symbol);
    const m = await accountNs(coreAdminEr).market.fetch(market);
    return { symbol, market, marketRisk: pdas.marketRisk(market), feed: m.feed as PublicKey };
  }));
  const [SOL, BTC] = markets;
  assert(SOL.market.equals(boot.market), "pdas.marketFor('SOL') == bootstrap SOL market");
  const solTask = liqTaskId(positions, SOL.market);
  const btcTask = liqTaskId(positions, BTC.market);
  console.log(`markets: SOL=${SOL.market.toBase58()} BTC=${BTC.market.toBase58()}; liq task ids on one Positions: SOL=${solTask} BTC=${btcTask}`);
  assert(solTask !== btcTask, "distinct liquidation task ids per market");

  const balance = async () => ({
    adminL1: await baseConn.getBalance(admin.publicKey),
    feeEscrowEr: (await erConn.getAccountInfo(feeEscrow))?.lamports ?? null,
  });
  const balBefore = await balance();
  console.log("balances before:", json(balBefore));

  await send("fund trader (transfer)", baseConn, "L1", admin, [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: TRADER_FUND_SOL * LAMPORTS_PER_SOL }),
  ]);

  // --- L1 onboarding legs ---
  const coreBase = dexxerCoreProgram(baseConn, owner);
  const ownerAta = getAssociatedTokenAddressSync(boot.mint, owner.publicKey);
  // Through `send` (retries a dropped tx) — getOrCreateAssociatedTokenAccount's read-after-create raced RPC lag once.
  await send("create ATA (idempotent)", baseConn, "L1", owner, [createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerAta, owner.publicKey, boot.mint)]);
  await send("faucet_init", baseConn, "L1", owner, [await coreBase.methods
    .faucetInit(new BN(DEPOSIT.toString()))
    .accounts({ owner: owner.publicKey, payer: owner.publicKey, config, faucet: pdas.faucet(owner.publicKey), dusdcMint: boot.mint, mintAuth: pdas.mintAuth(), ownerAta, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction()]);
  await send("init_user", baseConn, "L1", owner, [await coreBase.methods.initUser(Array.from(randomBytes(32))).accounts(initUserAccounts(owner.publicKey, owner.publicKey)).instruction()]);
  await send("delegateSpl", baseConn, "L1", owner, await delegateSpl(owner.publicKey, boot.mint, DEPOSIT, { validator: ER_VALIDATOR, initVaultIfMissing: false, idempotent: false }));
  await send("delegate_user", baseConn, "L1", owner, [await coreBase.methods.delegateUser().accounts(delegateUserAccounts(owner.publicKey, owner.publicKey)).instruction()]);
  await waitDelegated(baseConn, userAccount, "UserAccount");
  await waitDelegated(baseConn, positions, "Positions");

  // --- ER onboarding legs ---
  const ownerConn = await teeConn(owner);
  const coreOwnerEr = dexxerCoreProgram(ownerConn, owner);
  await send("credit_deposit", ownerConn, "ER", owner, [await coreOwnerEr.methods
    .creditDeposit(new BN(DEPOSIT.toString()))
    .accounts({ owner: owner.publicKey, userAccount, pool: boot.pool, poolLive: boot.poolLive, ownerAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction()]);
  await send("init_permissions", ownerConn, "ER", owner, [await coreOwnerEr.methods.initPermissions().accounts(permissionAccounts(owner.publicKey)).instruction()]);
  await send("set_session", ownerConn, "ER", owner, [await coreOwnerEr.methods
    .setSession(session.publicKey, new BN(Math.floor(Date.now() / 1000) + 3600), 20)
    .accounts(permissionAccounts(owner.publicKey))
    .instruction()]);
  await send("fund session (transfer)", baseConn, "L1", owner, [
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: session.publicKey, lamports: SESSION_LAMPORTS }),
  ]);

  // --- sizes from the live Market params ---
  const sessionConn = await teeConn(session);
  const coreSessionEr = dexxerCoreProgram(sessionConn, session);
  const trade = (m: typeof SOL) => ({ signer: session.publicKey, ...tradeAccounts({ config, poolLive: boot.poolLive }, { userAccount, positions }, m) });
  const plan = async (m: typeof SOL, marginPct: bigint) => {
    const acc = await accountNs(coreAdminEr).market.fetch(m.market);
    const mark = BigInt(acc.mark.toString());
    const minSize = BigInt(acc.minSize.toString());
    const maxPosition = BigInt(acc.maxPosition.toString());
    const imrBps = BigInt(acc.imrBps);
    assert(mark > 0n, `${m.symbol} Market.mark is seeded (is its crank_tick scheduled?)`);
    let size = (TARGET_NOTIONAL * SIZE_SCALE) / mark;
    if (size < 4n * minSize) size = 4n * minSize; // half of it must still clear min_size after decrease
    const notional = (size * mark) / SIZE_SCALE;
    assert(notional <= maxPosition / 2n, `${m.symbol} notional ${notional} within max_position ${maxPosition}`);
    const margin = (notional * marginPct) / 100n;
    assert(margin * 10_000n > notional * imrBps, `${m.symbol} margin ${margin} clears imr ${imrBps} bps`);
    console.log(`${m.symbol}: mark=${mark} min_size=${minSize} max_position=${maxPosition} imr_bps=${imrBps} -> size=${size} notional=${notional} margin=${margin} (~${(Number(notional) / Number(margin)).toFixed(2)}x)`);
    return { size, notional, margin, mark };
  };
  const solPlan = await plan(SOL, 30n); // ~3.3x: SOL must stay healthy while BTC is forced
  const btcPlan = await plan(BTC, 12n); // ~8.3x under BTC's 10x

  await send("open_position SOL", sessionConn, "ER", session, [await coreSessionEr.methods
    .openPosition({ long: {} }, new BN(solPlan.size.toString()), new BN(solPlan.margin.toString()), new BN(U64_MAX.toString()))
    .accounts(trade(SOL)).instruction()]);
  await send("open_position BTC", sessionConn, "ER", session, [await coreSessionEr.methods
    .openPosition({ long: {} }, new BN(btcPlan.size.toString()), new BN(btcPlan.margin.toString()), new BN(U64_MAX.toString()))
    .accounts(trade(BTC)).instruction()]);
  let p = await readPositions(ownerConn, positions);
  const solSlot0 = slotFor(p, SOL.market);
  const btcSlot0 = slotFor(p, BTC.market);
  assert(solSlot0 && btcSlot0, "both SOL and BTC slots open on one Positions");
  console.log("slots after opens:", json(p.slots.map((s) => ({ index: s.index, market: s.market.toBase58(), size: s.size, margin: s.margin, entry: s.entry, liqTicks: s.liqTicks, lastLiqSample: s.lastLiqSample }))));

  // increase SOL by min_size-sized step with proportional margin
  const solMarket = await accountNs(coreAdminEr).market.fetch(SOL.market);
  const addSize = BigInt(solMarket.minSize.toString()) > solPlan.size / 4n ? BigInt(solMarket.minSize.toString()) : solPlan.size / 4n;
  const addMargin = (addSize * solPlan.margin) / solPlan.size + 1n;
  await send("increase_position SOL", sessionConn, "ER", session, [await coreSessionEr.methods
    .increasePosition(new BN(addSize.toString()), new BN(addMargin.toString()), new BN(U64_MAX.toString()))
    .accounts(trade(SOL)).instruction()]);
  await send("add_margin SOL", sessionConn, "ER", session, [await coreSessionEr.methods
    .addMargin(new BN(1_000_000)).accounts(trade(SOL)).instruction()]);
  p = await readPositions(ownerConn, positions);
  const solAfterInc = slotFor(p, SOL.market);
  assert(solAfterInc, "SOL slot still open after increase/add_margin");
  const halfSize = solAfterInc.size / 2n;
  await send("decrease_position SOL (half)", sessionConn, "ER", session, [await coreSessionEr.methods
    .decreasePosition(new BN(halfSize.toString()), new BN(0)).accounts(trade(SOL)).instruction()]);
  p = await readPositions(ownerConn, positions);
  const lastRec = p.history.at(-1);
  assert(lastRec && lastRec.reason === "decrease" && lastRec.market.equals(SOL.market), `history.at(-1) is a SOL decrease record (reason 2), got ${json(lastRec)}`);
  assert(slotFor(p, SOL.market), "SOL slot stays open after partial decrease");
  console.log("decrease record (reason=2):", json(lastRec));

  // --- forced liquidation of BTC only ---
  const btcBefore = await accountNs(coreAdminEr).market.fetch(BTC.market);
  const origParams = extractParams(btcBefore);
  console.log("BTC params before:", showParams(origParams));
  let liquidated = false;
  let liqSeconds: number | null = null;
  const trail: { t: number; btc: number | null; sol: number | null; btcSampleSeq: string | null }[] = [];
  let restoredOk = false;
  const readBtcParams = async (): Promise<Record<string, unknown> | null> => {
    try {
      return extractParams(await accountNs(coreAdminEr).market.fetch(BTC.market));
    } catch (e) {
      console.log("  read BTC params failed:", (e as Error).message);
      return null;
    }
  };
  /** Re-read, resend only while the params still differ, bounded; the verdict is always an on-chain read. */
  const restoreBtcParams = async (): Promise<boolean> => {
    for (let a = 1; a <= RESTORE_ATTEMPTS; a++) {
      const current = await readBtcParams();
      if (current && paramsEqual(origParams, current)) {
        console.log("BTC params on-chain:", showParams(current), "match original: true");
        return true;
      }
      try {
        await send(`set_params BTC (restore #${a})`, adminConn, "ER", admin, [await coreAdminEr.methods
          .setParams(origParams).accounts({ admin: admin.publicKey, config, market: BTC.market }).instruction()]);
      } catch (e) {
        console.log(`  restore attempt ${a}/${RESTORE_ATTEMPTS} failed:`, (e as Error).message);
        await sleep(2_000);
      }
    }
    for (let i = 0; i < 5; i++) {
      const current = await readBtcParams();
      if (current) {
        const ok = paramsEqual(origParams, current);
        console.log("BTC params on-chain after restore attempts:", showParams(current), "match original:", ok);
        return ok;
      }
      await sleep(2_000);
    }
    console.error("could not read BTC params to verify the restore");
    return false;
  };
  try {
    if (health && RELAYER_TOGGLE) {
      relayerToggled = true; // before the call: a half-applied toggle must still be reverted
      railwaySetCrankEnabled("false");
      await waitCrankEnabled(false);
    } else if (health) {
      console.log("relayer reachable but RELAYER_TOGGLE!=1 — not toggling; a live relayer crank on this program may be the liquidator");
    }
    await send("set_params BTC (force liq)", adminConn, "ER", admin, [await coreAdminEr.methods
      .setParams({ ...origParams, mmrBps: LIQ_MMR_BPS, imrBps: LIQ_IMR_BPS }).accounts({ admin: admin.publicKey, config, market: BTC.market }).instruction()]);
    const t0 = Date.now();
    for (let i = 0; i < LIQ_POLL_TRIES; i++) {
      const pp = await readPositions(ownerConn, positions);
      const b = slotFor(pp, BTC.market);
      const s = slotFor(pp, SOL.market);
      const mInfo = await erConn.getAccountInfo(BTC.market).catch(() => null);
      const seq = mInfo ? mInfo.data.readBigUInt64LE(SAMPLE_SEQ_OFFSET).toString() : null;
      const t = (Date.now() - t0) / 1000;
      trail.push({ t, btc: b?.liqTicks ?? null, sol: s?.liqTicks ?? null, btcSampleSeq: seq });
      console.log(`  t=${t.toFixed(1)}s BTC liq_ticks=${b ? b.liqTicks : "closed"} SOL liq_ticks=${s ? s.liqTicks : "CLOSED"} BTC sample_seq=${seq}`);
      assert(s, "SOL slot must stay open while BTC is forced");
      if (!b && pp.history.some((h) => h.market.equals(BTC.market) && h.reason === "liquidated")) {
        liquidated = true;
        liqSeconds = t;
        console.log(`BTC liquidated after ${t.toFixed(1)}s; record: ${json(pp.history.find((h) => h.market.equals(BTC.market) && h.reason === "liquidated"))}`);
        break;
      }
      await sleep(LIQ_POLL_DELAY_MS);
    }
    if (!liquidated) console.error(`FAIL: BTC not liquidated within ${(LIQ_POLL_TRIES * LIQ_POLL_DELAY_MS) / 1000}s`);
  } finally {
    console.log("=== restoring BTC params (mandatory) ===");
    let restoreError: unknown = null;
    try {
      restoredOk = await restoreBtcParams();
    } catch (e) {
      restoreError = e;
    } finally {
      if (relayerToggled) {
        try {
          railwaySetCrankEnabled("true");
          await waitCrankEnabled(true);
        } catch (e) {
          console.error("FAIL: could not re-enable the relayer crank — set CRANK_ENABLED=true by hand:", e);
          process.exitCode = 1;
        }
      }
    }
    if (restoreError) console.error("restore raised:", restoreError);
    if (!restoredOk) {
      console.error("FAIL: BTC params NOT restored — manual intervention needed on the shared devnet market (npm run devnet:setparams -- --market BTC ...)");
      console.error("16-MULTI-MARKET FAIL (restore)");
      process.exit(1);
    }
  }
  assert(liquidated, "BTC liquidated");

  // --- close SOL, withdraw, exit ---
  await send("close_position SOL", sessionConn, "ER", session, [await coreSessionEr.methods.closePosition(new BN(0)).accounts(trade(SOL)).instruction()]);
  p = await readPositions(ownerConn, positions);
  assert(p.slots.length === 0, `no open slot before exit (got ${p.slots.length})`);
  console.log("history ring:", json(p.history.map((h) => ({ market: h.market.toBase58(), reason: h.reason, size: h.size, pnl: h.pnl, fees: h.fees }))));

  const cfg = await accountNs(coreOwnerEr).config.fetch(config);
  const ua = await accountNs(coreOwnerEr).userAccount.fetch(userAccount);
  const free = BigInt(ua.freeMargin.toString());
  console.log(`UserAccount before withdraw: free=${free} locked=${ua.lockedMargin.toString()}`);
  if (free > 0n) {
    await send("withdraw (all)", ownerConn, "ER", owner, [await coreOwnerEr.methods
      .withdraw(new BN(free.toString()))
      .accounts({
        owner: owner.publicKey, userAccount, pool: boot.pool, poolLive: boot.poolLive, ownerAta, vaultAta: boot.poolAta, tokenProgram: TOKEN_PROGRAM_ID,
        config, feeEscrow, magicFeeVault: cfg.magicFeeVault, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction()]);
  }
  const exitMarkets = [SOL.market, BTC.market];
  console.log("undelegate_user remaining_accounts:", exitMarkets.map((k) => k.toBase58()).join(", "));
  await send("undelegate_user [SOL,BTC]", ownerConn, "ER", owner, [await coreOwnerEr.methods
    .undelegateUser()
    .accounts(undelegateUserAccounts(owner.publicKey, cfg.magicFeeVault))
    .remainingAccounts(exitMarkets.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })))
    .instruction()]);

  let back = false;
  let uaBase: import("@solana/web3.js").AccountInfo<Buffer> | null = null;
  let posBase: import("@solana/web3.js").AccountInfo<Buffer> | null = null;
  for (let i = 0; i < 60 && !back; i++) {
    [uaBase, posBase] = await baseConn.getMultipleAccountsInfo([userAccount, positions], "confirmed");
    back = !!uaBase?.owner.equals(DEXXER_CORE_PROGRAM_ID) && !!posBase?.owner.equals(DEXXER_CORE_PROGRAM_ID);
    if (!back) await sleep(2_000);
  }
  assert(back && uaBase && posBase, "UserAccount and Positions back under the program on base within 120 s");
  const exited = uaBase.data.readUInt8(USER_EXITED_OFFSET);
  const decodedUa = coreBase.coder.accounts.decode("userAccount", uaBase.data);
  const rentPayer = decodedUa.rentPayer as PublicKey;
  console.log(`base: UserAccount ${uaBase.data.length} B exited=${exited} rent_payer=${rentPayer.toBase58()}; Positions ${posBase.data.length} B owner=${posBase.owner.toBase58()}`);
  assert(uaBase.data.length === USER_ACCOUNT_SIZE && exited === 1, "UserAccount.exited == true on base");
  assert(Boolean(decodedUa.exited), "decoded exited == true");

  // --- janitor tail (optional) ---
  let janitor: unknown = "skipped (--no-janitor / JANITOR_WAIT=0)";
  if (JANITOR) {
    const rentBefore = await baseConn.getBalance(rentPayer);
    const deadline = Date.now() + 2 * COMMIT_INTERVAL_MS + 60_000;
    const tJ = Date.now();
    let closed = false;
    while (Date.now() < deadline) {
      const [a, b] = await baseConn.getMultipleAccountsInfo([userAccount, positions], "confirmed");
      if (!a && !b) { closed = true; break; }
      await sleep(10_000);
    }
    const rentAfter = await baseConn.getBalance(rentPayer);
    janitor = { closed, seconds: (Date.now() - tJ) / 1000, rentPayerDelta: rentAfter - rentBefore };
    console.log("janitor:", json(janitor));
    assert(closed, "janitor closed both accounts within the window");
  }

  if (CU_READER) {
    const readerConn = await teeConn(loadOrCreateKey(CU_READER === "crank" ? "devnet-crank" : "devnet-admin"));
    for (const r of rows) {
      if (r.net !== "ER") continue;
      const cu = await cuOf(readerConn, r.sig);
      if (cu !== null && cu !== r.cu) console.log(`cu re-read (${CU_READER} token) ${r.ix}: ${r.cu} -> ${cu}`);
      if (cu !== null) r.cu = Math.max(cu, r.cu ?? 0);
    }
  }
  const balAfter = await balance();
  console.log("balances after:", json(balAfter));
  console.log(`\n${CU_READER ? `(ER cu = max of sender's and ${CU_READER}-token read)` : "(ER cu as the sender's TEE token sees it; --cu-reader crank for trades)"}`);
  console.log("| ix | cu | bytes | sig |\n|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.ix} (${r.net}) | ${r.cu ?? "n/a"} | ${r.bytes < 0 ? "n/a (late landing)" : r.bytes} | ${r.sig} |`);
  console.log("\nliq_ticks trail:", json(trail));
  assert(restoredOk, "BTC params restored and verified on-chain");
  if (process.exitCode) {
    console.error("16-MULTI-MARKET FAIL (relayer crank not re-enabled)");
    process.exit(1);
  }
  console.log(
    "\n16-MULTI-MARKET PASS",
    json({ owner: owner.publicKey.toBase58(), positions: positions.toBase58(), liquidatedBy: health && !RELAYER_TOGGLE ? "unknown (relayer reachable, not toggled)" : "scheduler (liquidation_check)", liqSeconds, restoredOk, exited, janitor, balBefore, balAfter }),
  );
}

main().catch((e) => {
  console.error("16-multi-market FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  if (rows.length) {
    console.error("\n| ix | cu | bytes | sig | (partial)");
    for (const r of rows) console.error(`| ${r.ix} (${r.net}) | ${r.cu ?? "n/a"} | ${r.bytes} | ${r.sig} |`);
  }
  process.exit(1);
});
