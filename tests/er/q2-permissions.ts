// tests/er/q2-permissions.ts
//
// Spec §8 Q2: proves that `init_permissions` creates three
// `EphemeralPermission` accounts (for UserAccount, Position, DisclosureQueue)
// in a single ER transaction, and that calling it again is a no-op (the
// program checks `perm.lamports() > 0` and skips the CPI per account).
//
// Assumes Q1 has already run for the same user (same persisted `.keys/`),
// i.e. UserAccount/Position/DisclosureQueue are delegated to the ER.
//
// Run: `npm run q1 && npm run q2` (from tests/er).

import { EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert, baseConn, erConn, loadOrCreateKey, waitDelegated } from "./lib/env.js";
import { dexxerCoreProgram, pdas } from "./lib/program.js";

async function permissionAccountsExist(label: string) {
  const user = loadOrCreateKey("user");
  const market = pdas.market();
  const userAccount = pdas.userAccount(user.publicKey);
  const position = pdas.position(user.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(user.publicKey);

  const userPermission = permissionPdaFromAccount(userAccount);
  const positionPermission = permissionPdaFromAccount(position);
  const dqPermission = permissionPdaFromAccount(disclosureQueue);

  for (const [name, pk] of [
    ["userPermission", userPermission],
    ["positionPermission", positionPermission],
    ["dqPermission", dqPermission],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    assert(info !== null, `${label}: ${name} (${pk.toBase58()}) exists on ER`);
    assert(info!.owner.equals(PERMISSION_PROGRAM_ID), `${label}: ${name} owner == PERMISSION_PROGRAM_ID`);
  }
  return { userAccount, position, disclosureQueue, userPermission, positionPermission, dqPermission };
}

async function main() {
  const user = loadOrCreateKey("user");
  const market = pdas.market();
  const userAccount = pdas.userAccount(user.publicKey);
  const position = pdas.position(user.publicKey, market);
  const disclosureQueue = pdas.disclosureQueue(user.publicKey);

  // Preconditions: the three PDAs must already be delegated (Q1 does this).
  await waitDelegated(baseConn, userAccount, "UserAccount", 5, 500);
  await waitDelegated(baseConn, position, "Position", 5, 500);
  await waitDelegated(baseConn, disclosureQueue, "DisclosureQueue", 5, 500);

  const userPermission = permissionPdaFromAccount(userAccount);
  const positionPermission = permissionPdaFromAccount(position);
  const dqPermission = permissionPdaFromAccount(disclosureQueue);

  const lamportsBefore: Record<string, number> = {};
  for (const [name, pk] of [
    ["userAccount", userAccount],
    ["position", position],
    ["disclosureQueue", disclosureQueue],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    assert(info !== null, `${name} exists on ER before init_permissions`);
    lamportsBefore[name] = info!.lamports;
  }

  console.log("=== init_permissions (ER, first call — creates 3 permissions) ===");
  const coreEr = dexxerCoreProgram(erConn, user);
  const sig1 = await coreEr.methods
    .initPermissions()
    .accounts({
      owner: user.publicKey,
      market,
      userAccount,
      position,
      disclosureQueue,
      userPermission,
      positionPermission,
      dqPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .rpc();
  console.log("init_permissions (1st)", sig1);

  const tx1 = await erConn.getTransaction(sig1, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const cu1 = tx1?.meta?.computeUnitsConsumed ?? null;

  const after1 = await permissionAccountsExist("after 1st call");

  const lamportsAfter1: Record<string, number> = {};
  for (const [name, pk] of [
    ["userAccount", userAccount],
    ["position", position],
    ["disclosureQueue", disclosureQueue],
  ] as const) {
    const info = await erConn.getAccountInfo(pk, "confirmed");
    lamportsAfter1[name] = info!.lamports;
    const delta = lamportsBefore[name] - lamportsAfter1[name];
    assert(delta > 0, `${name} lamports decreased after init_permissions (before ${lamportsBefore[name]}, after ${lamportsAfter1[name]}, delta ${delta})`);
    console.log(`  ${name} lamports: ${lamportsBefore[name]} -> ${lamportsAfter1[name]} (paid ${delta} for its own EphemeralPermission)`);
  }

  console.log("=== init_permissions (ER, second call — idempotent, no-op) ===");
  const sig2 = await coreEr.methods
    .initPermissions()
    .accounts({
      owner: user.publicKey,
      market,
      userAccount,
      position,
      disclosureQueue,
      userPermission,
      positionPermission,
      dqPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .rpc();
  console.log("init_permissions (2nd, idempotent)", sig2);

  await permissionAccountsExist("after 2nd call");

  for (const [name, pk] of [
    ["userAccount", userAccount],
    ["position", position],
    ["disclosureQueue", disclosureQueue],
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
    position: position.toBase58(),
    disclosureQueue: disclosureQueue.toBase58(),
    userPermission: after1.userPermission.toBase58(),
    positionPermission: after1.positionPermission.toBase58(),
    dqPermission: after1.dqPermission.toBase58(),
    sig1,
    cu1,
    sig2,
    message: `3 permissions in 1 tx, CU=${cu1}`,
  });
}

main().catch((e) => {
  console.error("Q2 FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  process.exit(1);
});
