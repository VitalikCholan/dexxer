// Week-5 Task 0 — spike P3: per-position scheduler inside the MagicBlock TEE.
//
// Week 5 wants liquidations to run WITHOUT the external relayer, by
// registering ONE SCHEDULED TASK PER OPEN POSITION inside the ER. Week 4
// proved the single global schedule (`ScheduleCrank` with no
// `remaining_accounts`) can only move `Market.mark` — it can never liquidate,
// because a task's accounts are frozen at registration time. A per-position
// task fixes exactly that, IF the scheduler supports the six things this
// script measures:
//
//   (1) N parallel tasks all tick (N = 3, one account each).
//   (2) what registration and each tick cost, and out of which account.
//   (3) `CancelCrankCpi` with `authority` = a PROGRAM PDA (`invoke_signed`)
//       — i.e. can `close_position` cancel without a human signer.
//   (4) whether the task registry leaks outside the TEE (`getProgramAccounts`
//       on the Magic/Crank programs from base RPC and from the TEE without a
//       token) — a public registry would expose "this user has an open
//       position", which is the whole privacy claim.
//   (5) whether a scheduled tick can WRITE a permissioned account whose
//       member list does NOT contain the scheduler's crank signer.
//   (6) how `task_context` is derived for an arbitrary `task_id`.
//
// Mapping to the spike program (`programs/crank-counter/src/lib.rs`):
//   SlotCounter PDA  ~ Position          slot.flag == 1 ~ position is Open
//   slot_tick        ~ crank_tick        escrow PDA     ~ the program as task authority
//
// Slots 0/1/2 are PRIVATE with members = [owner] only (the crank signer is
// deliberately NOT a member) — that is measurement (5). Slot 3 stays PUBLIC
// and is the control: if slot 3 ticks and 0/1/2 do not, the permission layer
// is what blocks the tick, not the scheduler.
//
// Run (from spikes/):  npx tsx 05-crank-tee/w5-p3.ts
// or (from 05-crank-tee/): npm run w5:p3
import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import sha3 from "js-sha3";
import { getAuthToken, MAGIC_PROGRAM_ID, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, BASE_RPC, TEE_RPC, TEE_WS, TEE_VALIDATOR, loadKeypair, routerStatus } from "../lib/env.js";
import idl from "./target/idl/anchor_counter.json" with { type: "json" };

// ---------------------------------------------------------------- constants
// `crank_signer_pda(authority)` — the per-authority PDA the validator derives
// as the ONLY signer a scheduled instruction may carry. Mirrors
// `tests/er/lib/crank-signer.ts` (which cites the pinned validator source);
// duplicated here so the spike stays self-contained.
const CRANK_PROGRAM_ID = new web3.PublicKey("Crank11111111111111111111111111111111111111");
const CRANK_SEED = Buffer.from("crank-executor");
const crankSignerPda = (authority: web3.PublicKey) =>
  web3.PublicKey.findProgramAddressSync([CRANK_SEED, authority.toBuffer()], CRANK_PROGRAM_ID)[0];

const I64_MAX = new BN("9223372036854775807");
const INTERVAL_MS = 5000;
const POLL_SECONDS = 60;

const owner = loadKeypair("payer");
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(owner), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const PID = program.programId;
const escrowPda = web3.PublicKey.findProgramAddressSync([Buffer.from("w5escrow")], PID)[0];
const slotPda = (i: number) => web3.PublicKey.findProgramAddressSync([Buffer.from("w5slot"), Buffer.from([i])], PID)[0];

/** task_id = first 8 bytes of keccak256(slot pubkey) read as a signed LE i64. */
function taskIdFor(slot: web3.PublicKey, salt: number): BN {
  const h = Buffer.from(sha3.keccak256.arrayBuffer(Buffer.concat([slot.toBuffer(), Buffer.from([salt])])));
  return new BN(h.subarray(0, 8), "le").fromTwos(64);
}

