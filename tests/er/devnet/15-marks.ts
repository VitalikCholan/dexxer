// tests/er/devnet/15-marks.ts — plan-4 gate (#38, spec §2.9): every listed market
// needs a live `crank_tick` as the sample source for `liquidation_check`, which
// only reads `Market`. Polls the public `Market` of every MARKET_CATALOG symbol on
// the ER every 1 s for 60 s and checks that each one is ticking (`mark_slot`
// moves) and accepting new oracle prints (`sample_seq` grows). Public data, no keys.
// Run: cd tests/er && npm run devnet:marks [-- SOL BTC]
export {};
// lib/program.ts reads the canonical position-slots IDL from <repo>/idl.
process.env.DEXXER_IDL_DIR ??= new URL("../../../idl", import.meta.url).pathname;
if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}
const { erConn, sleep, NET } = await import("../lib/env.js");
if (NET !== "devnet") throw new Error("DEXXER_NET=devnet required");
const { MARKET_CATALOG } = await import("../lib/markets.js");
const { pdas } = await import("../lib/program.js");

// `Market` layout (programs/dexxer_core/src/state/market.rs, idl/dexxer_core.json,
// same decomposition as app/src/lib/codecs.ts): disc(8) + version(1) + symbol(8)
// + feed(32) + max_lev_bps(4) + imr_bps(4) + mmr_bps(4) + open/close/liq_fee_bps(2×3)
// + oi_cap/max_position/min_size/max_staleness_secs(8×4) + max_conf_bps(2)
// + max_deviation_bps(2) = 103 -> mark | mark_slot | last_print | sample_seq (u64 each).
const SYMBOL_OFFSET = 8 + 1;
const MARK_OFFSET = 103;
const MARK_SLOT_OFFSET = MARK_OFFSET + 8;
const LAST_PRINT_OFFSET = MARK_SLOT_OFFSET + 8;
const SAMPLE_SEQ_OFFSET = LAST_PRINT_OFFSET + 8;
const MIN_LEN = SAMPLE_SEQ_OFFSET + 8;

type Sample = { mark: bigint; markSlot: bigint; lastPrint: bigint; sampleSeq: bigint };
function decode(symbol: string, data: Buffer): Sample {
  if (data.length < MIN_LEN) throw new Error(`${symbol}: Market too short (${data.length} B)`);
  const onChain = data.subarray(SYMBOL_OFFSET, SYMBOL_OFFSET + 8).toString("latin1").replace(/\0+$/, "");
  if (onChain !== symbol) throw new Error(`${symbol}: Market.symbol is "${onChain}" — layout mismatch`);
  return {
    mark: data.readBigUInt64LE(MARK_OFFSET),
    markSlot: data.readBigUInt64LE(MARK_SLOT_OFFSET),
    lastPrint: data.readBigUInt64LE(LAST_PRINT_OFFSET),
    sampleSeq: data.readBigUInt64LE(SAMPLE_SEQ_OFFSET),
  };
}

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MARKET_CATALOG);
for (const s of symbols) if (!MARKET_CATALOG[s]) throw new Error(`unknown symbol ${s}`);
const DURATION_MS = 60_000;
const POLL_MS = 1_000;
const MIN_TICKS = 30;
const markets = Object.fromEntries(symbols.map((s) => [s, pdas.marketFor(s)]));
type Track = { first?: Sample; last?: Sample; ticks: number; printChanges: number; reads: number };
const tracks: Record<string, Track> = Object.fromEntries(symbols.map((s) => [s, { ticks: 0, printChanges: 0, reads: 0 }]));
const errors: Record<string, string> = {};
console.log(`start ${new Date().toISOString()} symbols=${symbols.join(",")}`);
for (const s of symbols) console.log(`  ${s} market=${markets[s].toBase58()}`);
const start = Date.now();
while (Date.now() - start < DURATION_MS) {
  const t0 = Date.now();
  await Promise.all(symbols.map(async (s) => {
    try {
      const info = await erConn.getAccountInfo(markets[s]);
      if (!info) { errors[s] = "account missing"; return; }
      const d = decode(s, info.data);
      const tr = tracks[s];
      tr.reads++;
      if (tr.last) {
        if (d.markSlot !== tr.last.markSlot) tr.ticks++;
        if (d.lastPrint !== tr.last.lastPrint) tr.printChanges++;
      } else tr.first = d;
      tr.last = d;
    } catch (e) {
      errors[s] = (e as Error).message;
    }
  }));
  await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
}
let pass = true;
const failed: string[] = [];
console.log("symbol | mark_slot_start | mark_slot_end | ticks | last_print_changes | sample_seq_delta");
for (const s of symbols) {
  const tr = tracks[s];
  const delta = tr.first && tr.last ? tr.last.sampleSeq - tr.first.sampleSeq : 0n;
  if (tr.ticks < MIN_TICKS || delta <= 0n) { pass = false; failed.push(s); }
  console.log(
    `${s} | ${tr.first?.markSlot ?? "n/a"} | ${tr.last?.markSlot ?? "n/a"} | ${tr.ticks} | ${tr.printChanges} | ${delta}` +
      ` (reads=${tr.reads}, mark=${tr.last?.mark ?? "n/a"})${errors[s] ? ` (last error: ${errors[s]})` : ""}`,
  );
}
console.log(`end ${new Date().toISOString()}`);
console.log(pass ? "MARKS PASS" : `MARKS FAIL (${failed.join(", ")})`);
process.exit(pass ? 0 : 1);
