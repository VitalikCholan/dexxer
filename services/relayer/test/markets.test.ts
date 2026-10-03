import { test } from "node:test";
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import express from "express";
import type { AddressInfo } from "node:net";
import { indexerRouter } from "../src/indexer/http.js";
import { createMarketRegistry, keepPrivateMarkets, marketInfoFrom, sortMarkets, type MarketInfo } from "../src/markets.js";
import { PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { pdas, symbolBytes } from "../../../tests/er/lib/program.js";

function decoded(sym: string, o: Record<string, unknown> = {}) {
  return {
    symbol: Array.from(symbolBytes(sym)), feed: Keypair.generate().publicKey,
    maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500, openFeeBps: 6, closeFeeBps: 6, liqFeeBps: 100,
    oiCap: new BN(0), maxPosition: new BN("100000000000"), minSize: new BN(20_000), maxStalenessSecs: new BN(15),
    pausedOpen: false, ...o,
  };
}
const info = (sym: string): MarketInfo => marketInfoFrom(pdas.marketFor(sym), decoded(sym));

test("marketInfoFrom keeps public params, derives MarketRisk, stringifies u64", () => {
  const m = info("BTC");
  assert.equal(m.symbol, "BTC");
  assert.ok(m.marketRisk.equals(pdas.marketRisk(pdas.marketFor("BTC"))));
  assert.equal(m.params.minSize, "20000");
  assert.equal(m.params.maxPosition, "100000000000");
  assert.equal(m.params.pausedOpen, false);
});

test("sortMarkets puts SOL first, then alphabetical", () => {
  assert.deepEqual(sortMarkets([info("ZEC"), info("BTC"), info("SOL"), info("ETH")]).map((m) => m.symbol), ["SOL", "BTC", "ETH", "ZEC"]);
});

test("registry keeps the last good list when a refresh fails", async () => {
  let calls = 0;
  const reg = createMarketRegistry({
    load: async () => {
      calls += 1;
      if (calls === 2) throw new Error("ER down");
      return [info("SOL"), info("BTC")];
    },
    log: () => {},
  });
  assert.deepEqual(reg.list(), []);
  await reg.refresh();
  assert.equal(reg.list().length, 2);
  await reg.refresh(); // throws inside, swallowed
  assert.deepEqual(reg.list().map((m) => m.symbol), ["SOL", "BTC"]);
  assert.equal(reg.get("BTC")?.symbol, "BTC");
  assert.equal(reg.get("DOGE"), undefined);
});

test("GET /markets lists the registry with public params only", async () => {
  const app = express().use(indexerRouter({} as never, { markets: () => [info("SOL"), info("BTC")] }));
  const server = app.listen(0);
  try {
    await new Promise<void>((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const body = await (await fetch(`http://127.0.0.1:${port}/markets`)).json();
    assert.deepEqual(body.map((m: { symbol: string }) => m.symbol), ["SOL", "BTC"]);
    assert.equal(body[1].params.minSize, "20000");
    assert.equal(body[1].market, pdas.marketFor("BTC").toBase58());
    assert.equal("marketRisk" in body[1], false, "MarketRisk is private — never served");
  } finally {
    server.close();
  }
});

test("registry: a refresh while one is in flight reuses it — load runs once (F1)", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reg = createMarketRegistry({
    load: async () => {
      calls += 1;
      await gate;
      return [info("SOL")];
    },
    log: () => {},
  });
  const a = reg.refresh();
  const b = reg.refresh();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  await reg.refresh();
  assert.equal(calls, 2, "a later refresh loads again");
});

test("keepPrivateMarkets keeps only markets whose MarketRisk permission is owned by the permission program (F2)", () => {
  const ms = [info("SOL"), info("BTC"), info("ETH")];
  const kept = keepPrivateMarkets(ms, [PERMISSION_PROGRAM_ID, null, Keypair.generate().publicKey]);
  assert.deepEqual(kept.map((m) => m.symbol), ["SOL"], "missing permission and a foreign-owned PDA are both dropped");
  assert.deepEqual(keepPrivateMarkets(ms, [PERMISSION_PROGRAM_ID, PERMISSION_PROGRAM_ID, PERMISSION_PROGRAM_ID]).map((m) => m.symbol), ["SOL", "BTC", "ETH"]);
});
