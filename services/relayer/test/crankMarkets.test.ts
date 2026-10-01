import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cycleStuck, formatTickLine, groupOpenByMarket, nextFreshBlockhash, planTick, rotateMarkets, runMarkets, shouldRecordError, tickSet, untickedMarkets,
  watchdogExpired, withSol,
} from "../src/crank.js";
import { isSharedError } from "../src/errors.js";
import type { MarketInfo } from "../src/markets.js";
import { marketInfoFrom } from "../src/markets.js";
import { pdas, symbolBytes } from "../../../tests/er/lib/program.js";
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";

const mk = (sym: string) =>
  marketInfoFrom(pdas.marketFor(sym), {
    symbol: Array.from(symbolBytes(sym)), feed: Keypair.generate().publicKey,
    maxLevBps: 1, imrBps: 1, mmrBps: 1, openFeeBps: 1, closeFeeBps: 1, liqFeeBps: 1,
    oiCap: new BN(0), maxPosition: new BN(1), minSize: new BN(1), maxStalenessSecs: new BN(1), pausedOpen: false,
  });

test("groupOpenByMarket splits candidates by their market", () => {
  const sol = pdas.marketFor("SOL").toBase58();
  const btc = pdas.marketFor("BTC").toBase58();
  const g = groupOpenByMarket([{ market: sol, k: 1 }, { market: btc, k: 2 }, { market: sol, k: 3 }]);
  assert.deepEqual(g.get(sol)?.map((r) => r.k), [1, 3]);
  assert.deepEqual(g.get(btc)?.map((r) => r.k), [2]);
});

test("withSol: SOL is always ticked — empty list, list without SOL, list with SOL", () => {
  const sol = mk("SOL");
  const btc = mk("BTC");
  assert.deepEqual(withSol([], () => sol).map((m) => m.symbol), ["SOL"]);
  assert.deepEqual(withSol([btc], () => sol).map((m) => m.symbol), ["SOL", "BTC"]);
  const listed = mk("SOL");
  assert.equal(withSol([listed, btc], () => sol)[0], listed, "the registry's own SOL entry wins");
});

test("untickedMarkets names markets that have open positions but are not ticked", () => {
  const btc = mk("BTC");
  const stray = Keypair.generate().publicKey.toBase58();
  const byMarket = new Map<string, unknown[]>([[btc.market.toBase58(), [1]], [stray, [1]]]);
  assert.deepEqual(untickedMarkets(byMarket, [btc]), [stray]);
  assert.deepEqual(untickedMarkets(new Map(), [btc]), []);
});

// Final review I4/m6 + fix round 2 (R1): the production classifier and real
// error strings; only a SHARED error stops the loop.
const ON_CHAIN = 'transaction 5abc failed: {"InstructionError":[1,{"Custom":3002}]}';
const CONFIRM_TIMEOUT = "confirmSignature timeout waiting for 5abc";
async function run(markets: MarketInfo[], failing: Record<string, string>, sharedAfterTick: string[] = []) {
  const errors: string[] = [];
  const called: string[] = [];
  const r = await runMarkets(
    markets,
    async (m) => {
      called.push(m.symbol);
      if (failing[m.symbol]) throw new Error(failing[m.symbol]);
      return { sharedError: sharedAfterTick.includes(m.symbol) };
    },
    (m, e) => errors.push(`${m.symbol}:${String(e)}`),
    isSharedError,
  );
  return { r, errors, called };
}

test("runMarkets: one market failing ON CHAIN does not stop the others (F6)", async () => {
  const { r, errors, called } = await run([mk("SOL"), mk("BTC"), mk("ETH")], { BTC: ON_CHAIN });
  assert.deepEqual(called, ["SOL", "BTC", "ETH"]);
  assert.deepEqual(r.ticked, ["SOL", "ETH"]);
  assert.deepEqual(r.failed, ["BTC"]);
  assert.deepEqual(r.notTicked, []);
  assert.equal(r.needsReconnect, false);
  assert.equal(errors.length, 1);
});

