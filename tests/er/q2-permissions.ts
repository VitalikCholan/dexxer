// tests/er/q2-permissions.ts
//
// Spec §8 Q2: proves that `init_permissions` creates two
// `EphemeralPermission` accounts (for UserAccount and Positions — spec §2.9)
// in a single ER transaction, and that calling it again is a no-op (the
// program checks `perm.lamports() > 0` and skips the CPI per account).
//
// Assumes Q1 has already run for the same user (same persisted `.keys/`),
// i.e. UserAccount/Positions are delegated to the ER.
//
// Run: `npm run q1 && npm run q2` (from tests/er).

import { PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert, baseConn, erConn, loadOrCreateKey, waitDelegated } from "./lib/env.js";
import { pdas } from "./lib/program.js";
import { initPermissions, permissionAccounts } from "./lib/trader.js";

async function permissionAccountsExist(label: string) {
  const user = loadOrCreateKey("user");
  const { userAccount, positions, userPermission, positionsPermission } = permissionAccounts(user.publicKey);

  for (const [name, pk] of [
    ["userPermission", userPermission],
    ["positionsPermission", positionsPermission],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    assert(info !== null, `${label}: ${name} (${pk.toBase58()}) exists on ER`);
    assert(info!.owner.equals(PERMISSION_PROGRAM_ID), `${label}: ${name} owner == PERMISSION_PROGRAM_ID`);
  }
  return { userAccount, positions, userPermission, positionsPermission };
}

async function main() {
  const user = loadOrCreateKey("user");
  const userAccount = pdas.userAccount(user.publicKey);
  const positions = pdas.positions(user.publicKey);

  // Preconditions: both PDAs must already be delegated (Q1 does this).
  await waitDelegated(baseConn, userAccount, "UserAccount", 5, 500);
  await waitDelegated(baseConn, positions, "Positions", 5, 500);

  const lamportsBefore: Record<string, number> = {};
  for (const [name, pk] of [
    ["userAccount", userAccount],
    ["positions", positions],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    assert(info !== null, `${name} exists on ER before init_permissions`);
    lamportsBefore[name] = info!.lamports;
  }

  console.log("=== init_permissions (ER, first call — creates 2 permissions) ===");
  const sig1 = await initPermissions({ kp: user });
  console.log("init_permissions (1st)", sig1);

  const tx1 = await erConn.getTransaction(sig1, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const cu1 = tx1?.meta?.computeUnitsConsumed ?? null;

  const after1 = await permissionAccountsExist("after 1st call");

  const lamportsAfter1: Record<string, number> = {};
  for (const [name, pk] of [
    ["userAccount", userAccount],
    ["positions", positions],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    lamportsAfter1[name] = info!.lamports;
    const delta = lamportsBefore[name] - lamportsAfter1[name];
    // 4096 = measured rent for a public/0-member EphemeralPermission (this
    // week's `EphemeralMembersArgs { is_private: false, members: vec![] }`).
    // Task 2's Q3 estimate (7264 lamports, `size_of(3)`) assumed the future
    // 3-member private version — Task 15 should update that estimate.
    const EXPECTED_PERMISSION_RENT = 4096;
    assert(
      delta === EXPECTED_PERMISSION_RENT,
      `${name} lamports decreased by exactly ${EXPECTED_PERMISSION_RENT} after init_permissions (before ${lamportsBefore[name]}, after ${lamportsAfter1[name]}, delta ${delta})`,
    );
    console.log(`  ${name} lamports: ${lamportsBefore[name]} -> ${lamportsAfter1[name]} (paid ${delta} for its own EphemeralPermission)`);
  }

  console.log("=== init_permissions (ER, second call — idempotent, no-op) ===");
  const sig2 = await initPermissions({ kp: user });
  console.log("init_permissions (2nd, idempotent)", sig2);

  await permissionAccountsExist("after 2nd call");

  for (const [name, pk] of [
    ["userAccount", userAccount],
    ["positions", positions],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    assert(
      info!.lamports === lamportsAfter1[name],
      `${name} lamports unchanged by the 2nd (idempotent) call (${lamportsAfter1[name]} == ${info!.lamports})`,
    );
  }

  console.log("\nQ2 PASS", {
    user: user.publicKey.toBase58(),
    userAccount: userAccount.toBase58(),
    positions: positions.toBase58(),
    userPermission: after1.userPermission.toBase58(),
    positionsPermission: after1.positionsPermission.toBase58(),
    sig1,
    cu1,
    sig2,
    message: `2 permissions in 1 tx, CU=${cu1}`,
  });
}

main().catch((e) => {
  console.error("Q2 FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
