// tests/er/devnet/00-measure.ts
//
// Entrypoint: DEXXER_NET=devnet npx tsx devnet/00-measure.ts
//
// Bootstrap only. `tests/er/.env` pins LOCAL mb-stack endpoints
// (BASE_RPC=http://127.0.0.1:8899 etc, a week-1 convenience file for
// `q1`/`q2`) and `../lib/env.ts`'s `cfg()` reads `process.env[key] ??
// dotEnv[key] ?? profileDefault` — i.e. that .env file wins over the
// `devnet` profile's own defaults unless the same env vars are already set
// in `process.env` first. Since `import` statements are hoisted above any
// top-level code in the importing module, setting `process.env` here and
// then statically importing `./run.js` would run too late — so this file
// sets the overrides first and only then *dynamically* imports the real
// entrypoint (`run.ts`), which does the normal static `import ... from
// "../lib/env.js"` and everything else. Does not modify `.env` itself
// (shared by `q1`/`q2`, out of this task's write scope) or `lib/env.ts`.
if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

await import("./run.js");

export {};