const out: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Phase selection, so a partial re-run does not have to redo the 60s poll.
// `W5_ONLY=q4,cleanup npx tsx 05-crank-tee/w5-p3.ts` runs only those phases;
// the base-layer/ER setup above is idempotent and always runs (it no-ops when
// the accounts already exist).
const ONLY = process.env.W5_ONLY ?? "all";
const run = (phase: string) => ONLY === "all" || ONLY.split(",").includes(phase);

async function send(builder: any, label: string): Promise<{ sig?: string; error?: string }> {
  try {
    const sig = await builder.rpc({ commitment: "confirmed" });
    console.log(`  ok  ${label} ${sig}`);
    return { sig };
  } catch (e: any) {
    const head = (e?.message ?? String(e)).split("\n")[0];
    // A transaction-level rejection (e.g. InvalidWritableAccount) carries no
    // program logs at all, only `transactionError` — capture both shapes so a
    // measured FAIL records the real reason, not just "Simulation failed.".
    const txErr = e?.transactionError ?? e?.simulationResponse?.err ?? e?.err;
    const txMsg = e?.transactionMessage;
    let logs: string[] | undefined = e?.logs ?? e?.simulationResponse?.logs;
    if (!logs && typeof e?.getLogs === "function") {
      try { logs = await e.getLogs(); } catch { /* ignore */ }
    }
    const error = [head, txMsg, txErr ? `err=${JSON.stringify(txErr)}` : null, logs?.length ? `logs=${logs.slice(-3).join(" | ")}` : null]
      .filter(Boolean)
      .join(" :: ");
    console.log(`  FAIL ${label}: ${error}`);
    return { error };
  }
}

// ---------------------------------------------------------- 0. base-layer setup
console.log("program:", PID.toBase58());
console.log("owner:", owner.publicKey.toBase58());
console.log("escrow:", escrowPda.toBase58());
for (let i = 0; i < 4; i++) console.log(`slot[${i}]:`, slotPda(i).toBase58());

const solBefore = await baseConn.getBalance(owner.publicKey);
console.log("owner base balance before:", solBefore / 1e9, "SOL");

console.log("\n=== 0. base-layer setup ===");
const ESCROW_PREFUND = 100_000_000; // 0.1 SOL, the task authority's ER spending money
const SLOT_PREFUND = 5_000_000; //     0.005 SOL each, covers the ephemeral permission
if (!(await baseConn.getAccountInfo(escrowPda))) {
  await send(program.methods.initEscrow(new BN(ESCROW_PREFUND)).accounts({ authority: owner.publicKey }), "init_escrow");
}
for (let i = 0; i < 4; i++) {
  if (!(await baseConn.getAccountInfo(slotPda(i)))) {
    await send(program.methods.initSlot([i], new BN(SLOT_PREFUND)).accounts({ authority: owner.publicKey }), "init_slot " + i);
  }
}
const isDelegated = async (k: web3.PublicKey) => (await baseConn.getAccountInfo(k))?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;
const validatorMeta = [{ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false }];
if (!(await isDelegated(escrowPda))) {
  await send(program.methods.delegateEscrow().accounts({ payer: owner.publicKey, pda: escrowPda }).remainingAccounts(validatorMeta), "delegate_escrow");
}
for (let i = 0; i < 4; i++) {
  if (!(await isDelegated(slotPda(i)))) {
    await send(program.methods.delegateSlot([i]).accounts({ payer: owner.publicKey, pda: slotPda(i) }).remainingAccounts(validatorMeta), "delegate_slot " + i);
  }
}
for (const k of [escrowPda, ...[0, 1, 2, 3].map(slotPda)]) {
  let st = await routerStatus(k);
  for (let n = 0; n < 20 && !st.isDelegated; n++) { await sleep(1000); st = await routerStatus(k); }
  console.log(`  router ${k.toBase58().slice(0, 8)}… delegated=${st.isDelegated} fqdn=${st.fqdn}`);
}

