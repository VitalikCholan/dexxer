// scripts/crank-fallback/index.ts
//
// Thin local-run shim (Task 4, week 4): the real tick/disclosure loop moved
// to services/relayer/src/crank.ts (`startCrank`) — see that file's header
// comment and services/relayer/README.md for the actual crank service
// (Railway, `npm run crank` from scripts/, or `npm start` from
// services/relayer/).
//
// This file exists only so existing local tooling that spawns it as a
// child process — scripts/demo/week1-cli.ts's
// `spawn("npx", ["tsx", CRANK_SCRIPT])` — keeps working unchanged against
// mb-stack: it builds a minimal `RelayerConfig`/`RelayerState` from
// env/`tests/er/.keys/` (the same identities `services/relayer/src/index.ts`
// would load) and calls `startCrank` directly, without the HTTP/health/
// Postgres pieces (irrelevant to this local-only path). SIGINT still exits
// after the in-flight tick finishes (`requestStop()`), matching this
// script's pre-move behavior byte-for-byte on stdout (`tick n=...` lines —
// week1-cli.ts's `parseTickLine` parses those unchanged).
//
// Not a deployable entrypoint — see services/relayer/ for that.

export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { loadOrCreateKey, NET } = await import("../../tests/er/lib/env.js");
const { startCrank, requestStop } = await import("../../services/relayer/src/crank.js");
type RelayerConfig = Parameters<typeof startCrank>[0];
type RelayerState = Parameters<typeof startCrank>[1];

const crank = loadOrCreateKey(NET === "devnet" ? "devnet-crank" : "admin");
const feePayer = loadOrCreateKey(NET === "devnet" ? "devnet-fee-payer" : "admin");

const cfg: RelayerConfig = {
  net: NET,
  baseRpc: "",
  erRpc: "",
  erWs: "",
  crank,
  feePayer,
  port: 0,
  indexerEnabled: false,
  sponsorEnabled: false,
};
const state: RelayerState = { lastTickAt: null, lastCommitAt: null, tick: 0, errors: [] };

process.on("SIGINT", () => {
  requestStop();
});

startCrank(cfg, state).catch((e) => {
  console.error("crank-fallback FAIL", e);
  process.exit(1);
});