test("runMarkets: the first SHARED error stops the loop — later markets NOT ticked, needsReconnect, stoppedAt (I4, R1)", async () => {
  for (const msg of ["401 Unauthorized", "fetch failed", "429 Too Many Requests", "503 Service Unavailable"]) {
    const sol = mk("SOL");
    const { r, called } = await run([sol, mk("BTC"), mk("ETH")], { SOL: msg, BTC: "HTTP 401" });
    assert.deepEqual(called, ["SOL"], msg);
    assert.deepEqual(r.failed, ["SOL"]);
    assert.deepEqual(r.notTicked, ["BTC", "ETH"]);
    assert.equal(r.needsReconnect, true);
    assert.equal(r.stoppedAt, sol.market.toBase58());
  }
});

test("runMarkets: a MARKET-LOCAL error (confirm timeout, build error) on market 1 -> markets 2..n still ticked, no reconnect (R1)", async () => {
  for (const msg of [CONFIRM_TIMEOUT, "Invalid arguments: feed not provided."]) {
    const { r, called, errors } = await run([mk("SOL"), mk("BTC"), mk("ETH")], { SOL: msg });
    assert.deepEqual(called, ["SOL", "BTC", "ETH"], msg);
    assert.deepEqual(r.failed, ["SOL"]);
    assert.deepEqual(r.ticked, ["BTC", "ETH"]);
    assert.deepEqual(r.notTicked, []);
    assert.equal(r.needsReconnect, false);
    assert.equal(r.stoppedAt, null);
    assert.equal(errors.length, 1, "recorded");
  }
});

test("runMarkets: a market that ticked but then hit a SHARED error stops the loop too (I4)", async () => {
  const { r, called } = await run([mk("SOL"), mk("BTC"), mk("ETH")], {}, ["BTC"]);
  assert.deepEqual(called, ["SOL", "BTC"]);
  assert.deepEqual(r.ticked, ["SOL", "BTC"], "BTC landed something before the error");
  assert.deepEqual(r.notTicked, ["ETH"]);
  assert.equal(r.needsReconnect, true);
});

test("runMarkets: solTicked false when SOL failed on chain while BTC succeeded (F3/F6)", async () => {
  const { r } = await run([mk("SOL"), mk("BTC")], { SOL: ON_CHAIN });
  assert.equal(r.solTicked, false);
  assert.deepEqual(r.ticked, ["BTC"]);
});

test("runMarkets: all succeed -> ticked in order, solTicked (F6)", async () => {
  const { r } = await run([mk("SOL"), mk("BTC"), mk("ETH")], {});
  assert.deepEqual(r.ticked, ["SOL", "BTC", "ETH"]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.solTicked, true);
  assert.equal(r.needsReconnect, false);
});

test("shouldRecordError: new message or window elapsed records, a repeat within the window does not (F7)", () => {
  assert.equal(shouldRecordError(undefined, "boom", 1_000, 60_000), true, "first error of a market");
  assert.equal(shouldRecordError({ msg: "boom", at: 1_000 }, "boom", 30_000, 60_000), false, "same message inside the window");
  assert.equal(shouldRecordError({ msg: "boom", at: 1_000 }, "other", 30_000, 60_000), true, "different message");
  assert.equal(shouldRecordError({ msg: "boom", at: 1_000 }, "boom", 61_000, 60_000), true, "window elapsed");
});

// --- fix round 1 (F1): discovery failing must not freeze the markets ---

test("planTick: discovery ok -> candidates grouped by market, the loop counts for health", () => {
  const owner = Keypair.generate().publicKey;
  const c = (market: string) => ({ positions: Keypair.generate().publicKey, owner, market });
  const p = planTick({ ok: true, candidates: [c("a"), c("b"), c("a")] });
  assert.equal(p.countsForHealth, true);
  assert.deepEqual([...p.byMarket.keys()].sort(), ["a", "b"]);
  assert.equal(p.byMarket.get("a")?.length, 2);
});

