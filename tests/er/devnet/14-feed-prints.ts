// tests/er/devnet/14-feed-prints.ts — plan-4 gate #1 (spec §2.9 «Відкрите для плану 4»):
// does the real Pyth Lazer feed change `posted_slot` on EVERY print? `crank_tick`
// moves Market.last_print/sample_seq only when posted_slot != last_print, and
// liquidation_check counts ticks by sample_seq — a feed that repeats posted_slot
// across prints would never liquidate anyone. Public data, no keys.
// Run: cd tests/er && npm run devnet:feedprints -- SOL BTC
export {};
// lib/program.ts reads IDLs from target/idl (stale/absent here); the canonical position-slots IDL lives in <repo>/idl.
process.env.DEXXER_IDL_DIR ??= new URL("../../../idl", import.meta.url).pathname;
if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}
const { ORACLE, erConn, sleep, NET } = await import("../lib/env.js");
if (NET !== "devnet") throw new Error("DEXXER_NET=devnet required");
const { MARKET_CATALOG } = await import("../lib/markets.js");
const { pdas } = await import("../lib/program.js");
const { decodeFeed } = await import("../../../services/relayer/src/indexer/prices.js");
const symbols = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MARKET_CATALOG);
for (const s of symbols) if (!MARKET_CATALOG[s]) throw new Error(`unknown symbol ${s}`);
const DURATION_MS = 90_000;
const POLL_MS = 250;
type Print = { t: number; publishTime: bigint; postedSlot: bigint; price: bigint };
const results: Record<string, Print[]> = {};
const errors: Record<string, string> = {};
const feeds = Object.fromEntries(symbols.map((s) => [s, pdas.feedUnder(ORACLE, MARKET_CATALOG[s].lazerFeedId)]));
console.log(`start ${new Date().toISOString()} symbols=${symbols.join(",")}`);
const start = Date.now();
while (Date.now() - start < DURATION_MS) {
  for (const s of symbols) {
    try {
      const info = await erConn.getAccountInfo(feeds[s]);
      if (!info) { errors[s] = "account missing"; continue; }
      const d = decodeFeed(info.data);
      const arr = (results[s] ??= []);
      const last = arr.at(-1);
      if (!last || last.publishTime !== d.publishTime || last.postedSlot !== d.postedSlot) arr.push({ t: Date.now(), ...d });
    } catch (e) {
      errors[s] = (e as Error).message;
    }
  }
  await sleep(POLL_MS);
}
let pass = true;
const failed: string[] = [];
console.log("symbol | prints | distinct_posted_slot | repeats_posted_slot | min_gap_ms | max_gap_ms | stale>2s");
for (const s of symbols) {
  const arr = results[s] ?? [];
  const slots = new Set(arr.map((p) => p.postedSlot.toString()));
  const repeats = arr.length - slots.size;
  const gaps = arr.slice(1).map((p, i) => p.t - arr[i].t);
  const stale = gaps.filter((g) => g > 2000).length;
  if (repeats > 0 || arr.length < 10) { pass = false; failed.push(s); }
  const mn = gaps.length ? Math.min(...gaps) : "n/a";
  const mx = gaps.length ? Math.max(...gaps) : "n/a";
  console.log(`${s} | ${arr.length} | ${slots.size} | ${repeats} | ${mn} | ${mx} | ${stale}${errors[s] ? ` (last error: ${errors[s]})` : ""}`);
}
console.log(`end ${new Date().toISOString()}`);
console.log(pass ? "FEED-PRINTS PASS" : `FEED-PRINTS FAIL (${failed.join(", ")})`);
process.exit(pass ? 0 : 1);
