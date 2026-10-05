// tests/er/devnet/00-measure.ts
//
// Week-2 Task 1: real devnet + devnet-tee measurements M1-M4. Run with:
//   export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
//   DEXXER_NET=devnet npx tsx devnet/00-measure.ts
//
// Each Mn is its own function with its own PASS/FAIL line, wrapped in
// try/catch by the runner so a failure in one does not abort the rest.
// Ground truth (signatures, addresses, tables) is printed to stdout; the
// full transcript is the evidence pasted into
// docs/superpowers/plans/weeks0-5-history.md#week-2 and the task-1 report.
//
// Preconditions (see task-1 report for the exact commands run):
//  - spikes/05-crank-tee: `anchor keys sync` (new id, old on-chain program was
//    already closed) + `anchor build` + `anchor deploy` on devnet. New id
//    hardcoded below (SPIKE05_PROGRAM_ID).
//  - spikes/01-private-counter-tee: `set_privacy` extended to take a second
//    `crank: Pubkey` member and a new `commit_with_vault` instruction added
//    (see programs/private-counter/src/lib.rs), then `solana program deploy
//    --program-id ...` upgraded the existing devnet program in place (same
//    id, same counter PDA/state as week 0).
//
// Identities: spikes/keys/{payer,user,stranger}.json (funded, reused from
// week 0) plus a freshly generated `crank` keypair (read-only member for M2 —
// no SOL needed, it never signs a fee-paying transaction).

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  magicFeeVaultPdaFromValidator,
  permissionPdaFromAccount,
  undelegateIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { BASE, ER_VALIDATOR, NET, ROUTER, baseConn, routerStatus, teeConn } from "../lib/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKES = resolve(HERE, "..", "..", "..", "spikes");
const BN = anchor.BN;

if (NET !== "devnet") {
  console.error(`DEXXER_NET=${NET} — this script must run with DEXXER_NET=devnet (see the header comment).`);
  process.exit(1);
}

// ---------------------------------------------------------------- helpers --

