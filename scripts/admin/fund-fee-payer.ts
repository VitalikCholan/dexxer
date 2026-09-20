// scripts/admin/fund-fee-payer.ts
//
// Task 5 fix round 1 (controller ruling): top up the `FeeEscrow` PDA's
// lamport balance inside the TEE rollup, via the Ephemeral SPL Token
// program's sponsored "delegated transfer" (`lamportsDelegatedTransferIx` —
// see the `magicblock` skill's `references/lamports-topup.md`).
//
// Renamed in intent (kept the filename for npm-script/doc continuity):
// originally this topped up `devnet-fee-payer` (the plain wallet that signs
// `commit_aggregate`'s outer transaction) directly — but `lamportsDelegatedTransferIx`
// requires its `destination` to already be a *delegated* base-layer account
// ("Destination must already be delegated" in lamports-topup.md), and a
// plain wallet can never satisfy that (confirmed on-chain: Task 5's first
// attempt failed with `InvalidAccountOwner`, see task-5-report.md). The fix
// round gave `commit_aggregate` a dedicated delegated PDA — `FeeEscrow`
// (programs/dexxer_core/src/instructions/admin.rs's `init_fee_escrow`/
// `delegate_fee_escrow`) — as its actual CPI intent payer; `devnet-fee-payer`
// remains only the transaction's signer/authorizer (`Config.fee_payer`,
// checked by `CommitAggregate.payer`'s constraint) and needs no ER-vault
// balance of its own (only ordinary base SOL for its own tx fees, already
// funded in Task 5's bootstrap). This script now tops up `FeeEscrow`
// instead, which — once `bootstrapDevnet()`'s `initAndDelegateFeeEscrow` has
// run — is a genuinely delegated account and satisfies the precondition.
//
// Run (see devnet-bootstrap.ts for the same DEXXER_NET requirement, and run
// devnet-bootstrap.ts first so `FeeEscrow` exists and is delegated):
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/fund-fee-payer.ts

import { randomBytes } from "node:crypto";
import { LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";

// Same `.env`-shadows-`devnet`-profile issue as devnet-bootstrap.ts (see its
// header comment) — force the devnet endpoints into `process.env` before the
// dynamic import below.
if ((process.env.DEXXER_NET ?? "local") === "devnet") {
  process.env.BASE_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ER_RPC ??= "https://devnet-tee.magicblock.app";
  process.env.ER_WS ??= "wss://devnet-tee.magicblock.app";
  process.env.PUBLIC_RPC ??= "https://rpc.magicblock.app/devnet";
  process.env.ROUTER_RPC ??= "https://devnet-router.magicblock.app/";
  process.env.ER_VALIDATOR ??= "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
}
const { NET, baseConn, loadOrCreateKey, teeConn } = await import("../../tests/er/lib/env.js");
const { pdas } = await import("../../tests/er/lib/program.js");
const { DELEGATION_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");

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
  const feeEscrow = pdas.feeEscrow();
  console.log("admin (payer)", admin.publicKey.toBase58());
  console.log("fee-escrow (destination)", feeEscrow.toBase58());

  const escrowInfo = await baseConn.getAccountInfo(feeEscrow, "confirmed");
  if (!escrowInfo || !escrowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.error(
      `FAIL: fee-escrow (${feeEscrow.toBase58()}) is not delegated (owner=${escrowInfo?.owner.toBase58() ?? "null"}). ` +
        "Run devnet-bootstrap.ts first (it creates + delegates FeeEscrow via initAndDelegateFeeEscrow).",
    );
    process.exit(1);
  }

  const amount = BigInt(Math.round(TOPUP_SOL * LAMPORTS_PER_SOL));
  // Fresh salt per logical top-up request (lamports-topup.md): reusing a
  // (payer, destination, salt) triple resolves to the same one-shot PDA and
  // fails if it's still live from a prior attempt.
  const salt = randomBytes(32);

  const ix = lamportsDelegatedTransferIx(admin.publicKey, feeEscrow, amount, salt);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(baseConn, tx, [admin], { commitment: "confirmed" });
  console.log("lamportsDelegatedTransferIx", sig, "amount", amount.toString(), "lamports, salt", Buffer.from(salt).toString("hex"));

  const rollup = await teeConn(admin);
  const bal = await rollup.getBalance(feeEscrow, "confirmed");
  console.log("fee-escrow balance in rollup", bal, "lamports");
  if (bal < Number(amount)) {
    console.error(`FAIL: expected fee-escrow rollup balance >= ${amount} lamports, got ${bal}`);
    process.exit(1);
  }
  console.log("ok: fee-escrow funded in rollup");
}

main().catch((e) => {
  console.error("fund-fee-payer FAIL", e);
  process.exit(1);
});
