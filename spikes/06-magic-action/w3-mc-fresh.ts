// Week-3 M-C, fix round 1: re-measure the action-bundle boundary on a
// GENUINELY FRESH, never-committed `counter` account, to rule out the
// confound flagged in review — weeks0-5-history.md#week-2 M3a documented that a plain
// top-level Signer payer gets exactly 10 successful `commit()`s per account,
// then a PERMANENT `0xA0000000` ("COMMIT_LIMIT_ERR" per that measurement),
// never resetting. `commit_with_n_actions` uses exactly that payer path
// (`ctx.accounts.payer`, a plain wallet). The original w3-mc.ts/w3-mc-cap.ts
// sweep reused spike 06's one global `counter` PDA (seeds = ["counter"], no
// payer component — see programs/magic-actions/src/lib.rs's `Initialize`),
// which already carried ~5 commits from Sept-19 debugging (check 7) before
// this task's own 8 more (n=1,2,4,8,12,16,24-primary,24-retry) — so the
// observed "n=24 PASS / n=25 FAIL" boundary could just as well be "this
// account's 10-commit quota ran out", not a bundle-size limit.
//
// This script runs against a BRAND NEW program id (`anchor build --ignore-keys`
// + `solana program deploy` under a freshly generated keypair, see the task
// report for the exact commands) so `counter`'s commit count starts at 0 —
// the quota and any genuine bundle-size/CU/tx-size limit can no longer be
// confused for each other. Same log-line-counting method as w3-mc.ts.
//
// Run (from spikes/, AFTER manually deploying the fresh id — this script
// does not deploy): `npx tsx 06-magic-action/w3-mc-fresh.ts <fresh-payer-keypair-path>`
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import {
  getAuthToken,
  GetCommitmentSignature,
  escrowPdaFromEscrowAuthority,
  createTopUpEscrowInstruction,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { readFileSync } from "fs";
import { baseConn, TEE_RPC, TEE_WS, TEE_VALIDATOR, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/magic_actions.json" with { type: "json" };

const payerPath = process.argv[2];
if (!payerPath) {
  console.error("usage: npx tsx w3-mc-fresh.ts <fresh-payer-keypair.json>");
  process.exit(1);
}
const user = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))));
console.log("fresh payer:", user.publicKey.toBase58());

const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter")], program.programId);
const [leaderboardPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("leaderboard")], program.programId);
const escrowPda = escrowPdaFromEscrowAuthority(user.publicKey);
console.log("program (fresh id):", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());
console.log("leaderboardPDA:", leaderboardPDA.toBase58());

// initialize (fresh — this counter/leaderboard PDA pair has never existed before)
const info = await baseConn.getAccountInfo(counterPDA);
if (!info) {
  const sig = await program.methods
    .initialize()
    .accountsPartial({ counter: counterPDA, leaderboard: leaderboardPDA, user: user.publicKey, systemProgram: web3.SystemProgram.programId })
    .rpc();
  console.log("initialize sig:", sig);
} else {
  console.log("initialize: counter already exists (unexpected for a fresh program id), skipping");
}

const counterInfo = await baseConn.getAccountInfo(counterPDA);
if (!counterInfo || !counterInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
  const topUpIx = createTopUpEscrowInstruction(escrowPda, user.publicKey, user.publicKey, 50_000_000);
  const delegateIx = await program.methods
    .delegate()
    .accountsPartial({ payer: user.publicKey, pda: counterPDA })
    .remainingAccounts([{ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false }])
    .instruction();
  const tx = new web3.Transaction().add(topUpIx, delegateIx);
  const sig = await web3.sendAndConfirmTransaction(baseConn, tx, [user], { commitment: "confirmed" });
  console.log("delegate+topUpEscrow sig:", sig);
} else {
  console.log("delegate: already delegated, skipping");
}

let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await routerStatus(counterPDA);
}
assert(status.isDelegated, "router reports delegated");
console.log("router fqdn:", status.fqdn);

const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)));
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, { wsEndpoint: `${TEE_WS}?token=${userToken.token}`, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

async function countUpdateLeaderboardLogs(sig: string): Promise<number> {
  const tx = await baseConn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return (tx?.meta?.logMessages ?? []).filter((l) => l.includes("Instruction: UpdateLeaderboard")).length;
}

// COMMIT_LIMIT_ERR per weeks0-5-history.md#week-2 M3a (10 successful plain commits/account, then permanent).
const COMMIT_LIMIT_ERR = "0xa0000000";

const results: any[] = [];
const sweep = [8, 16, 24, 25, 32];
let stoppedEarly = false;

for (const n of sweep) {
  if (stoppedEarly) break;
  console.log(`\n=== fresh-account n=${n} (commit #${results.length + 1} on this account) ===`);
  const startSlot = await baseConn.getSlot("confirmed");
  let erSig: string | undefined;
  let sendError: string | undefined;
  try {
    erSig = await erProgram.methods
      .commitWithNActions(n)
      .accountsPartial({ payer: user.publicKey, counter: counterPDA, leaderboard: leaderboardPDA, programId: program.programId })
      .rpc();
    console.log(`n=${n} ER sig:`, erSig);
  } catch (e: any) {
    sendError = e?.message ?? String(e);
    console.log(`n=${n} ER send FAILED:`, sendError);
    const decoded = sendError?.includes(COMMIT_LIMIT_ERR) ? " (= COMMIT_LIMIT_ERR, week2 M3a: 10-plain-commit quota)" : "";
    if (decoded) console.log(`n=${n} decoded:${decoded}`);
    results.push({ n, sendError, decoded: decoded || undefined });
    continue;
  }

  const baseSig = await GetCommitmentSignature(erSig, teeConnUser);
  console.log(`n=${n} base commit sig:`, baseSig);
  let confirmed = false;
  for (let i = 0; i < 60 && !confirmed; i++) {
    const st = await baseConn.getSignatureStatus(baseSig);
    if (st.value?.confirmationStatus === "confirmed" || st.value?.confirmationStatus === "finalized") { confirmed = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  let executed = confirmed ? await countUpdateLeaderboardLogs(baseSig) : 0;
  if (executed < n) {
    await new Promise((r) => setTimeout(r, 5000));
    const sigs = await baseConn.getSignaturesForAddress(program.programId, { limit: 20 }, "confirmed");
    for (const s of sigs) {
      if (s.signature === baseSig || s.slot < startSlot) continue;
      executed += await countUpdateLeaderboardLogs(s.signature);
    }
  }
  console.log(`n=${n} TOTAL executed: ${executed} / ${n}`);
  results.push({ n, erSig, baseSig, executed, full: executed === n });
}

console.log("\n=== M-C FRESH-ACCOUNT SUMMARY ===");
console.log(JSON.stringify(results, null, 2));

// Report remaining balance so it can be swept back to spikes/keys/payer.json.
const finalBalance = await baseConn.getBalance(user.publicKey);
console.log("\nfresh payer final balance (lamports):", finalBalance, `(${finalBalance / 1e9} SOL)`);