function loadSpikeKey(name: string): Keypair {
  const raw = JSON.parse(readFileSync(resolve(SPIKES, "keys", `${name}.json`), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Load-or-create a persistent keypair under spikes/keys/ (gitignored). Used
 * for M2's counter owner — week-0's `user` counter was `initialize`d with
 * `EphemeralPermission::size_of(1)` worth of rent, not enough for the
 * 2-member permission M2 needs (see run.ts M2 comments) — a fresh identity
 * gets a fresh counter, funded correctly by the upgraded `initialize`.
 */
function loadOrCreateSpikeKey(name: string): Keypair {
  const path = resolve(SPIKES, "keys", `${name}.json`);
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

function loadIdl(path: string): Idl {
  return JSON.parse(readFileSync(path, "utf8"));
}

function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function solBalance(kp: Keypair): Promise<number> {
  return (await baseConn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
}

/** Retry an async op a few times with linear backoff, for transient devnet RPC flakiness. */
async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`  [retry] ${label}: attempt ${i + 1}/${tries} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

const results: Record<string, { status: "PASS" | "FAIL"; note: string }> = {};
function record(name: string, status: "PASS" | "FAIL", note = "") {
  results[name] = { status, note };
  console.log(`\n>>> ${name}: ${status}${note ? " — " + note : ""}`);
}

// Well-known MagicBlock crank identity: CRANK_SIGNER = PDA(["crank-executor"], CRANK_PROGRAM_ID)
// (magicblock_magic_program_api::pda::CRANK_SIGNER — CRANK_PROGRAM_ID = "Crank1111...1111").
const CRANK_PROGRAM_ID = new PublicKey("Crank11111111111111111111111111111111111111");
const [CRANK_SIGNER] = PublicKey.findProgramAddressSync([Buffer.from("crank-executor")], CRANK_PROGRAM_ID);

// =============================================================== M1 =======

async function m1_schedulerSigner() {
  console.log("\n=== M1: scheduler (crank) tick signer, task-context account ===");
  const SPIKE05_PROGRAM_ID = new PublicKey("EEkgWoy8krpaxtP8msJeN4rJux2KX68MCHjasosD8CGE");
  const idl = loadIdl(resolve(SPIKES, "05-crank-tee", "target", "idl", "anchor_counter.json"));
  const user = loadSpikeKey("user");
  const payer = loadSpikeKey("payer");

  const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
  const program = new Program(idl, baseProvider);
  const [counterPDA] = PublicKey.findProgramAddressSync([Buffer.from("counter")], SPIKE05_PROGRAM_ID);
  console.log("program:", SPIKE05_PROGRAM_ID.toBase58(), "counterPDA:", counterPDA.toBase58());

  const info = await baseConn.getAccountInfo(counterPDA);
  let initSig = "";
  if (!info) {
    initSig = await withRetry(() => program.methods.initialize().accounts({ user: user.publicKey }).rpc(), "initialize");
    console.log("initialize sig:", initSig);
  } else {
    console.log("initialize: counter already exists, skipping");
  }
  const infoAfterInit = info ?? (await baseConn.getAccountInfo(counterPDA));
  let delegateSig = "";
  if (!infoAfterInit || !infoAfterInit.owner.equals(DELEGATION_PROGRAM_ID)) {
    delegateSig = await withRetry(
      () =>
        program.methods
          .delegate()
          .accounts({ payer: user.publicKey, pda: counterPDA })
          .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
          .rpc(),
      "delegate",
    );
    console.log("delegate sig:", delegateSig);
  } else {
    console.log("delegate: already delegated, skipping");
  }

  let status = await routerStatus(counterPDA);
  for (let i = 0; i < 20 && !status.isDelegated; i++) {
    await sleep(1000);
    status = await routerStatus(counterPDA);
  }
  if (!status.isDelegated) throw new Error("router never reported delegated");
  console.log("router fqdn:", status.fqdn);

  const userTeeConn = await teeConn(user);
  const erProvider = new anchor.AnchorProvider(userTeeConn, new anchor.Wallet(user), { commitment: "confirmed" });
  const erProgram = new Program(idl, erProvider);

  const taskId = new BN(Date.now());
  const scheduleSig = await withRetry(
    () =>
      erProgram.methods
        .scheduleIncrement({ taskId, executionIntervalMillis: new BN(1000), iterations: new BN(3) })
        .accounts({ magicProgram: MAGIC_PROGRAM_ID, payer: user.publicKey, program: SPIKE05_PROGRAM_ID })
        .rpc(),
    "scheduleIncrement",
  );
  console.log("scheduleIncrement sig:", scheduleSig, "taskId:", taskId.toString());

  const c0 = (await (erProgram.account as any).counter.fetch(counterPDA)).count.toNumber();
  let final = c0;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    final = (await (erProgram.account as any).counter.fetch(counterPDA)).count.toNumber();
    console.log(`  t+${i + 1}s: count=${final}`);
    if (final - c0 >= 3) break;
  }
  const ticks = final - c0;
  console.log(`ticks observed: ${ticks} (c0=${c0}, final=${final})`);

  // Payer's own TEE auth token ("через токен payer-а") to inspect the schedule tx.
  const payerTeeConn = await teeConn(payer);
  const schedTx = await payerTeeConn.getTransaction(scheduleSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  let taskContextCandidate = "unknown";
  let scheduleTaskAccounts: string[] = [];
  if (schedTx) {
    const accountKeys = (schedTx.transaction.message as any).accountKeys?.map((k: any) => k.toString()) ?? [];
    console.log("scheduleIncrement tx accountKeys:", accountKeys);
    console.log("scheduleIncrement tx numRequiredSignatures:", (schedTx.transaction.message as any).header?.numRequiredSignatures);
    const inner = schedTx.meta?.innerInstructions ?? [];
    for (const grp of inner) {
      for (const ix of grp.instructions as any[]) {
        const progId = accountKeys[ix.programIdIndex];
        if (progId === MAGIC_PROGRAM_ID.toBase58()) {
          scheduleTaskAccounts = ix.accounts.map((idx: number) => accountKeys[idx]);
          console.log("inner ScheduleTask CPI accounts (index-ordered):", scheduleTaskAccounts);
          if (scheduleTaskAccounts.length > 1) taskContextCandidate = scheduleTaskAccounts[1];
        }
      }
    }
  } else {
    console.log("payer could not fetch scheduleIncrement tx via getTransaction (null)");
  }
  console.log("account index 1 of the inner ScheduleTask CPI:", taskContextCandidate);
  console.log("  == payer?", taskContextCandidate === payer.publicKey.toBase58());
  console.log("  == user?", taskContextCandidate === user.publicKey.toBase58());
  console.log("  == counterPDA?", taskContextCandidate === counterPDA.toBase58());
  if (taskContextCandidate !== "unknown") {
    try {
      const acctInfo = await payerTeeConn.getAccountInfo(new PublicKey(taskContextCandidate));
      console.log("  owner on ER:", acctInfo?.owner.toBase58() ?? "null (no account)", "dataLen:", acctInfo?.data.length ?? 0);
    } catch (e) {
      console.log("  could not read owner of task-context candidate:", String(e).slice(0, 200));
    }
  }

  // Find the tick (increment) transaction signatures. Week-0 finding (spike
  // 01 Check 6): getSignaturesForAddress keyed on a PDA returns [] on this
  // TEE RPC even for the owner — use the PROGRAM ID instead (known to work).
  const sigInfos = await payerTeeConn.getSignaturesForAddress(SPIKE05_PROGRAM_ID, { limit: 10 });
  console.log(
    "getSignaturesForAddress(programId) via payer token:",
    sigInfos.map((s) => ({ sig: s.signature, slot: s.slot, err: s.err })),
  );
  const known = new Set([initSig, delegateSig, scheduleSig].filter(Boolean));
  const tickSigCandidates = sigInfos.map((s) => s.signature).filter((s) => !known.has(s));
  const tickSignerInfo: { sig: string; numRequiredSignatures: number; signers: string[] }[] = [];
  for (const sig of tickSigCandidates.slice(0, 3)) {
    const tx = await payerTeeConn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const accountKeys = (tx.transaction.message as any).accountKeys?.map((k: any) => k.toString()) ?? [];
    const numReq = (tx.transaction.message as any).header?.numRequiredSignatures ?? 0;
    const signers = accountKeys.slice(0, numReq);
    tickSignerInfo.push({ sig, numRequiredSignatures: numReq, signers });
    console.log(`tick candidate ${sig}: numRequiredSignatures=${numReq} signers=${JSON.stringify(signers)}`);
    for (const s of signers) {
      console.log(`    ${s} == CRANK_SIGNER (${CRANK_SIGNER.toBase58()})? ${s === CRANK_SIGNER.toBase58()}`);
      console.log(`    ${s} == user? ${s === user.publicKey.toBase58()}  == payer? ${s === payer.publicKey.toBase58()}`);
    }
  }

  const pass = ticks >= 1 && (tickSignerInfo.length > 0 || taskContextCandidate !== "unknown");
  record("M1", pass ? "PASS" : "FAIL", `ticks=${ticks}, tickSigsInspected=${tickSignerInfo.length}, taskContextCandidate=${taskContextCandidate}`);

  return {
    programId: SPIKE05_PROGRAM_ID.toBase58(),
    counterPDA: counterPDA.toBase58(),
    initSig,
    delegateSig,
    scheduleSig,
    ticks,
    scheduleTaskAccounts,
    taskContextCandidate,
    tickSignerInfo,
    crankSigner: CRANK_SIGNER.toBase58(),
  };
}

// =============================================================== M2 =======

async function m2_memberVisibility() {
  console.log("\n=== M2: member visibility (owner/crank/stranger x getAccountInfo/getProgramAccounts/onAccountChange) ===");
  const SPIKE01_PROGRAM_ID = new PublicKey("2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7");
  const idl = loadIdl(resolve(SPIKES, "01-private-counter-tee", "target", "idl", "private_counter.json"));
  const payer = loadSpikeKey("payer");
  const stranger = loadSpikeKey("stranger");
  const crank = Keypair.generate(); // read-only member; never pays fees, no SOL needed
  console.log("crank (fresh, ephemeral member) pubkey:", crank.publicKey.toBase58());

  // Real finding (first devnet attempt): week-0's `user` counter was
  // `initialize`d with `EphemeralPermission::size_of(1)` worth of rent
  // (894_080 lamports on this deployment) — enough for the original
  // owner-only member list, but growing to 2 members (owner+crank) resizes
  // the EphemeralPermission account past that budget and fails with
  // `InsufficientFundsForRent` (permission's own balance must cover the
  // full 134-byte rent-exempt minimum, ~1_330_960 lamports, not just the
  // marginal resize delta). Fixed at the source: `initialize` now funds
  // `size_of(2)`. A pre-existing `user` counter can't retroactively benefit
  // (its rent was already spent), so M2 uses a fresh, persistent identity
  // (`spikes/keys/m2owner.json`) whose counter is `initialize`d fresh
  // against the upgraded program.
  const user = loadOrCreateSpikeKey("m2owner");
  const userBaseBal = await baseConn.getBalance(user.publicKey);
  if (userBaseBal < 0.01 * LAMPORTS_PER_SOL) {
    const { blockhash } = await baseConn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
    );
    const sig = await withRetry(() => web3.sendAndConfirmTransaction(baseConn, tx, [payer], { commitment: "confirmed" }), "fund m2owner");
    console.log("funded m2owner sig:", sig, "(0.01 SOL)");
  } else {
    console.log("m2owner already funded:", userBaseBal / LAMPORTS_PER_SOL, "SOL");
  }

  const [counterPDA] = PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], SPIKE01_PROGRAM_ID);
  const permissionPDA = permissionPdaFromAccount(counterPDA);

  const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
  const baseProgram = new Program(idl, baseProvider);

  const counterInfo = await baseConn.getAccountInfo(counterPDA);
  if (!counterInfo) {
    const initSig = await withRetry(() => baseProgram.methods.initialize().accounts({ authority: user.publicKey }).rpc(), "initialize (m2owner)");
    console.log("initialize sig:", initSig);
  } else {
    console.log("initialize: m2owner counter already exists, skipping");
  }
  const infoAfterInit = counterInfo ?? (await baseConn.getAccountInfo(counterPDA));
  if (!infoAfterInit || !infoAfterInit.owner.equals(DELEGATION_PROGRAM_ID)) {
    const delSig = await withRetry(
      () => baseProgram.methods.delegate().accountsPartial({ authority: user.publicKey, counter: counterPDA, validator: ER_VALIDATOR }).rpc(),
      "delegate (m2owner)",
    );
    console.log("delegate sig:", delSig);
  } else {
    console.log("delegate: m2owner counter already delegated, skipping");
  }

  let status = await routerStatus(counterPDA);
  for (let i = 0; i < 20 && !status.isDelegated; i++) {
    await sleep(1000);
    status = await routerStatus(counterPDA);
  }
  if (!status.isDelegated) throw new Error("router never reported delegated (m2owner)");

  const userTee = await teeConn(user);
  const erProvider = new anchor.AnchorProvider(userTee, new anchor.Wallet(user), { commitment: "confirmed" });
  const erProgram = new Program(idl, erProvider);

  const permInfo = await userTee.getAccountInfo(permissionPDA);
  if (!permInfo) {
    const initPermSig = await withRetry(
      () =>
        erProgram.methods
          .initPermission()
          .accountsPartial({
            authority: user.publicKey,
            counter: counterPDA,
            permission: permissionPDA,
            magicProgram: MAGIC_PROGRAM_ID,
            permissionProgram: PERMISSION_PROGRAM_ID,
            ephemeralVault: EPHEMERAL_VAULT_ID,
          })
          .rpc(),
      "init_permission (m2owner)",
    );
    console.log("init_permission sig:", initPermSig);
  } else {
    console.log("init_permission: already exists, skipping");
  }

  const setPrivacySig = await withRetry(
    () =>
      erProgram.methods
        .setPrivacy(true, crank.publicKey)
        .accountsPartial({
          authority: user.publicKey,
          counter: counterPDA,
          permission: permissionPDA,
          magicProgram: MAGIC_PROGRAM_ID,
          permissionProgram: PERMISSION_PROGRAM_ID,
          ephemeralVault: EPHEMERAL_VAULT_ID,
        })
        .rpc(),
    "setPrivacy(true,[user,crank])",
  );
  console.log("setPrivacy(true, members=[user,crank]) sig:", setPrivacySig);

  const disc = accountDiscriminator("Counter");
  const discB58 = bs58.encode(disc);

  const identities: [string, Keypair][] = [
    ["owner", user],
    ["crank", crank],
    ["stranger", stranger],
  ];

  const table: Record<string, { getAccountInfo: boolean; bytes: number; getProgramAccounts: boolean; gpaCount: number; onAccountChange: boolean }> = {};

  for (const [label, kp] of identities) {
    const conn = await teeConn(kp);
    let aiOk = false;
    let aiBytes = 0;
    try {
      const info = await conn.getAccountInfo(counterPDA);
      aiOk = info !== null;
      aiBytes = info?.data.length ?? 0;
    } catch (e) {
      console.log(`  ${label} getAccountInfo threw:`, String(e).slice(0, 150));
    }
    let gpaOk = false;
    let gpaCount = 0;
    try {
      const accs = await conn.getProgramAccounts(SPIKE01_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: discB58 } }] });
      gpaCount = accs.length;
      gpaOk = accs.some((a) => a.pubkey.equals(counterPDA));
    } catch (e) {
      console.log(`  ${label} getProgramAccounts threw:`, String(e).slice(0, 150));
    }
    table[label] = { getAccountInfo: aiOk, bytes: aiBytes, getProgramAccounts: gpaOk, gpaCount, onAccountChange: false };
    console.log(`${label}: getAccountInfo=${aiOk} (${aiBytes}B) getProgramAccounts finds counter=${gpaOk} (of ${gpaCount} accounts)`);
  }

  // onAccountChange: subscribe all three, trigger one increment via owner, 60s window.
  const fired: Record<string, boolean> = { owner: false, crank: false, stranger: false };
  const subs: { label: string; conn: Connection; id: number }[] = [];
  for (const [label, kp] of identities) {
    const conn = await teeConn(kp);
    const id = conn.onAccountChange(counterPDA, () => {
      fired[label] = true;
      console.log(`  onAccountChange fired for ${label}`);
    }, "confirmed");
    subs.push({ label, conn, id });
  }
  await sleep(3000);
  const incSig = await withRetry(() => erProgram.methods.increment().accounts({ counter: counterPDA }).rpc(), "increment (M2 trigger)");
  console.log("increment (trigger) sig:", incSig);
  await sleep(57000); // total ~60s window per the brief
  for (const s of subs) {
    try {
      await s.conn.removeAccountChangeListener(s.id);
    } catch {
      /* best-effort cleanup */
    }
  }
  for (const label of Object.keys(fired)) table[label].onAccountChange = fired[label];

  console.log("M2 3x3 table:", JSON.stringify(table, null, 2));

  const pass = table.owner.getAccountInfo === true;
  record("M2", pass ? "PASS" : "FAIL", `table=${JSON.stringify(table)}`);
  return { counterPDA: counterPDA.toBase58(), crank: crank.publicKey.toBase58(), setPrivacySig, incSig, table };
}

// =============================================================== M3 =======

async function m3_commitLimitsAndFeeVault() {
  console.log("\n=== M3: plain-commit limit and magic_fee_vault path ===");
  const SPIKE01_PROGRAM_ID = new PublicKey("2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7");
  const idl = loadIdl(resolve(SPIKES, "01-private-counter-tee", "target", "idl", "private_counter.json"));
  const user = loadSpikeKey("user");
  const payer = loadSpikeKey("payer");
  const [counterPDA] = PublicKey.findProgramAddressSync([Buffer.from("counter"), user.publicKey.toBuffer()], SPIKE01_PROGRAM_ID);

  const userTee = await teeConn(user);
  const erProvider = new anchor.AnchorProvider(userTee, new anchor.Wallet(user), { commitment: "confirmed" });
  const erProgram = new Program(idl, erProvider);

  const commitSigs: string[] = [];
  let failedAtCall = -1;
  let failErr = "";
  let failLogs: string[] = [];
  for (let i = 1; i <= 11; i++) {
    try {
      const sig = await erProgram.methods.commit().accounts({ payer: user.publicKey, counter: counterPDA }).rpc();
      commitSigs.push(sig);
      console.log(`plain commit #${i}: ${sig}`);
    } catch (e: any) {
      failedAtCall = i;
      failErr = e?.message ?? String(e);
      failLogs = e?.logs ?? e?.simulationResponse?.logs ?? [];
      console.log(`plain commit #${i} FAILED:`, failErr);
      if (failLogs.length) console.log("logs:", failLogs);
      break;
    }
  }
  const hasCode = /0xA0000000/i.test(failErr) || failLogs.some((l) => /0xA0000000/i.test(l));
  const m3aPass = failedAtCall === 11 && hasCode;
  record("M3a-plain-commit-limit", m3aPass ? "PASS" : "FAIL", `succeeded=${commitSigs.length}, failedAtCall=${failedAtCall}, err="${failErr.slice(0, 200)}"`);

  // --- fee-vault path -------------------------------------------------
  // Real findings that shaped this (see task-1 report — earlier attempts):
  //  1. `lamportsDelegatedTransferIx(payer, payer, ...)` delegates a *derived*
  //     "lamports PDA" relative to payer, not payer.publicKey itself — payer
  //     stays a plain, non-delegated wallet, so using it as `commit_with_vault`'s
  //     CPI payer still failed with 0xA0000000 on the very first fee-vault
  //     commit (same as the plain-commit limit, i.e. the vault path never
  //     actually engaged).
  //  2. `counter` (this program's own PDA) *is* delegated and can sign a CPI
  //     via seeds (`invoke_signed`, same pattern as `set_privacy`) — the
  //     private-counter program was changed so `commit_with_vault` uses
  //     `counter`, not the plain `payer` wallet, as the CPI's actual payer;
  //     `payer` (a real wallet) still pays the outer transaction's fee.
  //     This is exactly the shape `Config.fee_payer` needs in dexxer_core:
  //     a *delegated, PDA-signable* account, not an admin's plain wallet.
  let m3bPass = false;
  let m3bNote = "";
  const feeVault = magicFeeVaultPdaFromValidator(ER_VALIDATOR);
  console.log("magic_fee_vault (validator-scoped):", feeVault.toBase58());
  try {
    const payerTee = await teeConn(payer);
    const payerErProvider = new anchor.AnchorProvider(payerTee, new anchor.Wallet(payer), { commitment: "confirmed" });
    const payerErProgram = new Program(idl, payerErProvider);

    // Fix round 1: `counter` is privacy-gated (set_privacy(true) since week 0,
    // members=[user] only) — reading its balance through `payerTee` (payer is
    // NOT a member) silently returns 0, the same null-vs-hidden ambiguity M2
    // already documented for getAccountInfo, not a real balance. Use
    // `userTee` (a real member) for `counter`; `payer` and `feeVault` aren't
    // privacy-gated, any connection reads them correctly.
    const payerBefore = await payerTee.getBalance(payer.publicKey).catch(() => -1);
    const counterBefore = await userTee.getBalance(counterPDA).catch(() => -1);
    const vaultBefore = await payerTee.getBalance(feeVault).catch(() => -1);
    console.log("payer ER balance before:", payerBefore, "counter ER balance before (via member token):", counterBefore, "feeVault balance before:", vaultBefore);

    const vaultCommitSigs: string[] = [];
    let vaultFailed = "";
    for (let i = 1; i <= 30; i++) {
      try {
        const sig = await payerErProgram.methods
          .commitWithVault()
          .accountsPartial({ payer: payer.publicKey, counter: counterPDA, magicFeeVault: feeVault })
          .rpc();
        vaultCommitSigs.push(sig);
        if (i <= 3 || i % 5 === 0) console.log(`fee-vault commit #${i}: ${sig}`);
      } catch (e: any) {
        vaultFailed = e?.message ?? String(e);
        console.log(`fee-vault commit #${i} FAILED:`, vaultFailed, e?.logs);
        break;
      }
    }
    const payerAfter = await payerTee.getBalance(payer.publicKey).catch(() => -1);
    const counterAfter = await userTee.getBalance(counterPDA).catch(() => -1);
    const vaultAfter = await payerTee.getBalance(feeVault).catch(() => -1);
    console.log(
      "payer ER balance after:",
      payerAfter,
      "(delta:",
      payerBefore >= 0 && payerAfter >= 0 ? payerAfter - payerBefore : "n/a",
      ") counter ER balance after (via member token):",
      counterAfter,
      "(delta:",
      counterBefore >= 0 && counterAfter >= 0 ? counterAfter - counterBefore : "n/a",
      ") feeVault balance after:",
      vaultAfter,
      "(delta:",
      vaultBefore >= 0 && vaultAfter >= 0 ? vaultAfter - vaultBefore : "n/a",
      ")",
    );

    // Re-derive which account actually failed on the *last* attempt (rather
    // than trust the IDL's declared account order, which legacy
    // `Transaction.compileMessage()` does NOT preserve — it sorts same-tier
    // (writable, non-signer) accounts alphabetically by base58 pubkey). Only
    // meaningful if the loop actually stopped early.
    let failedAccountIndex: number | undefined;
    let failedAccountPubkey = "";
    if (vaultCommitSigs.length < 30) {
      try {
        const ix = await payerErProgram.methods
          .commitWithVault()
          .accountsPartial({ payer: payer.publicKey, counter: counterPDA, magicFeeVault: feeVault })
          .instruction();
        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await payerTee.getLatestBlockhash()).blockhash;
        tx.sign(payer);
        const compiled = tx.compileMessage().accountKeys.map((k) => k.toBase58());
        const sim = await payerTee.simulateTransaction(tx);
        console.log("re-simulated the failing call: compiled accountKeys:", compiled, "sim.value.err:", JSON.stringify(sim.value.err));
        const errObj = sim.value.err as any;
        if (errObj && typeof errObj === "object" && "InsufficientFundsForRent" in errObj) {
          failedAccountIndex = errObj.InsufficientFundsForRent.account_index;
          failedAccountPubkey = failedAccountIndex !== undefined ? compiled[failedAccountIndex] : "";
          console.log(`failing account: index ${failedAccountIndex} = ${failedAccountPubkey}`);
        }
      } catch (e: any) {
        console.log("re-simulation of the failing call threw:", e?.message ?? String(e));
      }
    }

    m3bPass = vaultCommitSigs.length > 0;
    m3bNote = `vaultCommits=${vaultCommitSigs.length}/30, counterErBalanceBefore=${counterBefore}, after=${counterAfter}, payerErBalanceBefore=${payerBefore}, after=${payerAfter}, feeVaultBalanceBefore=${vaultBefore}, after=${vaultAfter}, failedAccountIndex=${failedAccountIndex}, failedAccountPubkey=${failedAccountPubkey}${vaultFailed ? `, firstFailure="${vaultFailed.slice(0, 200)}"` : ""}`;
  } catch (e: any) {
    m3bNote = `fee-vault path failed: ${(e?.message ?? String(e)).slice(0, 300)}`;
    console.log("M3b fee-vault path exception:", e);
  }
  record("M3b-fee-vault-commits", m3bPass ? "PASS" : "FAIL", m3bNote);

  return { counterPDA: counterPDA.toBase58(), commitSigs, failedAtCall, failErr, failLogs, feeVault: feeVault.toBase58(), m3bPass, m3bNote };
}

// =============================================================== M4 =======

async function m4_undelegateWithdraw() {
  console.log("\n=== M4: undelegateIx + withdrawSpl for eSPL ===");
  const mint = new PublicKey("44FTm7zsYePyuBzLmQDjxk53eioxqzkdEW28FEPnSNBk");
  const payer = loadSpikeKey("payer"); // mint authority, fee payer
  // Fix round 1: re-running this measurement against `session` a second time
  // (it already completed one full deposit->undelegate->withdraw cycle) hit
  // `withdrawSpl FAILED: ... require!(ephemeral_ata_info.owned_by(&crate::ID))
  // failed, token_vault.rs:102` — the eSPL ephemeral-ATA bookkeeping for a
  // given (owner, mint) pair is apparently not safely re-cycleable from this
  // client without re-creating it, so a fresh, never-cycled identity is used
  // instead each time this measurement runs (persistent, gitignored, like
  // `m2owner`).
  const owner = loadOrCreateSpikeKey("m4owner");
  const depositAmount = 10n;

  const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
  console.log("mint:", mint.toBase58(), "owner:", owner.publicKey.toBase58(), "ownerAta:", ownerAta.toBase58());

  const ownerBaseBal = await baseConn.getBalance(owner.publicKey);
  if (ownerBaseBal < 0.01 * LAMPORTS_PER_SOL) {
    const { blockhash } = await baseConn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
    );
    const sig = await withRetry(() => web3.sendAndConfirmTransaction(baseConn, tx, [payer], { commitment: "confirmed" }), "fund m4owner");
    console.log("funded m4owner sig:", sig, "(0.01 SOL)");
  }

  // 1. ensure owner's base ATA exists and holds >= depositAmount
  const { createAssociatedTokenAccountIdempotent } = await import("@solana/spl-token");
  const ataAddr = await withRetry(
    () => createAssociatedTokenAccountIdempotent(baseConn, payer, mint, owner.publicKey),
    "createAssociatedTokenAccountIdempotent",
  );
  const preAtaInfo = await getAccount(baseConn, ataAddr).catch(() => null);
  if (!preAtaInfo || preAtaInfo.amount < depositAmount) {
    const mintSig = await withRetry(() => mintTo(baseConn, payer, mint, ataAddr, payer, 1000n), "mintTo owner ATA");
    console.log("mintTo sig:", mintSig);
  }

  // 2. deposit+delegate depositAmount to the ER validator
  const { delegateSpl } = await import("@magicblock-labs/ephemeral-rollups-sdk");
  const delegateIxs = await delegateSpl(owner.publicKey, mint, depositAmount, {
    validator: ER_VALIDATOR,
    payer: payer.publicKey,
    initVaultIfMissing: false, // vault for this mint already exists from spike 02's week-0 run
    idempotent: false,
  });
  const delegateSig = await withRetry(
    () => web3.sendAndConfirmTransaction(baseConn, new Transaction().add(...delegateIxs), [owner, payer], { commitment: "confirmed" }),
    "delegateSpl(owner, 10 units)",
  );
  console.log("delegateSpl sig:", delegateSig);

  const ownerTee = await teeConn(owner);
  let erBalance = -1n;
  for (let i = 0; i < 60; i++) {
    try {
      const acct = await getAccount(ownerTee, ownerAta);
      erBalance = acct.amount;
      if (erBalance === depositAmount) break;
    } catch {
      /* not cloned yet */
    }
    await sleep(500);
  }
  console.log("owner ER balance after delegate:", erBalance.toString(), "(expected", depositAmount.toString(), ")");

  // 3. undelegateIx on the ER — timed segment 1: send -> confirmed.
  // (Fix round 1: the previous version started its single timer *after* this
  // step and the poll below, so the previously-reported "546 ms" only ever
  // covered the withdrawSpl leg, not the undelegate->poll->withdraw sequence
  // the report claimed. Now instrumented as three real segments + a true
  // end-to-end total, timestamped from the undelegate send.)
  const tUndelegateStart = Date.now();
  const undelIx = undelegateIx(owner.publicKey, mint);
  const undelTx = new Transaction().add(undelIx);
  undelTx.feePayer = owner.publicKey;
  undelTx.recentBlockhash = (await ownerTee.getLatestBlockhash()).blockhash;
  undelTx.sign(owner);
  const undelSig = await withRetry(() => ownerTee.sendRawTransaction(undelTx.serialize(), { skipPreflight: true }), "undelegateIx send");
  await ownerTee.confirmTransaction(undelSig, "confirmed").catch(() => {});
  const tUndelegateConfirmed = Date.now();
  console.log("undelegateIx sig:", undelSig, "(", tUndelegateConfirmed - tUndelegateStart, "ms send->confirmed)");

  // 4. poll base ATA until it's owned by the token program again (undelegated / base-committed) — segment 2.
  const tPollStart = tUndelegateConfirmed;
  let baseCommitted = false;
  let baseOwnerSeen = "";
  for (let i = 0; i < 60; i++) {
    const info = await baseConn.getAccountInfo(ownerAta);
    baseOwnerSeen = info?.owner.toBase58() ?? "null";
    if (info && info.owner.equals(TOKEN_PROGRAM_ID)) {
      baseCommitted = true;
      break;
    }
    await sleep(1000);
  }
  const tPollEnd = Date.now();
  console.log("base ATA owner after undelegate poll:", baseOwnerSeen, "baseCommitted:", baseCommitted, "(", tPollEnd - tPollStart, "ms poll)");

  // 5. withdrawSpl(owner, mint, 10n, { idempotent: false }) on base layer — segment 3.
  const tWithdrawStart = tPollEnd;
  let withdrawSig = "";
  let withdrawOk = false;
  try {
    const withdrawIxs = await withdrawSpl(owner.publicKey, mint, depositAmount, { idempotent: false });
    const wtx = new Transaction().add(...withdrawIxs);
    withdrawSig = await withRetry(
      () => web3.sendAndConfirmTransaction(baseConn, wtx, [owner], { commitment: "confirmed" }),
      "withdrawSpl",
    );
    withdrawOk = true;
    console.log("withdrawSpl sig:", withdrawSig);
  } catch (e: any) {
    console.log("withdrawSpl FAILED:", e?.message ?? String(e), e?.logs);
  }
  const tWithdrawEnd = Date.now();
  const undelegateMs = tUndelegateConfirmed - tUndelegateStart;
  const pollMs = tPollEnd - tPollStart;
  const withdrawMs = tWithdrawEnd - tWithdrawStart;
  const totalMs = tWithdrawEnd - tUndelegateStart;
  console.log(`M4 timing: undelegate=${undelegateMs}ms poll=${pollMs}ms withdraw=${withdrawMs}ms total(undelegate->withdraw)=${totalMs}ms`);

  const finalAta = await getAccount(baseConn, ownerAta).catch(() => null);
  console.log("owner base ATA final balance:", finalAta?.amount.toString() ?? "n/a");

  const pass = withdrawOk && baseCommitted;
  record(
    "M4",
    pass ? "PASS" : "FAIL",
    `baseCommitted=${baseCommitted}, withdrawOk=${withdrawOk}, withdrawSig=${withdrawSig}, undelegateMs=${undelegateMs}, pollMs=${pollMs}, withdrawMs=${withdrawMs}, totalMs=${totalMs}`,
  );
  return {
    mint: mint.toBase58(),
    owner: owner.publicKey.toBase58(),
    delegateSig,
    undelSig,
    baseCommitted,
    withdrawSig,
    withdrawOk,
    undelegateMs,
    pollMs,
    withdrawMs,
    totalMs,
  };
}