test("planTick: discovery failed -> every market ticks with no candidate, the loop does not count for health", () => {
  const p = planTick({ ok: false });
  assert.equal(p.countsForHealth, false);
  assert.equal(p.byMarket.size, 0);
});

test("withSol works on symbol-only views too (health lists SOL while the registry is empty)", () => {
  const sol = () => ({ symbol: "SOL" });
  assert.deepEqual(withSol([] as { symbol: string }[], sol).map((m) => m.symbol), ["SOL"]);
  assert.deepEqual(withSol([{ symbol: "BTC" }], sol).map((m) => m.symbol), ["SOL", "BTC"]);
});

// --- final review I3: the crank's tick set is sticky and follows the open positions ---

test("tickSet: SOL first, then the registry, then sticky markets the registry dropped; candidate markets nobody knows are returned as unknown", () => {
  const sol = mk("SOL");
  const btc = mk("BTC");
  const eth = mk("ETH");
  const doge = mk("DOGE");
  const sticky = new Map([[eth.market.toBase58(), eth]]);
  const stray = Keypair.generate().publicKey.toBase58();
  const byMarket = new Map<string, unknown[]>([[btc.market.toBase58(), [1]], [eth.market.toBase58(), [1]], [doge.market.toBase58(), [1]], [stray, [1]]]);
  const r = tickSet(sticky, [btc], () => sol, byMarket);
  assert.deepEqual(r.markets.map((m) => m.symbol), ["SOL", "BTC", "ETH"], "ETH left the registry but stays (sticky)");
  assert.deepEqual(r.unknown, [doge.market.toBase58(), stray].sort());
});

test("tickSet: the registry's entry wins over a sticky one for the same market; no market twice", () => {
  const sol = mk("SOL");
  const btcOld = mk("BTC");
  const btcNew = mk("BTC");
  const sticky = new Map([[btcOld.market.toBase58(), btcOld], [sol.market.toBase58(), sol]]);
  const r = tickSet(sticky, [btcNew], () => sol, new Map());
  assert.deepEqual(r.markets.map((m) => m.symbol), ["SOL", "BTC"]);
  assert.equal(r.markets[1], btcNew);
  assert.deepEqual(r.unknown, []);
});

test("tickSet: empty registry and empty sticky map -> SOL alone (withSol)", () => {
  const sol = mk("SOL");
  const r = tickSet(new Map(), [], () => sol, new Map([[sol.market.toBase58(), [1]]]));
  assert.deepEqual(r.markets, [sol]);
  assert.deepEqual(r.unknown, []);
});

test("watchdogExpired: only when no loop iteration completed within the limit (I2)", () => {
  assert.equal(watchdogExpired(1_000, 1_000 + 120_000, 120_000), false, "exactly at the limit");
  assert.equal(watchdogExpired(1_000, 1_000 + 120_001, 120_000), true);
  assert.equal(watchdogExpired(1_000, 2_000, 120_000), false);
});

test("nextFreshBlockhash: returns the first blockhash different from the last one", async () => {
  const seq = ["A", "A", "B"];
  let t = 0;
  const r = await nextFreshBlockhash(async () => ({ blockhash: seq.shift() ?? "Z", lastValidBlockHeight: 1 }), "A", {
    limitMs: 5_000, pollMs: 200, now: () => t, sleep: async (ms) => { t += ms; },
  });
  assert.equal(r.blockhash, "B");
});

test("nextFreshBlockhash: gives up after the limit with a SHARED error (I2d, R1)", async () => {
  let t = 0;
  let calls = 0;
  const p = nextFreshBlockhash(async () => { calls += 1; return { blockhash: "A", lastValidBlockHeight: 1 }; }, "A", {
    limitMs: 5_000, pollMs: 200, now: () => t, sleep: async (ms) => { t += ms; },
  });
  await assert.rejects(p, (e: Error) => /freshBlockhash timeout/.test(e.message) && isSharedError(e));
  assert.ok(calls >= 25 && calls <= 27, `polled until the limit (${calls})`);
});

