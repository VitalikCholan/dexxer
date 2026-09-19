// Check 5: scheduler (crank) ticks inside devnet-tee.
// Adapted from spikes/.superpowers/sdd/2026-09-19-week0-spikes/task-8-brief.md
// against the real IDL in target/idl/anchor_counter.json (package/lib name is
// `crank_counter`, but the #[program] module is `anchor_counter`, so Anchor
// names the IDL/program after the module) and tests/crank-counter.ts from the
// vendored example. Deviations from the brief's illustrative script (see
// RESULT.md):
//  - counter PDA seed is just ["counter"] (single global counter), not
//    ["counter", user] — confirmed in programs/crank-counter/src/lib.rs.
//  - initialize() takes account `user`, not `payer`.
//  - delegate() takes accounts `{ payer, pda: counterPDA }` (not `del`/`counter`),
//    validator passed via remainingAccounts.
//  - scheduleIncrement() accounts are `{ magicProgram, payer, program }` only —
//    `counter` is a PDA-seeded account Anchor's client resolves automatically,
//    passing it explicitly is unnecessary (and was dropped to match the
//    example test exactly).
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken, MAGIC_PROGRAM_ID, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, TEE_VALIDATOR, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/anchor_counter.json" with { type: "json" };

const user = loadKeypair("user");

const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter")], program.programId);

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());

// Wrapper matching task 3's pattern: keep preflight on by default; retry once
// with skipPreflight on a genuine simulation failure and log why.
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
  await sendRpc(program.methods.initialize().accounts({ user: user.publicKey }), "initialize");
} else {
  console.log("initialize: counter already exists, skipping");
}

const infoAfterInit = info ?? (await baseConn.getAccountInfo(counterPDA));
if (!infoAfterInit || !infoAfterInit.owner.equals(DELEGATION_PROGRAM_ID)) {
  await sendRpc(
    program.methods
      .delegate()
      .accounts({ payer: user.publicKey, pda: counterPDA })
      .remainingAccounts([{ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false }]),
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
const teeConn = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, {
  wsEndpoint: `${TEE_WS}?token=${userToken.token}`,
  commitment: "confirmed",
});
const erProvider = new anchor.AnchorProvider(teeConn, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

// 3. schedule the increment crank: 1000 ms cadence, 30 iterations (>20s of headroom)
const taskId = new anchor.BN(Date.now()); // collision-resistant enough for a spike
await sendRpc(
  erProgram.methods
    .scheduleIncrement({
      taskId,
      executionIntervalMillis: new anchor.BN(1000),
      iterations: new anchor.BN(30),
    })
    .accounts({
      magicProgram: MAGIC_PROGRAM_ID,
      payer: user.publicKey,
      program: program.programId,
    }),
  "scheduleIncrement",
);

// 4. sample the counter every 1s for 20s
const c0 = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
console.log("c0 (count at schedule time):", c0);
const samples: number[] = [];
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const c = (await erProgram.account.counter.fetch(counterPDA)).count.toNumber();
  samples.push(c);
  console.log(`t+${i + 1}s:`, c);
}
console.log({ c0, samples });
const ticks = samples[samples.length - 1] - c0;
console.log("ticks observed in 20s:", ticks);
assert(ticks >= 12, `>=12 ticks in 20s at 1000ms interval (got ${ticks})`);
console.log("CHECK 5 PASS", { program: program.programId.toBase58(), counterPDA: counterPDA.toBase58(), ticks });
