// scripts/demo/week1-cli.ts
//
// Task 14, week-1 finish line: two traders onboard on the local mb-stack,
// open positions, a fallback crank loop (spec §3.5, signed by
// `Config.crank`) ticks the market, one trader gets liquidated after a
// price move, the other closes manually, and the pool invariant is checked
// from ER state. Every step logs its signature and the resulting state;
// prints `WEEK1 CLI PASS` on success.
//
// Run (from scripts/, per the brief): `npx tsx demo/week1-cli.ts`.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { assert, erConn, sendAndConfirmIx, sleep } from "../../tests/er/lib/env.js";
import { bootstrap, MARKET_DEFAULTS } from "../../tests/er/lib/admin.js";
import { accountNs, dexxerCoreProgram, pdas } from "../../tests/er/lib/program.js";
import { closePosition, onboardTrader, openPosition, readPosition, setPrice, type Trader } from "../../tests/er/lib/trader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CRANK_SCRIPT = resolve(HERE, "..", "crank-fallback", "index.ts");
const CRANK_INTERVAL_MS = 1000;

// Module-scoped (not local to main()): `assert()` (tests/er/lib/env.ts) calls
// `process.exit(1)` directly on a failed assertion, which skips main()'s
// try/finally entirely (process.exit does not run pending async cleanup).
// A synchronous `process.on("exit", ...)` handler is the one thing that
// still runs on every exit path — normal return, a thrown error, or
// `process.exit()` — so it's the actual guarantee behind "kill the crank
// child on all paths", not the try/finally below (kept for the graceful
// wait-for-SIGINT-exit path in the success case).
let crank: ChildProcessByStdio<null, Readable, Readable> | null = null;
process.on("exit", () => {
  if (crank && crank.exitCode === null && crank.signalCode === null) {
    crank.kill("SIGINT");
  }
});

interface TickRecord {
  n: number;
  slot: number;
  mark: string;
  sig: string;
  cu: number | null;
  tickMs: number;
  candidates: number;
  liquidated: string[];
}

function parseTickLine(line: string): TickRecord | null {
  if (!line.startsWith("tick ")) return null;
  const fields: Record<string, string> = {};
  for (const token of line.trim().split(/\s+/).slice(1)) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  if (fields.n === undefined) return null;
  return {
    n: Number(fields.n),
    slot: Number(fields.slot),
    mark: fields.mark,
    sig: fields.sig,
    cu: fields.cu === "null" ? null : Number(fields.cu),
    tickMs: Number(fields.tick_ms),
    candidates: Number(fields.candidates),
    liquidated: JSON.parse(fields.liquidated ?? "[]") as string[],
  };
}