// ------------------------------------------------------------ TEE connection
const token = await getAuthToken(TEE_RPC, owner.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, owner.secretKey)));
const teeUrl = `${TEE_RPC}?token=${token.token}`;
const teeConn = new web3.Connection(teeUrl, { wsEndpoint: `${TEE_WS}?token=${token.token}`, commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, new anchor.AnchorProvider(teeConn, new anchor.Wallet(owner), { commitment: "confirmed" }));
const readSlot = async (i: number) => (await erProgram.account.slotCounter.fetch(slotPda(i))) as any;
const erLamports = async (k: web3.PublicKey) => (await teeConn.getAccountInfo(k))?.lamports ?? 0;

const permAccounts = (i: number) => ({ authority: owner.publicKey, slot: slotPda(i) });
if (run("prep")) {
  console.log("\n=== 0b. ER permissions ===");
  for (let i = 0; i < 4; i++) await send(erProgram.methods.initSlotPermission().accounts(permAccounts(i)), "init_slot_permission " + i);
  // Slots 0/1/2 private, members = [owner] ONLY (crank signer intentionally absent) — measurement (5).
  // Slot 3 left public: the control for "does any task tick at all".
  for (let i = 0; i < 3; i++)
    await send(erProgram.methods.setSlotPrivacy(true, web3.PublicKey.default).accounts(permAccounts(i)), `set_slot_privacy ${i} private members=[owner]`);
  // All four "positions" Open.
  for (let i = 0; i < 4; i++) await send(erProgram.methods.setFlag(1).accounts({ authority: owner.publicKey, slot: slotPda(i) }), "set_flag 1 slot " + i);
}

const escrowCrankSigner = crankSignerPda(escrowPda);
const ownerCrankSigner = crankSignerPda(owner.publicKey);
console.log("crank_signer_pda(escrow):", escrowCrankSigner.toBase58());
console.log("crank_signer_pda(owner): ", ownerCrankSigner.toBase58());

function scheduleBuilder(i: number, taskId: BN, iterations: BN, taskContext: web3.PublicKey, useEscrow: boolean, intervalMs = INTERVAL_MS) {
  const crank = useEscrow ? escrowCrankSigner : ownerCrankSigner;
  return erProgram.methods
    .scheduleSlotTask({ taskId, executionIntervalMillis: new BN(intervalMs), iterations }, useEscrow)
    .accounts({ owner: owner.publicKey, escrow: escrowPda, slot: slotPda(i), crank, taskContext, magicProgram: MAGIC_PROGRAM_ID })
    .remainingAccounts([
      { pubkey: taskContext, isSigner: false, isWritable: true },
      { pubkey: crank, isSigner: false, isWritable: false },
      { pubkey: slotPda(i), isSigner: false, isWritable: true },
    ]);
}

// ============================================================ (6) task_context
// No SDK exposes a derivation for this account (week-2 Task 1 finding, still
// true in ephemeral-rollups-sdk 0.16.2 / 0.17 and magicblock-magic-program-api
// 0.10.1). Try three candidates on the PUBLIC slot 3 and report which the
// scheduler accepts and whether the account is actually touched.
const q6: any[] = [];
// `ctx` is the task_context value every later phase registers with; (6) below
// overwrites it with whatever the scheduler actually accepted.
let ctx = owner.publicKey;
const taskIds = [0, 1, 2].map((i) => taskIdFor(slotPda(i), 0));
if (run("q6")) {
console.log("\n=== (6) task_context candidates (public slot 3) ===");
const candidates: { name: string; key: web3.PublicKey }[] = [
  { name: "owner wallet (the week-4 production value)", key: owner.publicKey },
  { name: "fresh random pubkey (no account exists)", key: web3.Keypair.generate().publicKey },
  { name: 'PDA(["task-context", le(task_id)], MAGIC_PROGRAM_ID)', key: web3.PublicKey.default },
];
for (let c = 0; c < candidates.length; c++) {
  const taskId = taskIdFor(slotPda(3), 100 + c);
  if (c === 2) {
    const le = taskId.toTwos(64).toArrayLike(Buffer, "le", 8);
    candidates[c].key = web3.PublicKey.findProgramAddressSync([Buffer.from("task-context"), le], MAGIC_PROGRAM_ID)[0];
  }
  const key = candidates[c].key;
  const before = await teeConn.getAccountInfo(key);
  const t0 = (await readSlot(3)).ticks.toNumber();
  const r = await send(scheduleBuilder(3, taskId, new BN(3), key, true, 2000), `schedule task_context=${candidates[c].name}`);
  await sleep(9000);
  const t1 = (await readSlot(3)).ticks.toNumber();
  const after = await teeConn.getAccountInfo(key);
  const row = {
    candidate: candidates[c].name,
    address: key.toBase58(),
    taskId: taskId.toString(),
    accepted: !!r.sig,
    sig: r.sig,
    error: r.error,
    ticksDelta: t1 - t0,
    accountExistedBefore: !!before,
    accountExistsAfter: !!after,
    lamportsBefore: before?.lamports ?? null,
    lamportsAfter: after?.lamports ?? null,
    dataLenBefore: before?.data.length ?? null,
    dataLenAfter: after?.data.length ?? null,
    ownerAfter: after?.owner.toBase58() ?? null,
  };
  console.log(" ", JSON.stringify(row));
  q6.push(row);
}
out.q6_task_context = q6;
const workingContext = (q6.find((r) => r.accepted && r.ticksDelta > 0) ?? q6.find((r) => r.accepted))?.address;
if (workingContext) ctx = new web3.PublicKey(workingContext);
console.log("task_context value used for the rest of the run:", workingContext ?? "NONE ACCEPTED");
}

// ================================== (1)+(2)+(5) N parallel tasks on private slots
if (run("q1")) {
console.log("\n=== (1)/(2)/(5) three parallel tasks, private slots 0/1/2 ===");
const escrowLamportsStart = await erLamports(escrowPda);
const ownerErStart = await erLamports(owner.publicKey);
const startTicks = await Promise.all([0, 1, 2].map(async (i) => (await readSlot(i)).ticks.toNumber()));
const scheduleResults: any[] = [];
for (const i of [0, 1, 2]) {
  const r = await send(scheduleBuilder(i, taskIds[i], I64_MAX, ctx, true), `schedule slot ${i} (escrow-authority, i64::MAX)`);
  scheduleResults.push({ slot: i, taskId: taskIds[i].toString(), accepted: !!r.sig, sig: r.sig, error: r.error });
}
const escrowAfterRegistration = await erLamports(escrowPda);
const ownerErAfterRegistration = await erLamports(owner.publicKey);
console.log(`  escrow ER lamports: ${escrowLamportsStart} -> ${escrowAfterRegistration} (delta ${escrowAfterRegistration - escrowLamportsStart} for 3 registrations)`);

const samples: any[] = [];
for (let t = 5; t <= POLL_SECONDS; t += 5) {
  await sleep(5000);
  const s = await Promise.all([0, 1, 2, 3].map(async (i) => {
    const a = await readSlot(i);
    return { ticks: a.ticks.toNumber(), count: a.count.toNumber(), lastSigner: a.lastSigner.toBase58() };
  }));
  samples.push({ t, slots: s, escrow: await erLamports(escrowPda) });
  console.log(`  t+${t}s`, s.map((x, i) => `s${i}:${x.ticks}/${x.count}`).join(" "));
}
const endTicks = await Promise.all([0, 1, 2].map(async (i) => (await readSlot(i)).ticks.toNumber()));
const escrowAfterTicks = await erLamports(escrowPda);
const ownerErAfterTicks = await erLamports(owner.publicKey);
const totalTicks = endTicks.reduce((a, b, i) => a + (b - startTicks[i]), 0);
out.q1_parallel = {
  n: 3,
  scheduleResults,
  ticksPerSlot: [0, 1, 2].map((i) => ({ slot: i, delta: endTicks[i] - startTicks[i] })),
  samples,
};
out.q2_cost = {
  escrowErLamports: { start: escrowLamportsStart, afterRegistration: escrowAfterRegistration, afterTicks: escrowAfterTicks },
  registrationCostPerTask: (escrowLamportsStart - escrowAfterRegistration) / 3,
  tickPhaseDelta: escrowAfterRegistration - escrowAfterTicks,
  totalTicksInPhase: totalTicks,
  perTickLamports: totalTicks > 0 ? (escrowAfterRegistration - escrowAfterTicks) / totalTicks : null,
  ownerErLamports: { start: ownerErStart, afterRegistration: ownerErAfterRegistration, afterTicks: ownerErAfterTicks },
};
const lastSigners = (await Promise.all([0, 1, 2, 3].map(async (i) => (await readSlot(i)).lastSigner.toBase58())));
out.q5_permissioned = {
  membersWere: "[owner] only — crank signer NOT a member",
  privateSlotTickDeltas: [0, 1, 2].map((i) => endTicks[i] - startTicks[i]),
  publicControlSlot3Ticks: (await readSlot(3)).ticks.toNumber(),
  lastSigners,
  expectedCrankSigner: escrowCrankSigner.toBase58(),
};
console.log("  last_signer per slot:", lastSigners);

// (5b) if private slots did not tick, add the crank signer to the member list and re-observe.
if (endTicks[0] - startTicks[0] === 0) {
  console.log("\n=== (5b) retry: add crank_signer_pda(escrow) to slot 0's members ===");
  const r = await send(erProgram.methods.setSlotPrivacy(true, escrowCrankSigner).accounts(permAccounts(0)), "set_slot_privacy 0 members=[owner, crank_signer]");
  const b = (await readSlot(0)).ticks.toNumber();
  await sleep(20000);
  const a = (await readSlot(0)).ticks.toNumber();
  console.log(`  slot 0 ticks ${b} -> ${a}`);
  (out.q5_permissioned as any).retryWithCrankSignerMember = { updateAccepted: !!r.sig, error: r.error, ticksBefore: b, ticksAfter: a, delta: a - b };
}
}

// ============================================ (5c) flag gating ("position closed")
if (run("q5c")) {
console.log("\n=== (5c) flag gating: set slot 2 flag = 0 ===");
const g0 = await readSlot(2);
await send(erProgram.methods.setFlag(0).accounts({ authority: owner.publicKey, slot: slotPda(2) }), "set_flag 0 slot 2");
await sleep(20000);
const g1 = await readSlot(2);
out.q5_flag_gating = {
  before: { ticks: g0.ticks.toNumber(), count: g0.count.toNumber() },
  after: { ticks: g1.ticks.toNumber(), count: g1.count.toNumber() },
  ticksKeptRunning: g1.ticks.toNumber() > g0.ticks.toNumber(),
  countFrozen: g1.count.toNumber() === g0.count.toNumber(),
};
console.log(" ", JSON.stringify(out.q5_flag_gating));
}

// ====================================================== (3) cancel via program PDA
if (run("q3")) {
console.log("\n=== (3) cancel slot 0's task with authority = escrow PDA (invoke_signed) ===");
const c0 = (await readSlot(0)).ticks.toNumber();
const c1other = (await readSlot(1)).ticks.toNumber();
const cancelRes = await send(
  erProgram.methods.cancelSlotTask(taskIds[0], true).accounts({ owner: owner.publicKey, escrow: escrowPda, taskContext: ctx, magicProgram: MAGIC_PROGRAM_ID }),
  "cancel_slot_task slot 0 (escrow PDA authority)",
);
await sleep(25000);
const c0after = (await readSlot(0)).ticks.toNumber();
const c1after = (await readSlot(1)).ticks.toNumber();
out.q3_cancel_by_pda = {
  accepted: !!cancelRes.sig,
  sig: cancelRes.sig,
  error: cancelRes.error,
  cancelledSlot0: { before: c0, after: c0after, delta: c0after - c0 },
  untouchedSlot1: { before: c1other, after: c1after, delta: c1after - c1other },
  stopped: c0after === c0,
};
console.log(" ", JSON.stringify(out.q3_cancel_by_pda));
}

// ======================================================= (4) registry visibility
if (run("q4")) {
console.log("\n=== (4) task registry visibility ===");
async function gpa(url: string, programId: string, label: string) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
        params: [programId, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }],
      }),
    });
    const body: any = await r.json();
    if (body.error) return { label, http: r.status, error: `${body.error.code} ${body.error.message}` };
    const accounts = (body.result ?? []).map((a: any) => ({ pubkey: a.pubkey, lamports: a.account.lamports, space: a.account.space }));
    return { label, http: r.status, count: accounts.length, sample: accounts.slice(0, 5) };
  } catch (e: any) {
    return { label, error: String(e?.message ?? e) };
  }
}
const q4: any[] = [];
for (const [pid, pname] of [[MAGIC_PROGRAM_ID.toBase58(), "Magic"], [CRANK_PROGRAM_ID.toBase58(), "Crank"]] as [string, string][]) {
  q4.push(await gpa(BASE_RPC, pid, `${pname} @ base RPC (public L1)`));
  q4.push(await gpa(TEE_RPC, pid, `${pname} @ TEE RPC, NO token`));
  q4.push(await gpa(teeUrl, pid, `${pname} @ TEE RPC, owner token`));
}
for (const row of q4) console.log(" ", JSON.stringify(row));
// Can an outsider even read the private slot account? (privacy control)
const strangerToken = await getAuthToken(TEE_RPC, loadKeypair("stranger").publicKey, (m: Uint8Array) =>
  Promise.resolve(nacl.sign.detached(m, loadKeypair("stranger").secretKey)),
).then((t) => t.token).catch((e) => `ERR ${e?.message}`);
async function readRaw(url: string, key: web3.PublicKey) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [key.toBase58(), { encoding: "base64" }] }),
  });
  const b: any = await r.json();
  if (b.error) return `error ${b.error.code} ${b.error.message}`;
  return b.result?.value ? `visible (${b.result.value.data[0].length} b64 chars)` : "null";
}
out.q4_registry = {
  getProgramAccounts: q4,
  privateSlot0ReadBack: {
    teeNoToken: await readRaw(TEE_RPC, slotPda(0)),
    teeOwnerToken: await readRaw(teeUrl, slotPda(0)),
    teeStrangerToken: typeof strangerToken === "string" && !strangerToken.startsWith("ERR") ? await readRaw(`${TEE_RPC}?token=${strangerToken}`, slotPda(0)) : strangerToken,
    baseRpc: await readRaw(BASE_RPC, slotPda(0)),
  },
};
console.log(" ", JSON.stringify((out.q4_registry as any).privateSlot0ReadBack));
}

// ============================================================ cleanup: cancel all
if (run("cleanup")) {
console.log("\n=== cleanup: cancel remaining tasks ===");
for (const i of [1, 2]) {
  await send(
    erProgram.methods.cancelSlotTask(taskIds[i], true).accounts({ owner: owner.publicKey, escrow: escrowPda, taskContext: ctx, magicProgram: MAGIC_PROGRAM_ID }),
    `cancel slot ${i}`,
  );
}
}

out.finalBalances = {
  ownerBase: (await baseConn.getBalance(owner.publicKey)) / 1e9,
  ownerBaseAtStart: solBefore / 1e9,
  escrowEr: await erLamports(escrowPda),
};
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(out, null, 2));
