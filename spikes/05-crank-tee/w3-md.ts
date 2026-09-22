// Week-3 M-D: scheduler limits (tech debt #18).
//  (1) iterations = i64::MAX — accepted? does it tick for >=60s?
//  (2) iterations = 0 and -1 — accepted or rejected?
//  (3) persistence across a devnet-tee restart — not measurable in this
//      single-session run (see note below); recorded, not guessed.
//  (4) self-reschedule from inside a scheduled tick, payer = the tick's own
//      Signer<'info> account — does ScheduleCrankCpi's own signature
//      requirement hold up inside a scheduled (crank-executed) invocation?
//
// Run order matters: (2) and (4) run FIRST, while the shared counter's tick
// history is still attributable to a single test each. (1) schedules an
// effectively-infinite task (iterations = i64::MAX) and is run LAST, since
// once it starts the counter ticks forever (until this program is closed
// right after this script, per the task's SOL-refund step) and would
// otherwise contaminate every measurement that runs after it.
//
// Fresh program+counter this task (`anchor keys sync` new id, see
// w3-md-report notes) — no residual state from week 2's now-closed program.
//
// Run (from spikes/): `npx tsx 05-crank-tee/w3-md.ts`
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

async function sendRpc(builder: any, label: string): Promise<{ sig?: string; error?: string; logs?: string[] }> {
  try {
    const sig = await builder.rpc();
    console.log(`${label} sig:`, sig);
    return { sig };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    const logs = e?.logs ?? e?.simulationResponse?.logs;
    console.log(`${label} FAILED:`, error);
    if (logs) console.log(`${label} logs:`, logs);
    return { error, logs };
  }
}

// 1. initialize + delegate (fresh counter, fresh program)
const info = await baseConn.getAccountInfo(counterPDA);
if (!info) {
  await sendRpc(program.methods.initialize().accounts({ user: user.publicKey }), "initialize");
} else {
  console.log("initialize: counter already exists, skipping");
}
const infoAfterInit = info ?? (await baseConn.getAccountInfo(counterPDA));
if (!infoAfterInit || !infoAfterInit.owner.equals(DELEGATION_PROGRAM_ID)) {
  await sendRpc(
    program.methods.delegate().accounts({ payer: user.publicKey, pda: counterPDA }).remainingAccounts([{ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false }]),
    "delegate",
  );
} else {
  console.log("delegate: counter already delegated, skipping");
}

let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await routerStatus(counterPDA);
}
assert(status.isDelegated, "router reports delegated");
assert(status.fqdn?.includes("tee"), `fqdn is TEE endpoint: ${status.fqdn}`);
console.log("router fqdn:", status.fqdn);

const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)));
const teeConn = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, { wsEndpoint: `${TEE_WS}?token=${userToken.token}`, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(teeConn, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

async function getCount(): Promise<number> {
  return (await erProgram.account.counter.fetch(counterPDA) as any).count.toNumber();
}

const baseTaskId = Date.now();
const results: Record<string, unknown> = {};

// ===== M-D(2): iterations = 0 =====
console.log("\n=== M-D(2a): iterations = 0 ===");
const c0a = await getCount();
const r0 = await sendRpc(
  erProgram.methods
    .scheduleIncrement({ taskId: new anchor.BN(baseTaskId), executionIntervalMillis: new anchor.BN(1000), iterations: new anchor.BN(0) })
    .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: user.publicKey, program: program.programId }),
  "schedule(iterations=0)",
);
await new Promise((r) => setTimeout(r, 8000));
const c0b = await getCount();
console.log(`iterations=0: count ${c0a} -> ${c0b} (delta ${c0b - c0a}) after 8s`);
results["iterations=0"] = { accepted: !!r0.sig, sig: r0.sig, error: r0.error, countBefore: c0a, countAfter8s: c0b, delta: c0b - c0a };

// ===== M-D(2): iterations = -1 =====
console.log("\n=== M-D(2b): iterations = -1 ===");
const cNa = await getCount();
const rNeg = await sendRpc(
  erProgram.methods
    .scheduleIncrement({ taskId: new anchor.BN(baseTaskId + 1), executionIntervalMillis: new anchor.BN(1000), iterations: new anchor.BN(-1) })
    .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: user.publicKey, program: program.programId }),
  "schedule(iterations=-1)",
);
await new Promise((r) => setTimeout(r, 8000));
const cNb = await getCount();
console.log(`iterations=-1: count ${cNa} -> ${cNb} (delta ${cNb - cNa}) after 8s`);
results["iterations=-1"] = { accepted: !!rNeg.sig, sig: rNeg.sig, error: rNeg.error, countBefore: cNa, countAfter8s: cNb, delta: cNb - cNa };

