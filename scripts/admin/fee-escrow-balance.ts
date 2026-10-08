// scripts/admin/fee-escrow-balance.ts
//
// Read-only: how much is left in the `FeeEscrow` PDA inside the TEE rollup,
// and how long it lasts. `FeeEscrow` pays 200 000 lamports for every
// `commit_aggregate` (docs/deployments.md) and the scheduler task of every
// `open_position`; an empty one stops both. Its base-layer account is only a
// delegation stub, so the real balance is read in the rollup.
//
// Signs nothing on-chain: the TEE auth token comes from a throwaway keypair
// (`FeeEscrow` is delegated without a permission, so any token reads it), so
// no project key is needed. To top up, run fund-fee-payer.ts (admin key).
//
// Run:
//   cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/fee-escrow-balance.ts
// `COMMIT_INTERVAL_MS` (default 300000, as on the relayer) sets the estimate.

import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

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
const { NET, baseConn, teeConn } = await import("../../tests/er/lib/env.js");
const { pdas } = await import("../../tests/er/lib/program.js");
const { DELEGATION_PROGRAM_ID } = await import("@magicblock-labs/ephemeral-rollups-sdk");

if (NET !== "devnet") {
  console.error(`FAIL: DEXXER_NET must be "devnet" (got "${NET}").`);
  process.exit(1);
}

const COMMIT_COST_LAMPORTS = 200_000;
const commitIntervalMs = Number(process.env.COMMIT_INTERVAL_MS ?? 300_000);

async function main(): Promise<void> {
  const feeEscrow = pdas.feeEscrow();
  console.log("fee-escrow", feeEscrow.toBase58());

  const base = await baseConn.getAccountInfo(feeEscrow, "confirmed");
  const delegated = base?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
  console.log("delegated on L1", delegated, base ? `(owner ${base.owner.toBase58()})` : "(no account)");
  if (!delegated) process.exit(1);

  const rollup = await teeConn(Keypair.generate());
  const info = await rollup.getAccountInfo(feeEscrow, "confirmed");
  const lamports = info?.lamports ?? 0;
  // The account must stay rent-exempt: only what is above that minimum can pay for anything.
  const rentMin = await baseConn.getMinimumBalanceForRentExemption(info?.data.length ?? 0);
  const spendable = Math.max(0, lamports - rentMin);
  const commits = Math.floor(spendable / COMMIT_COST_LAMPORTS);
  const hours = (commits * commitIntervalMs) / 3_600_000;
  console.log("balance in rollup", lamports, "lamports", `(${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log("rent-exempt minimum", rentMin, `(${info?.data.length ?? 0} B), spendable`, spendable);
  console.log(
    `≈ ${commits} commits ≈ ${hours.toFixed(1)} h at COMMIT_INTERVAL_MS=${commitIntervalMs}`,
    "(not counting liquidation tasks of new positions)",
  );
  if (commits === 0) {
    console.log("EMPTY: commits and open_position stop — top up with fund-fee-payer.ts");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("fee-escrow-balance FAIL", e);
  process.exit(1);
});
