// Week-3 M-C: how many post-commit Magic Actions fit in one `commit_aggregate`-
// shaped bundle. Uses the new `commit_with_n_actions(n)` instruction (added
// this task, mirrors `commit_and_update_leaderboard` but pushes `n` identical
// `update_leaderboard` CallHandlers instead of one).
//
// `update_leaderboard`'s own effect (`high_score = max(high_score,
// counter.count)`) is idempotent across repeats, so "did leaderboard grow by
// n" is NOT a usable signal on its own once high_score has already caught up
// to counter.count (it will, after the very first successful action in the
// series). The real "how many of n executed" signal used here is: count
// `Program log: Instruction: UpdateLeaderboard` lines across (a) the base
// commit tx itself and (b) any later program-id txs that show up within a
// short window after it (the committor is documented to retry failed
// BaseActions in a separate tx — see spikes/06-magic-action/RESULT.md check 7
// "Re-run 1"). That count is compared against `n` to decide full vs partial
// vs zero execution.
//
// Run (from spikes/): `npx tsx 06-magic-action/w3-mc.ts`
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
import { baseConn, TEE_RPC, TEE_WS, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/magic_actions.json" with { type: "json" };

const user = loadKeypair("user");

const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter")], program.programId);
const [leaderboardPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("leaderboard")], program.programId);
const escrowPda = escrowPdaFromEscrowAuthority(user.publicKey);

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());
console.log("leaderboardPDA:", leaderboardPDA.toBase58());
console.log("escrowPda:", escrowPda.toBase58());

// counter must already be delegated (spike 06 check 7 left it delegated on devnet).
const counterInfo = await baseConn.getAccountInfo(counterPDA);
assert(counterInfo !== null && counterInfo.owner.equals(DELEGATION_PROGRAM_ID), "counter already delegated");

let status = await routerStatus(counterPDA);
for (let i = 0; i < 20 && !status.isDelegated; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await routerStatus(counterPDA);
}
assert(status.isDelegated, "router reports delegated");
console.log("router fqdn:", status.fqdn);

// Escrow top-up (0.05 SOL) before the series, per brief.
const escrowBefore = await baseConn.getAccountInfo(escrowPda);
console.log("escrow lamports before top-up:", escrowBefore?.lamports ?? 0);
const topUpIx = createTopUpEscrowInstruction(escrowPda, user.publicKey, user.publicKey, 50_000_000);
const topUpSig = await web3.sendAndConfirmTransaction(baseConn, new web3.Transaction().add(topUpIx), [user], {
  commitment: "confirmed",
});
console.log("escrow top-up sig:", topUpSig);
const escrowAfter = await baseConn.getAccountInfo(escrowPda);
console.log("escrow lamports after top-up:", escrowAfter?.lamports ?? 0);

const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) =>
  Promise.resolve(nacl.sign.detached(m, user.secretKey)),
);
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, {
  wsEndpoint: `${TEE_WS}?token=${userToken.token}`,
  commitment: "confirmed",
});
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

async function countUpdateLeaderboardLogs(sig: string): Promise<number> {
  const tx = await baseConn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const logs = tx?.meta?.logMessages ?? [];
  return logs.filter((l) => l.includes("Instruction: UpdateLeaderboard")).length;
}

type Result = {
  n: number;
  erSig?: string;
  baseSig?: string;
  primaryExecuted?: number;
  retryTxsChecked: string[];
  retryExecuted: number;
  totalExecuted?: number;
  sendError?: string;
};

const results: Result[] = [];

for (const n of [1, 2, 4, 8, 12]) {
  console.log(`\n=== n=${n} ===`);
  await new Promise((r) => setTimeout(r, 500));
  await erProgram.methods.increment().accountsPartial({ counter: counterPDA }).rpc();

  const startSlot = await baseConn.getSlot("confirmed");
  const t0 = Date.now();
  let erSig: string | undefined;
  try {
    erSig = await erProgram.methods
      .commitWithNActions(n)
      .accountsPartial({ payer: user.publicKey, counter: counterPDA, leaderboard: leaderboardPDA, programId: program.programId })
      .rpc();
    console.log(`n=${n} ER sig:`, erSig);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.log(`n=${n} ER send FAILED:`, msg);
    if (e?.logs) console.log(`n=${n} ER logs:`, e.logs);
    results.push({ n, retryTxsChecked: [], retryExecuted: 0, sendError: msg });
    continue;
  }

  let baseSig: string | undefined;
  try {
    baseSig = await GetCommitmentSignature(erSig, teeConnUser);
    console.log(`n=${n} base commit sig:`, baseSig);
  } catch (e: any) {
    console.log(`n=${n} GetCommitmentSignature FAILED:`, e?.message ?? String(e));
    results.push({ n, erSig, retryTxsChecked: [], retryExecuted: 0, sendError: `GetCommitmentSignature: ${e?.message ?? e}` });
    continue;
  }

  let confirmed = false;
  for (let i = 0; i < 60 && !confirmed; i++) {
    const st = await baseConn.getSignatureStatus(baseSig);
    if (st.value?.confirmationStatus === "confirmed" || st.value?.confirmationStatus === "finalized") {
      confirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`n=${n} base commit confirmed:`, confirmed, `(${((Date.now() - t0) / 1000).toFixed(2)}s)`);

  const primaryExecuted = confirmed ? await countUpdateLeaderboardLogs(baseSig) : 0;
  console.log(`n=${n} primary tx UpdateLeaderboard log count:`, primaryExecuted);

  // Look for committor retry txs on the program id in the ~20s after the primary tx.
  let retryExecuted = 0;
  const retryTxsChecked: string[] = [];
  if (primaryExecuted < n) {
    await new Promise((r) => setTimeout(r, 5000));
    const sigs = await baseConn.getSignaturesForAddress(program.programId, { limit: 20 }, "confirmed");
    for (const s of sigs) {
      if (s.signature === baseSig) continue;
      if (s.slot < startSlot) continue;
      retryTxsChecked.push(s.signature);
      retryExecuted += await countUpdateLeaderboardLogs(s.signature);
    }
    console.log(`n=${n} retry txs checked:`, retryTxsChecked.length, "extra executed:", retryExecuted);
  }

  const totalExecuted = primaryExecuted + retryExecuted;
  console.log(`n=${n} TOTAL executed: ${totalExecuted} / ${n}`);
  results.push({ n, erSig, baseSig, primaryExecuted, retryTxsChecked, retryExecuted, totalExecuted });
}

console.log("\n=== M-C SUMMARY ===");
console.log(JSON.stringify(results, null, 2));

const fullyExecuted = results.filter((r) => r.totalExecuted === r.n).map((r) => r.n);
const firstFailed = results.find((r) => r.sendError !== undefined || (r.totalExecuted !== undefined && r.totalExecuted < r.n));
console.log("n values that fully executed:", fullyExecuted);
console.log("first n that did not fully execute:", firstFailed?.n ?? "none (all fully executed)", firstFailed ?? "");
