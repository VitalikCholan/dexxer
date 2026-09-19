// Check 3: does an ER instruction see a non-delegated L1 account as a
// read-only clone, and does that clone refresh after the L1 value changes?
// Setup (steps 1-3) is copied from spikes/01-private-counter-tee/check.ts
// (initialize, delegate to TEE_VALIDATOR, initPermission, setPrivacy(true)),
// program renamed l1_readonly. See spikes/03-l1-readonly-clone/RESULT.md for
// the recorded outcome and any deviations from the brief's illustrative script.
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
import idl from "./target/idl/l1_readonly.json" with { type: "json" };

const user = loadKeypair("user");

// Base provider (user pays)
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("counter"), user.publicKey.toBuffer()],
  program.programId,
);
const [configPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());
console.log("configPDA:", configPDA.toBase58());

// Wrapper: keep preflight on by default; only on a genuine simulation failure
// retry once with skipPreflight: true, logging why (mirrors 01/check.ts).
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
const VAULT_ID = EPHEMERAL_VAULT_ID;

// 3. init permission + set private (ER) — guarded so the script is re-runnable
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

// 4. Config on L1 (never delegated) — init once with step=5.
const configInfo = await baseConn.getAccountInfo(configPDA);
if (!configInfo) {
  await sendRpc(
    program.methods.initConfig(new anchor.BN(5)).accounts({ authority: user.publicKey }),
    "initConfig",
  );
} else {
  console.log("initConfig: config already exists, skipping");
}

// --- Check 3 ---
// First ER read of the non-delegated L1 Config account.
const before = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
let after1FailedError = "";
let after1: number | null = null;
try {
  await sendRpc(
    erProgram.methods.incrementByConfig().accounts({ counter: counterPDA, config: configPDA }),
    "incrementByConfig (1st)",
  );
  after1 = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
} catch (e) {
  after1FailedError = String((e as any)?.message ?? e);
  console.log("incrementByConfig (1st) FAILED:", after1FailedError);
}

if (after1 === null) {
  console.log({ before, after1: null, after1FailedError });
  console.log("CHECK 3 RESULT: NO CLONE — ER did not clone the non-delegated L1 Config account (first read failed).");
  process.exit(0);
}

assert(after1 === before + 5, "ER read config.step=5 from non-delegated L1 account");

// Change Config.step on L1, expect ER to see the fresh value on next call.
await sendRpc(program.methods.setStep(new anchor.BN(7)).accounts({ authority: user.publicKey }), "setStep(7)");
await new Promise((r) => setTimeout(r, 3000));

await sendRpc(
  erProgram.methods.incrementByConfig().accounts({ counter: counterPDA, config: configPDA }),
  "incrementByConfig (2nd)",
);
const after2 = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();

console.log({ before, after1, after2 });

if (after2 === after1 + 7) {
  console.log("CHECK 3 PASS — fresh clone: ER re-read the updated L1 Config value without re-delegation.");
} else if (after2 === after1 + 5) {
  console.log("CHECK 3 RESULT: STALE CLONE — ER cloned Config once and cached the old value (step=5); the L1 update to step=7 was not observed.");
} else {
  console.log(`CHECK 3 RESULT: UNEXPECTED — after2 (${after2}) is neither after1+7 (${after1 + 7}, fresh) nor after1+5 (${after1 + 5}, stale).`);
}