// ============================================================== runner ====

async function main() {
  console.log("DEXXER_NET:", NET, "BASE:", BASE, "ROUTER:", ROUTER, "ER_VALIDATOR:", ER_VALIDATOR.toBase58());

  // MEASURE_ONLY=m1,m2,... restricts the run to a subset — used for
  // re-running a single fixed-up measurement without repeating (and paying
  // for) the others. Default (unset) runs all four, as the deliverable's
  // npm script does.
  const only = process.env.MEASURE_ONLY?.split(",").map((s) => s.trim().toLowerCase());
  const wants = (m: string) => !only || only.includes(m);

  const payerBal0 = await solBalance(loadSpikeKey("payer"));
  console.log("payer balance at script start:", payerBal0, "SOL");

  if (wants("m1")) {
    try {
      await m1_schedulerSigner();
    } catch (e) {
      console.error("M1 threw:", e);
      record("M1", "FAIL", String((e as Error)?.message ?? e).slice(0, 300));
    }
  }

  if (wants("m2")) {
    try {
      await m2_memberVisibility();
    } catch (e) {
      console.error("M2 threw:", e);
      record("M2", "FAIL", String((e as Error)?.message ?? e).slice(0, 300));
    }
  }

  if (wants("m3")) {
    try {
      await m3_commitLimitsAndFeeVault();
    } catch (e) {
      console.error("M3 threw:", e);
      record("M3a-plain-commit-limit", "FAIL", String((e as Error)?.message ?? e).slice(0, 300));
    }
  }

  if (wants("m4")) {
    try {
      await m4_undelegateWithdraw();
    } catch (e) {
      console.error("M4 threw:", e);
      record("M4", "FAIL", String((e as Error)?.message ?? e).slice(0, 300));
    }
  }

  const payerBal1 = await solBalance(loadSpikeKey("payer"));
  console.log("\n=== SUMMARY ===");
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name}: ${r.status}${r.note ? " — " + r.note : ""}`);
  }
  console.log(`payer balance: ${payerBal0} SOL -> ${payerBal1} SOL (delta ${payerBal1 - payerBal0})`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
