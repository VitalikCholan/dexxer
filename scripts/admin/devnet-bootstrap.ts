// scripts/admin/devnet-bootstrap.ts
//
// Task 0 (week 2): devnet bootstrap entry point — creates Config/Market/Pool
// on real devnet and delegates them to devnet-tee.magicblock.app, the same
// way `npm run q1` bootstraps the local mb-stack (see
// `tests/er/lib/admin.ts`'s `bootstrapDevnet()`).
//
// Run (requires DEXXER_NET=devnet so `tests/er/lib/env.ts` picks the devnet
// profile — this script only asserts it, it does not set it, matching the
// task-0 brief's Step 5 invocation):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/devnet-bootstrap.ts
//
// NOT run by Task 0 itself: the devnet payer is unfunded (2.18 SOL, needs
// ~6) and `dexxer_core` is not yet deployed to devnet, so every on-chain
// call here would fail. Also, a later task changes `Config`'s account
// layout, so a `Config` PDA created now (fixed seeds, no close/realloc
// instruction) would be unusable. Running this for real is Task 5's job —
// see `.superpowers/sdd/2026-09-20-week2-privacy-devnet/task-0-brief.md`.
// This file is a code deliverable, checked with `tsc --noEmit` only.
//
// Task 5 fix: `tests/er/.env` hardcodes local mb-stack endpoints
// (BASE_RPC=http://127.0.0.1:8899 etc — a week-1 convenience file for
// `q1`/`q2`) and `lib/env.ts`'s `cfg()` reads `process.env[key] ??
// dotEnv[key] ?? profileDefault`, i.e. that `.env` wins over the `devnet`
// profile's own defaults unless the same env vars are already set in
// `process.env` first. This script originally only asserted `NET ===
// "devnet"` and let `bootstrapDevnet()`'s static imports resolve `baseConn`
// against `.env`'s local address — `requireFunded` then failed with a
// generic `fetch failed` (connection refused against a mb-stack that wasn't
// running). Fixed the same way `tests/er/devnet/00-measure.ts` does: force
// the devnet profile's endpoints into `process.env` *before* the dynamic
// `import("../../tests/er/lib/admin.js")` below (static imports are hoisted
// above top-level code, so setting `process.env` before a static import
// would run too late).
export {}; // module marker: top-level await below requires this file to be a module

if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}

const { NET } = await import("../../tests/er/lib/env.js");
const { bootstrapDevnet } = await import("../../tests/er/lib/admin.js");

if (NET !== "devnet") {
  console.error(
    `FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). ` +
      "Run: DEXXER_NET=devnet npx tsx scripts/admin/devnet-bootstrap.ts",
  );
  process.exit(1);
}

bootstrapDevnet()
  .then((b) => {
    console.log("devnet bootstrap complete", {
      admin: b.admin.publicKey.toBase58(),
      feePayer: b.feePayer.publicKey.toBase58(),
      mint: b.mint.toBase58(),
      market: b.market.toBase58(),
      marketRisk: b.marketRisk.toBase58(),
      pool: b.pool.toBase58(),
      poolAta: b.poolAta.toBase58(),
      poolLive: b.poolLive.toBase58(),
      feed: b.feed.toBase58(),
      feeEscrow: b.feeEscrow.toBase58(),
      balancesRoot: b.balancesRoot.toBase58(),
      sigs: b.sigs,
    });
  })
  .catch((e) => {
    console.error("devnet-bootstrap FAIL", e);
    process.exit(1);
  });
