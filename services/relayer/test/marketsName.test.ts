// services/relayer/test/marketsName.test.ts — `/markets` carries each asset's display name.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { indexerRouter } from "../src/indexer/http.js";
import type { DbPool } from "../src/db.js";
import type { MarketInfo } from "../src/markets.js";

const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as DbPool;
const m = (symbol: string): MarketInfo => ({
  symbol, market: Keypair.generate().publicKey, marketRisk: Keypair.generate().publicKey, feed: Keypair.generate().publicKey,
  params: { maxLevBps: 100_000, imrBps: 1_000, mmrBps: 500, openFeeBps: 6, closeFeeBps: 6, liqFeeBps: 100,
    oiCap: "0", maxPosition: "1", minSize: "1", maxStalenessSecs: "15", pausedOpen: false },
});

async function get(opts: Parameters<typeof indexerRouter>[1], path: string): Promise<unknown> {
  const app = express();
  app.use(indexerRouter(pool, opts));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return await res.json();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /markets: name from the asset table, null when the symbol is not there", async () => {
  const names: Record<string, string> = { ETH: "Ethereum" };
  const body = (await get({ markets: () => [m("ETH"), m("NEW")], names: (s) => names[s] ?? null }, "/markets")) as { symbol: string; name: string | null }[];
  assert.deepEqual(body.map((r) => [r.symbol, r.name]), [["ETH", "Ethereum"], ["NEW", null]]);
});

test("GET /markets: without a names lookup every name is null (additive field)", async () => {
  const body = (await get({ markets: () => [m("ETH")] }, "/markets")) as { name: string | null }[];
  assert.equal(body[0].name, null);
});