test("formatTickLine: counts, never keys; unreadable fields are null (I5)", () => {
  const line = formatTickLine({ n: 7, market: "SOL", mark: "150000000", markSlot: "42", sig: "5sig", cu: 1234, tickMs: 80, candidates: 3, liquidated: 1 });
  assert.equal(line, "tick n=7 market=SOL mark=150000000 mark_slot=42 sig=5sig cu=1234 tick_ms=80 candidates=3 liquidated=1");
  const nulls = formatTickLine({ n: 8, market: "BTC", mark: null, markSlot: null, sig: "5sig", cu: null, tickMs: 90, candidates: 0, liquidated: null });
  assert.equal(nulls, "tick n=8 market=BTC mark=null mark_slot=null sig=5sig cu=null tick_ms=90 candidates=0 liquidated=null");
  assert.ok(!/\[/.test(line), "no key list");
});

// --- fix round 2 (R1.3): no market is permanently starved ---

test("rotateMarkets: no short-circuit -> registry order; after one -> start at the market AFTER the one that stopped it, wrapping", () => {
  const [sol, btc, eth] = [mk("SOL"), mk("BTC"), mk("ETH")];
  const list = [sol, btc, eth];
  assert.deepEqual(rotateMarkets(list, null).map((m) => m.symbol), ["SOL", "BTC", "ETH"]);
  assert.deepEqual(rotateMarkets(list, sol.market.toBase58()).map((m) => m.symbol), ["BTC", "ETH", "SOL"]);
  assert.deepEqual(rotateMarkets(list, btc.market.toBase58()).map((m) => m.symbol), ["ETH", "SOL", "BTC"]);
  assert.deepEqual(rotateMarkets(list, eth.market.toBase58()).map((m) => m.symbol), ["SOL", "BTC", "ETH"], "wraps");
  assert.deepEqual(rotateMarkets([sol, eth], btc.market.toBase58()).map((m) => m.symbol), ["SOL", "ETH"], "a market gone from the set: registry order");
  assert.deepEqual(rotateMarkets([], sol.market.toBase58()), []);
});

test("rotation carried across loops: a market whose ticks always hit a SHARED error does not starve the others", async () => {
  const [sol, btc, eth] = [mk("SOL"), mk("BTC"), mk("ETH")];
  let resumeAfter: string | null = null;
  const ticked = new Set<string>();
  for (let loop = 0; loop < 3; loop++) {
    const { r } = await run(rotateMarkets([sol, btc, eth], resumeAfter), { SOL: "fetch failed" });
    r.ticked.forEach((x) => ticked.add(x));
    resumeAfter = r.stoppedAt;
  }
  assert.deepEqual([...ticked].sort(), ["BTC", "ETH"], "BTC and ETH are reached although SOL stops every loop it is tried in");
});

test("SOL failing market-locally every loop does not starve the others (R1)", async () => {
  let resumeAfter: string | null = null;
  for (let loop = 0; loop < 3; loop++) {
    const { r, called } = await run(rotateMarkets([mk("SOL"), mk("BTC"), mk("ETH")], resumeAfter), { SOL: CONFIRM_TIMEOUT });
    assert.deepEqual(called, ["SOL", "BTC", "ETH"], `loop ${loop}`);
    assert.deepEqual(r.ticked, ["BTC", "ETH"]);
    assert.equal(r.needsReconnect, false);
    resumeAfter = r.stoppedAt;
  }
});

test("cycleStuck: only a cycle in flight for longer than the limit (R2)", () => {
  assert.equal(cycleStuck(null, 10_000_000, 900_000), false, "no cycle in flight");
  assert.equal(cycleStuck(1_000, 1_000 + 900_000, 900_000), false, "exactly at the limit");
  assert.equal(cycleStuck(1_000, 1_000 + 900_001, 900_000), true);
});
