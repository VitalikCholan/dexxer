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

import { NET } from "../../tests/er/lib/env.js";
import { bootstrapDevnet } from "../../tests/er/lib/admin.js";

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
      feed: b.feed.toBase58(),
      sigs: b.sigs,
    });
  })
  .catch((e) => {
    console.error("devnet-bootstrap FAIL", e);
    process.exit(1);
  });