// ===== M-D(3): persistence across restart — not measurable this session =====
console.log("\n=== M-D(3): persistence across restart ===");
console.log("не виміряно — сесія однопрохідна, вікна рестарту devnet-tee нема; спайк закривається в кінці");
console.log("цієї ж задачі (SOL refund), тому навіть відкладена перевірка неможлива для ЦЬОГО програмного id.");
results["persistence"] = { measured: false, reason: "no restart window in this session; program closes at end of this task" };

// ===== M-D(4): self-reschedule from inside a scheduled tick =====
console.log("\n=== M-D(4): self-reschedule (tick_and_reschedule) ===");
const taskIdReschedule = baseTaskId + 2;
const startSlot4 = await baseConn.getSlot("confirmed");
const c4a = await getCount();
const r4 = await sendRpc(
  erProgram.methods
    .scheduleTickAndReschedule({ taskId: new anchor.BN(taskIdReschedule), executionIntervalMillis: new anchor.BN(1000), iterations: new anchor.BN(2) })
    .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: user.publicKey, counter: counterPDA }),
  "scheduleTickAndReschedule",
);
await new Promise((r) => setTimeout(r, 10000));
const c4b = await getCount();
console.log(`tick_and_reschedule: count ${c4a} -> ${c4b} (delta ${c4b - c4a}) after 10s`);

// Inspect base-layer signatures on the program id since scheduling for any
// TickAndReschedule invocation logs (accept/reject of the self-reschedule CPI).
const sigs4 = await baseConn.getSignaturesForAddress(program.programId, { limit: 20 }, "confirmed");
const relevant4 = sigs4.filter((s) => s.slot >= startSlot4);
console.log(`M-D(4): ${relevant4.length} base-layer program-id txs since scheduling`);
const tickLogs: { sig: string; hasTick: boolean; hasScheduleCpi: boolean; err: unknown; logs: string[] | null }[] = [];
for (const s of relevant4) {
  const tx = await baseConn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const logs = tx?.meta?.logMessages ?? null;
  const hasTick = !!logs?.some((l) => l.includes("Instruction: TickAndReschedule"));
  const hasScheduleCpi = !!logs?.some((l) => l.includes("DELeGG") || l.toLowerCase().includes("schedule"));
  tickLogs.push({ sig: s.signature, hasTick, hasScheduleCpi, err: s.err, logs });
  console.log(`  ${s.signature}: err=${JSON.stringify(s.err)} hasTick=${hasTick}`);
  if (logs) console.log(`    logs:`, logs);
}
results["self_reschedule"] = {
  accepted_outer_schedule: !!r4.sig,
  outerSig: r4.sig,
  outerError: r4.error,
  countBefore: c4a,
  countAfter10s: c4b,
  delta: c4b - c4a,
  baseTxsObserved: tickLogs.map(({ sig, hasTick, hasScheduleCpi, err }) => ({ sig, hasTick, hasScheduleCpi, err })),
};

// ===== M-D(1): iterations = i64::MAX — run LAST (effectively infinite) =====
console.log("\n=== M-D(1): iterations = i64::MAX ===");
const I64_MAX = "9223372036854775807";
const taskIdMax = baseTaskId + 10;
const c1a = await getCount();
const r1 = await sendRpc(
  erProgram.methods
    .scheduleIncrement({ taskId: new anchor.BN(taskIdMax), executionIntervalMillis: new anchor.BN(1000), iterations: new anchor.BN(I64_MAX) })
    .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: user.publicKey, program: program.programId }),
  "schedule(iterations=i64::MAX)",
);
console.log(`iterations=i64::MAX accepted: ${!!r1.sig}`);
const samples: { t: number; count: number }[] = [];
if (r1.sig) {
  for (let i = 0; i < 13; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const c = await getCount();
    samples.push({ t: (i + 1) * 5, count: c });
    console.log(`t+${(i + 1) * 5}s: count=${c}`);
  }
}
const c1z = samples.length ? samples[samples.length - 1].count : c1a;
const ticksOver65s = c1z - c1a;
console.log(`iterations=i64::MAX: ${ticksOver65s} ticks over ~65s (ticking >=60s: ${ticksOver65s > 0 && samples.length >= 12})`);
results["iterations=i64::MAX"] = { accepted: !!r1.sig, sig: r1.sig, error: r1.error, countBefore: c1a, samples, ticksOver65s };

console.log("\n=== M-D SUMMARY ===");
console.log(JSON.stringify(results, null, 2));
