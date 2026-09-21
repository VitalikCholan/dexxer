// Week-3 M-C, part 2: find the actual hard cap for `commit_with_n_actions(n)`
// (w3-mc.ts only sweeps the brief's n = 1,2,4,8,12, all of which passed — this
// extends the search to find where it actually breaks). Run AFTER w3-mc.ts:
// it reuses the escrow top-up w3-mc.ts already made (does not top up again).
//
// Run (from spikes/): `npx tsx 06-magic-action/w3-mc-cap.ts`
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken, GetCommitmentSignature, escrowPdaFromEscrowAuthority, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/magic_actions.json" with { type: "json" };

const user = loadKeypair("user");
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter")], program.programId);
const [leaderboardPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("leaderboard")], program.programId);
const escrowPda = escrowPdaFromEscrowAuthority(user.publicKey);

const counterInfo = await baseConn.getAccountInfo(counterPDA);
assert(counterInfo !== null && counterInfo.owner.equals(DELEGATION_PROGRAM_ID), "counter already delegated");
let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await routerStatus(counterPDA);
}
assert(status.isDelegated, "router reports delegated");

const escrowInfo = await baseConn.getAccountInfo(escrowPda);
console.log("escrow lamports (not topped up here — reusing w3-mc.ts's top-up):", escrowInfo?.lamports ?? 0);

const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)));
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, { wsEndpoint: `${TEE_WS}?token=${userToken.token}`, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

async function countUpdateLeaderboardLogs(sig: string): Promise<number> {
  const tx = await baseConn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return (tx?.meta?.logMessages ?? []).filter((l) => l.includes("Instruction: UpdateLeaderboard")).length;
}

// Binary-search style sweep, run across three separate sessions in this task
// (16/24/32/48/64, then 26/28/30, then 25) — folded into one linear list here
// for a clean re-run; the boundary that matters is 24 (PASS) vs 25 (FAIL).
const sweep = [16, 24, 25, 26, 28, 30, 32, 48, 64];

for (const n of sweep) {
  console.log(`\n=== n=${n} ===`);
  await erProgram.methods.increment().accountsPartial({ counter: counterPDA }).rpc();
  const startSlot = await baseConn.getSlot("confirmed");

  let erSig: string;
  try {
    erSig = await erProgram.methods
      .commitWithNActions(n)
      .accountsPartial({ payer: user.publicKey, counter: counterPDA, leaderboard: leaderboardPDA, programId: program.programId })
      .rpc();
    console.log(`n=${n} ER sig:`, erSig);
  } catch (e: any) {
    console.log(`n=${n} ER send FAILED:`, e?.message ?? String(e));
    if (e?.logs) console.log(`n=${n} logs:`, e.logs);
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
}