async function main() {
  const tickLog: TickRecord[] = [];

  try {
    console.log("=== 1. bootstrap ===");
    const boot = await bootstrap();

    // Param choice (a) from the brief: a hard EMA (alpha 100%) and a
    // deviation guard wide enough to never trip, so the mark tracks the
    // index price exactly on every tick — same approach as
    // tests/litesvm/tests/crank.rs's `liquidation_after_two_ticks_below_mmr`.
    // With the spec default alpha (3000 bps) a 6% price drop trips the
    // deviation guard (`paused_open`) instead of converging the mark
    // predictably within a fixed tick count.
    console.log("=== set_params: ema_alpha_bps=10000, max_deviation_bps=10000 (deterministic demo, option a) ===");
    const coreEr = dexxerCoreProgram(erConn, boot.admin);
    const params = { ...MARKET_DEFAULTS, emaAlphaBps: 10_000, maxDeviationBps: 10_000 };
    const setParamsIx = await coreEr.methods
      .setParams(params)
      .accounts({ admin: boot.admin.publicKey, config: pdas.config(), market: boot.market })
      .instruction();
    // sendAndConfirmIx, not .rpc(): set_params targets Market (delegated to
    // the ER), and .rpc()'s confirm can stall on this validator — see
    // trader.ts's header comment / task-14-report.md for the full story.
    const setParamsSig = await sendAndConfirmIx(erConn, boot.admin, setParamsIx);
    console.log("set_params", setParamsSig);

    console.log("=== onboard A (alice) and B (bob), 1,000 dUSDC each ===");
    const A: Trader = await onboardTrader(boot, "alice", 1_000_000_000n);
    const B: Trader = await onboardTrader(boot, "bob", 1_000_000_000n);
    console.log("alice", A.kp.publicKey.toBase58());
    console.log("bob", B.kp.publicKey.toBase58());

    console.log("=== 2. set_price(150) + open A long / B short ===");
    const setPrice150Sig = await setPrice(boot, 150_00000000n);
    console.log("set_price(150)", setPrice150Sig);

    const openASig = await openPosition(boot, A, "long", 10, 150, 151);
    console.log("open_position A (long 10 SOL, margin $150, limit $151)", openASig);
    const openBSig = await openPosition(boot, B, "short", 5, 100, 149);
    console.log("open_position B (short 5 SOL, margin $100, limit $149)", openBSig);

    console.log("=== 3. spawn crank-fallback, wait 3 ticks, assert Market.mark == 150e6 ===");
    crank = spawn("npx", ["tsx", CRANK_SCRIPT], {
      env: { ...process.env, CRANK_INTERVAL_MS: String(CRANK_INTERVAL_MS) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = crank; // local non-null alias: TS can't narrow the module-scoped `crank` across later `await`s
    createInterface({ input: child.stdout }).on("line", (line: string) => {
      console.log("[crank]", line);
      const rec = parseTickLine(line);
      if (rec) tickLog.push(rec);
    });
    createInterface({ input: child.stderr }).on("line", (line: string) => console.error("[crank:err]", line));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => console.log(`[crank] exited code=${code} signal=${signal}`));

    await waitForTickCount(tickLog, 3, 30_000);
    const marketAfter3 = await accountNs(coreEr).market.fetch(boot.market);
    assert(marketAfter3.mark.toString() === "150000000", `Market.mark == 150e6 after 3 ticks (got ${marketAfter3.mark.toString()})`);

    console.log("=== 4. set_price(141) -> wait for A to be liquidated ===");
    const ticksBeforeMove = tickLog.length;
    const setPrice141Sig = await setPrice(boot, 141_00000000n);
    console.log("set_price(141)", setPrice141Sig);

    const liqDeadline = Date.now() + 30_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let posA: any;
    for (;;) {
      posA = await readPosition(A);
      if ("closed" in posA.state) break;
      if (Date.now() >= liqDeadline) throw new Error("A was not liquidated within 30s of the price move to $141");
      await sleep(300);
    }
    assert("closed" in posA.state, "A liquidated within 30s of price move to $141");
    const ticksToLiquidation = tickLog.length - ticksBeforeMove;
    assert(ticksToLiquidation >= 2, `A liquidated after >= 2 ticks of the price move (got ${ticksToLiquidation})`);
    assert("closed" in posA.state, "A.state == Closed");
    assert(posA.closed !== null && "liquidated" in posA.closed.reason, "A.closed.reason == Liquidated");
    console.log(`A liquidated after ${ticksToLiquidation} tick(s); closed record:`, {
      exit: posA.closed.exit.toString(),
      pnl: posA.closed.pnl.toString(),
      fees: posA.closed.fees.toString(),
    });

    const posB = await readPosition(B);
    assert("open" in posB.state, "B.state == Open (untouched by liquidation)");

    console.log("=== 5. close B manually ===");
    const closeBSig = await closePosition(boot, B, 0);
    console.log("close_position B", closeBSig);
    const posBAfter = await readPosition(B);
    assert("closed" in posBAfter.state, "B.state == Closed");
    assert("user" in posBAfter.closed.reason, "B.closed.reason == User");
    const expectedPnl = 45_000_000n; // 5 SOL x (150 - 141) = $45, short profits on a price drop
    assert(
      BigInt(posBAfter.closed.pnl.toString()) === expectedPnl,
      `B.closed.pnl == +$45 (5 x (150-141)) (got ${posBAfter.closed.pnl.toString()})`,
    );

    console.log("=== 6. invariant from ER state ===");
    // week-4 Task 1: trading writes PoolLive now, not the public Pool
    // snapshot (only commit_aggregate publishes that) — read the live counters.
    const pool = await accountNs(coreEr).poolLive.fetch(boot.poolLive);
    const userA = await accountNs(coreEr).userAccount.fetch(A.userAccount);
    const userB = await accountNs(coreEr).userAccount.fetch(B.userAccount);
    // Same formula as tests/litesvm/src/lib.rs's assert_invariant: sum of
    // (protocol_liquidity + fees_accrued + insurance) plus, per trader,
    // free_margin + (position.margin if still Open else 0) must equal
    // capital_total, which must equal the pool eATA's actual ER balance.
    const sum =
      BigInt(pool.protocolLiquidity.toString()) +
      BigInt(pool.feesAccrued.toString()) +
      BigInt(pool.insurance.toString()) +
      BigInt(userA.freeMargin.toString()) +
      BigInt(userB.freeMargin.toString());
    // Both positions are closed by this point, so no `+ position.margin` term applies.
    const capitalTotal = BigInt(pool.capitalTotal.toString());
    assert(sum === capitalTotal, `protocol_liquidity + fees + insurance + free_A + free_B == capital_total (${sum} == ${capitalTotal})`);
    const poolAtaBal = await erConn.getTokenAccountBalance(boot.poolAta, "confirmed");
    assert(
      BigInt(poolAtaBal.value.amount) === capitalTotal,
      `capital_total == ER pool ATA balance (${capitalTotal} == ${poolAtaBal.value.amount})`,
    );
    console.log("final invariant", {
      protocolLiquidity: pool.protocolLiquidity.toString(),
      feesAccrued: pool.feesAccrued.toString(),
      insurance: pool.insurance.toString(),
      badDebtTotal: pool.badDebtTotal.toString(),
      freeA: userA.freeMargin.toString(),
      freeB: userB.freeMargin.toString(),
      sum: sum.toString(),
      capitalTotal: capitalTotal.toString(),
      poolAtaBalance: poolAtaBal.value.amount,
    });

    console.log("=== 7. stop crank ===");
    if (crank) {
      const c = crank;
      c.kill("SIGINT");
      await new Promise<void>((r) => c.once("exit", () => r()));
      crank = null;
    }

    console.log(
      "\nWEEK1 CLI PASS",
      JSON.stringify(
        {
          alice: A.kp.publicKey.toBase58(),
          bob: B.kp.publicKey.toBase58(),
          openASig,
          openBSig,
          ticksToLiquidation,
          closeBSig,
          tickLog,
        },
        null,
        2,
      ),
    );
  } finally {
    // Always kill the crank child, on both the success and failure paths —
    // an orphaned `tsx crank-fallback/index.ts` would keep sending
    // crank_tick transactions against a stack the caller thinks is idle.
    if (crank && crank.exitCode === null && crank.signalCode === null) {
      crank.kill("SIGINT");
    }
  }
}

// Plain polling helpers throw (not `assert()`'s `process.exit(1)`) so a
// timeout is reported through the normal `main().catch()` -> "WEEK1 CLI
// FAIL" path instead of spamming an "ok:" log line on every 200ms poll.
async function waitForTickCount(log: TickRecord[], target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (log.length < target) {
    if (Date.now() >= deadline) throw new Error(`crank did not produce >= ${target} ticks within ${timeoutMs}ms (got ${log.length})`);
    await sleep(200);
  }
  assert(log.length >= target, `crank produced >= ${target} ticks within ${timeoutMs}ms (got ${log.length})`);
}

main().catch((e) => {
  console.error("WEEK1 CLI FAIL", e);
  process.exit(1);
});
