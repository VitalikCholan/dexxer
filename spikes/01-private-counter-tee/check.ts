// Check 1: private-counter on devnet-tee, non-member read denied.
// Adapted from spikes/.superpowers/sdd/2026-09-19-week0-spikes/task-3-brief.md
// against the real IDL in target/idl/private_counter.json (see RESULT.md for
// the list of deviations from the brief's illustrative script).
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import {
  getAuthToken,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, TEE_VALIDATOR, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/private_counter.json" with { type: "json" };

const user = loadKeypair("user");
const stranger = loadKeypair("stranger");

// Base provider (user pays)
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("counter"), user.publicKey.toBuffer()],
  program.programId,
);

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());

// Wrapper: keep preflight on by default; only on a genuine simulation failure
// retry once with skipPreflight: true, logging why (per MagicBlock's ER guidance
// that some ER-side transactions hit a known simulation incompatibility because
// local simulateTransaction can't see delegated/permissioned account state).
async function sendRpc(builder: any, label: string): Promise<string> {
  try {
    const sig = await builder.rpc();
    console.log(`${label} sig:`, sig);
    return sig;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const logs = e?.logs ?? e?.simulationResponse?.logs ?? null;
    console.log(`${label} DEVIATION: preflight simulation failed, retrying once with skipPreflight=true. Reason:`, msg);
    if (logs) console.log(`${label} preflight logs:`, logs);
    const sig = await builder.rpc({ skipPreflight: true });
    console.log(`${label} sig (skipPreflight retry):`, sig);
    // Fetch execution logs for the record.
    try {
      const tx = await (builder.provider as anchor.AnchorProvider).connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      console.log(`${label} execution logs:`, tx?.meta?.logMessages);
    } catch (logErr) {
      console.log(`${label} could not fetch execution logs:`, String(logErr));
    }
    return sig;
  }
}

// 1. initialize + delegate to TEE validator (base layer)
const info = await baseConn.getAccountInfo(counterPDA);
if (!info) {
  await sendRpc(program.methods.initialize().accounts({ authority: user.publicKey }), "initialize");
} else {
  console.log("initialize: counter already exists, skipping");
}
const infoAfterInit = info ?? (await baseConn.getAccountInfo(counterPDA));
if (!infoAfterInit || !infoAfterInit.owner.equals(DELEGATION_PROGRAM_ID)) {
  await sendRpc(
    program.methods.delegate().accountsPartial({
      authority: user.publicKey,
      counter: counterPDA,
      validator: TEE_VALIDATOR,
    }),
    "delegate",
  );
} else {
  console.log("delegate: counter already delegated, skipping");
}

// wait for router
let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await routerStatus(counterPDA);
}
assert(status.isDelegated, "router reports delegated");
assert(status.fqdn?.includes("tee"), `fqdn is TEE endpoint: ${status.fqdn}`);
console.log("router fqdn:", status.fqdn);

// 2. TEE token for user, ER provider
const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) =>
  Promise.resolve(nacl.sign.detached(m, user.secretKey)),
);
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, {
  wsEndpoint: `${TEE_WS}?token=${userToken.token}`,
  commitment: "confirmed",
});
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);
const permissionPDA = permissionPdaFromAccount(counterPDA);
const VAULT_ID = EPHEMERAL_VAULT_ID; // SDK export, matches ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID used by lib.rs and the example test's hardcoded VAULT_ID constant.

// 3. init permission + set private (ER)
// Client-side idempotency guard: init_permission is a program-level no-op once
// the permission account has lamports, but re-submitting it (and setPrivacy)
// against an already-private, already-incremented account hit a real ER-side
// error on a second cold run (see RESULT.md / task-3-report.md). Checking for
// the permission account first avoids resubmitting both instructions at all.
const permInfo = await teeConnUser.getAccountInfo(permissionPDA);
if (permInfo !== null) {
  console.log("permission exists — skipping init/setPrivacy");
} else {
  await sendRpc(
    erProgram.methods.initPermission().accountsPartial({
      authority: user.publicKey,
      counter: counterPDA,
      permission: permissionPDA,
      magicProgram: MAGIC_PROGRAM_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: VAULT_ID,
    }),
    "initPermission",
  );
  await sendRpc(
    erProgram.methods.setPrivacy(true).accountsPartial({
      authority: user.publicKey,
      counter: counterPDA,
      permission: permissionPDA,
      magicProgram: MAGIC_PROGRAM_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: VAULT_ID,
    }),
    "setPrivacy(true)",
  );
}
await sendRpc(erProgram.methods.increment().accounts({ counter: counterPDA }), "increment");

// 4. owner can read
const ownerView = await teeConnUser.getAccountInfo(counterPDA);
assert(ownerView !== null && ownerView.owner.equals(program.programId), "owner reads counter on TEE, owner = program");
console.log("owner view bytes:", ownerView?.data.length);

// 5. base layer shows delegated, bytes unchanged
const baseView = await baseConn.getAccountInfo(counterPDA);
assert(baseView !== null && baseView.owner.equals(DELEGATION_PROGRAM_ID), "base: owner is Delegation Program");
console.log("base view owner:", baseView?.owner.toBase58());

// 6. stranger with own token cannot read
const strangerToken = await getAuthToken(TEE_RPC, stranger.publicKey, (m: Uint8Array) =>
  Promise.resolve(nacl.sign.detached(m, stranger.secretKey)),
);
const teeConnStranger = new web3.Connection(`${TEE_RPC}?token=${strangerToken.token}`, "confirmed");
let strangerView: web3.AccountInfo<Buffer> | null = null;
let strangerErr = "";
try {
  strangerView = await teeConnStranger.getAccountInfo(counterPDA);
} catch (e) {
  strangerErr = String(e);
}
console.log("stranger view:", strangerView, "err:", strangerErr);
assert(strangerView === null || strangerErr !== "", "stranger (own token) cannot read private counter");

// 7. no token cannot read
const teeConnNoToken = new web3.Connection(TEE_RPC, "confirmed");
let noTokenView: web3.AccountInfo<Buffer> | null = null;
let noTokenErr = "";
try {
  noTokenView = await teeConnNoToken.getAccountInfo(counterPDA);
} catch (e) {
  noTokenErr = String(e);
}
console.log("no-token view:", noTokenView, "err:", noTokenErr);
assert(noTokenView === null || noTokenErr !== "", "no token cannot read private counter");

console.log("CHECK 1 PASS", { program: program.programId.toBase58(), counterPDA: counterPDA.toBase58() });
