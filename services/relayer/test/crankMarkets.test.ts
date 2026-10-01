import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOpenByMarket, planTick, runMarkets, shouldRecordError, untickedMarkets, withSol } from "../src/crank.js";
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

const isAuth = (e: unknown) => /401/.test(String(e));
async function run(markets: MarketInfo[], failing: Record<string, string>) {
  const errors: string[] = [];
  const called: string[] = [];
  const r = await runMarkets(
    markets,
    async (m) => {
      called.push(m.symbol);
      if (failing[m.symbol]) throw new Error(failing[m.symbol]);
    },
    (m, e) => errors.push(`${m.symbol}:${String(e)}`),
    isAuth,
  );
  return { r, errors, called };
}

test("runMarkets: one market throwing does not stop the others (F6)", async () => {
  const { r, errors, called } = await run([mk("SOL"), mk("BTC"), mk("ETH")], { BTC: "rpc blew up" });
  assert.deepEqual(called, ["SOL", "BTC", "ETH"]);
  assert.deepEqual(r.ticked, ["SOL", "ETH"]);
  assert.deepEqual(r.failed, ["BTC"]);
  assert.equal(r.needsReconnect, false);
  assert.equal(errors.length, 1);
});

test("runMarkets: auth-looking errors -> needsReconnect once, however many markets failed (F6)", async () => {
  const { r } = await run([mk("SOL"), mk("BTC"), mk("ETH")], { SOL: "401 unauthorized", BTC: "HTTP 401" });
  assert.equal(r.needsReconnect, true);
  assert.deepEqual(r.failed, ["SOL", "BTC"]);
});

test("runMarkets: solTicked false when SOL threw while BTC succeeded (F3/F6)", async () => {
  const { r } = await run([mk("SOL"), mk("BTC")], { SOL: "stuck" });
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
