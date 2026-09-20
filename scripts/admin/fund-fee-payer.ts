// scripts/admin/fund-fee-payer.ts
//
// Task 0 (week 2): top up the devnet fee-payer's lamport balance inside the
// TEE rollup, via the Ephemeral SPL Token program's sponsored "delegated
// transfer" (`lamportsDelegatedTransferIx` — see the `magicblock` skill's
// `references/lamports-topup.md`, and week-2 plan decision #4: a dedicated
// `fee-payer` keypair, not `crank`, pays for `commit_aggregate`'s
// fee-vault-scoped commits after the free 25).
//
// Run (see devnet-bootstrap.ts for the same DEXXER_NET requirement):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/fund-fee-payer.ts
//
// NOT run by Task 0 itself — same reasons as devnet-bootstrap.ts (unfunded
// payer, no deploy yet), PLUS a precondition this script cannot satisfy on
// its own: `lamportsDelegatedTransferIx` requires `destination` (the fee
// payer) to already be a *delegated* base-layer account — "Destination must
// already be delegated" in lamports-topup.md. Nothing in Task 0 delegates
// the fee-payer's own system account (that wiring — likely alongside
// `Config.fee_payer` — is a later task's job); running this before that
// exists will fail on-chain with a clear error. This file is a code
// deliverable, checked with `tsc --noEmit` only.

import { randomBytes } from "node:crypto";
import { LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";

// Task 5 fix: same `.env`-shadows-`devnet`-profile issue as
// devnet-bootstrap.ts (see its header comment) — force the devnet
// endpoints into `process.env` before the dynamic import below.
if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}
const { NET, baseConn, loadOrCreateKey, teeConn } = await import("../../tests/er/lib/env.js");

if (NET !== "devnet") {
  console.error(
    `FAIL: DEXXER_NET must be "devnet" to run this script (got "${NET}"). ` +
      "Run: DEXXER_NET=devnet npx tsx scripts/admin/fund-fee-payer.ts",
  );
  process.exit(1);
}

const TOPUP_SOL = 0.2;

async function main(): Promise<void> {
  const admin = loadOrCreateKey("devnet-admin");
  const feePayer = loadOrCreateKey("devnet-fee-payer");
  console.log("admin (payer)", admin.publicKey.toBase58());
  console.log("fee-payer (destination)", feePayer.publicKey.toBase58());

  const amount = BigInt(Math.round(TOPUP_SOL * LAMPORTS_PER_SOL));
  // Fresh salt per logical top-up request (lamports-topup.md): reusing a
  // (payer, destination, salt) triple resolves to the same one-shot PDA and
  // fails if it's still live from a prior attempt.
  const salt = randomBytes(32);

  const ix = lamportsDelegatedTransferIx(admin.publicKey, feePayer.publicKey, amount, salt);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(baseConn, tx, [admin], { commitment: "confirmed" });
  console.log("lamportsDelegatedTransferIx", sig, "amount", amount.toString(), "lamports, salt", Buffer.from(salt).toString("hex"));

  const rollup = await teeConn(feePayer);
  const bal = await rollup.getBalance(feePayer.publicKey, "confirmed");
  console.log("fee-payer balance in rollup", bal, "lamports");
  if (bal < Number(amount)) {
    console.error(`FAIL: expected fee-payer rollup balance >= ${amount} lamports, got ${bal}`);
    process.exit(1);
  }
  console.log("ok: fee-payer funded in rollup");
}

main().catch((e) => {
  console.error("fund-fee-payer FAIL", e);
  process.exit(1);
});
