// tests/er/devnet/10-set-params.ts
//
// Week-5 Task 4 (migration): patch individual `MarketParams` fields on the
// delegated devnet `Market` without touching the rest.
//
// `set_params` takes the WHOLE `MarketParams` struct, so a naive call would
// silently reset every field a caller did not think about — and the devnet
// market has at least one value that deliberately differs from
// `MarketParams::sol_perp_defaults()` (`max_conf_bps = 0`, week-2 finding:
// the real Pricing Oracle reports `conf == 0` on devnet). This script
// therefore reads the live `Market` first, overlays only the `KEY=VALUE`
// pairs given on the command line, and sends that.
//
// `Market` is delegated to the ER, so this is an ER-targeted call signed by
// the admin (the same path 05-crank-liquidation.ts uses for its temporary
// mmr_bps bump). `commit_market` is a separate admin call — not done here;
// the L1 `Market` snapshot stays stale until the next one, exactly as before.
//
// Run: `npm run devnet:setparams -- liqHysteresisTicks=3`
//      `npm run devnet:setparams -- --market BTC maxStalenessSecs=20` (any
//      listed market; default SOL — the market is `pdas.marketFor(symbol)`)
//      `npm run devnet:setparams` (no args) just prints the live SOL params.

export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { BN } = await import("@coral-xyz/anchor");
const envMod = await import("../lib/env.js");
const { NET, loadOrCreateKey, sendAndConfirmIx, teeConn } = envMod;
const assert: (cond: unknown, msg: string) => asserts cond = envMod.assert;
const { accountNs, dexxerCoreProgram, pdas } = await import("../lib/program.js");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}").`);
  process.exit(1);
}

/** Exactly `MarketParams`' fields, camelCased as Anchor's IDL coder expects them. */
const MARKET_PARAM_FIELDS = [
  "maxLevBps",
  "imrBps",
  "mmrBps",
  "openFeeBps",
  "closeFeeBps",
  "liqFeeBps",
  "oiCap",
  "maxPosition",
  "minSize",
  "maxStalenessSecs",
  "maxConfBps",
  "maxDeviationBps",
  "emaAlphaBps",
  "liqHysteresisTicks",
  "maxStaleTicks",
] as const;
type ParamField = (typeof MARKET_PARAM_FIELDS)[number];
/** The four `u64` fields — Anchor wants a `BN` for these, a plain number for the rest. */
const U64_FIELDS = new Set<ParamField>(["oiCap", "maxPosition", "minSize", "maxStalenessSecs"]);

const admin = loadOrCreateKey("devnet-admin");
const conn = await teeConn(admin);
const core = dexxerCoreProgram(conn, admin);
const config = pdas.config();

// `--market SYM` (anywhere in argv, default SOL) picks the market; the rest are KEY=VALUE patches.
const argv = process.argv.slice(2);
let symbol = "SOL";
const marketFlag = argv.indexOf("--market");
if (marketFlag >= 0) {
  const value = argv[marketFlag + 1];
  assert(value !== undefined && !value.startsWith("--") && !value.includes("="), "--market takes a symbol (e.g. --market BTC)");
  symbol = value.toUpperCase();
  argv.splice(marketFlag, 2);
}
const market = pdas.marketFor(symbol);
console.log(`market ${symbol}: ${market.toBase58()}`);

const live = await accountNs(core).market.fetch(market);
const params: Record<string, unknown> = {};
for (const f of MARKET_PARAM_FIELDS) params[f] = live[f];
// `BN` fields stringify as `{...}` through plain JSON.stringify — print every value via String().
console.log("live Market params:", JSON.stringify(Object.fromEntries(MARKET_PARAM_FIELDS.map((f) => [f, String(params[f])]))));

const patches = argv;
if (patches.length === 0) {
  console.log("no KEY=VALUE arguments given — nothing to write");
  process.exit(0);
}

for (const arg of patches) {
  const eq = arg.indexOf("=");
  assert(eq > 0, `argument "${arg}" is KEY=VALUE`);
  const key = arg.slice(0, eq) as ParamField;
  const value = arg.slice(eq + 1);
  assert((MARKET_PARAM_FIELDS as readonly string[]).includes(key), `"${key}" is a MarketParams field (one of: ${MARKET_PARAM_FIELDS.join(", ")})`);
  params[key] = U64_FIELDS.has(key) ? new BN(value) : Number(value);
  console.log(`patch ${key} = ${value}`);
}

const sig = await sendAndConfirmIx(
  conn,
  admin,
  await core.methods.setParams(params).accounts({ admin: admin.publicKey, config, market }).instruction(),
);
console.log("set_params", sig);

const after = await accountNs(core).market.fetch(market);
for (const arg of patches) {
  const key = arg.slice(0, arg.indexOf("=")) as ParamField;
  assert(String(after[key]) === String(params[key]), `${key} on-chain == ${String(params[key])} (got ${String(after[key])})`);
}
console.log("10-SET-PARAMS PASS", JSON.stringify({ market: symbol, sig, patched: patches }));
