// Check 7: Magic Action writes an L1 account after commit; direct call rejected.
// Adapted from spikes/.superpowers/sdd/2026-09-19-week0-spikes/task-9-brief.md
// against the real IDL in target/idl/magic_actions.json (mirrors the TEE client
// pattern in spikes/01-private-counter-tee/check.ts: delegate to TEE_VALIDATOR,
// getAuthToken, ER provider, re-run guards). See RESULT.md for deviations.
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
import { baseConn, TEE_RPC, TEE_WS, TEE_VALIDATOR, loadKeypair, routerStatus, assert } from "../lib/env.js";
import idl from "./target/idl/magic_actions.json" with { type: "json" };

const user = loadKeypair("user");

// Base provider (user pays)
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("counter")], program.programId);
const [leaderboardPDA] = web3.PublicKey.findProgramAddressSync([Buffer.from("leaderboard")], program.programId);
const escrowPda = escrowPdaFromEscrowAuthority(user.publicKey); // index 255, matches ACTION_ESCROW_INDEX

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());
console.log("leaderboardPDA:", leaderboardPDA.toBase58());
console.log("escrowPda:", escrowPda.toBase58());

// Wrapper mirroring spikes/01-private-counter-tee/check.ts: keep preflight on,
// retry once with skipPreflight on a genuine simulation failure.
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
    return sig;
  }
}

// 1. initialize counter + leaderboard on base (single ix creates both, init_if_needed)
const counterInfo = await baseConn.getAccountInfo(counterPDA);
if (!counterInfo) {
  await sendRpc(
    program.methods.initialize().accountsPartial({
      counter: counterPDA,
      leaderboard: leaderboardPDA,
      user: user.publicKey,
      systemProgram: web3.SystemProgram.programId,
    }),
    "initialize",
  );
} else {
  console.log("initialize: counter already exists, skipping");
}

// 2. delegate counter to TEE_VALIDATOR (leaderboard stays on L1, never delegated)
const counterInfoAfterInit = counterInfo ?? (await baseConn.getAccountInfo(counterPDA));
if (!counterInfoAfterInit || !counterInfoAfterInit.owner.equals(DELEGATION_PROGRAM_ID)) {
  // Top up the escrow (index 255) that the post-commit action will spend fees
  // from, bundled with delegate in one tx (matches the example's own test).
  const topUpIx = createTopUpEscrowInstruction(escrowPda, user.publicKey, user.publicKey, 100_000);
  const delegateIx = await program.methods
    .delegate()
    .accountsPartial({ payer: user.publicKey, pda: counterPDA })
    .remainingAccounts([{ pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false }])
    .instruction();
  const tx = new web3.Transaction().add(topUpIx, delegateIx);
  const sig = await web3.sendAndConfirmTransaction(baseConn, tx, [user], { commitment: "confirmed" });
  console.log("delegate+topUpEscrow sig:", sig);
} else {
  console.log("delegate: counter already delegated, skipping (escrow top-up also skipped)");
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

// 3. TEE token for user, ER provider
const userToken = await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) =>
  Promise.resolve(nacl.sign.detached(m, user.secretKey)),
);
const teeConnUser = new web3.Connection(`${TEE_RPC}?token=${userToken.token}`, {
  wsEndpoint: `${TEE_WS}?token=${userToken.token}`,
  commitment: "confirmed",
});
const erProvider = new anchor.AnchorProvider(teeConnUser, new anchor.Wallet(user), { commitment: "confirmed" });
const erProgram = new Program(idl as anchor.Idl, erProvider);

// 4. increment on ER
await sendRpc(erProgram.methods.increment().accountsPartial({ counter: counterPDA }), "increment");
const erCounter = await erProgram.account.counter.fetch(counterPDA);
const erCount = (erCounter as any).count.toNumber();
console.log("counter count on ER after increment:", erCount);

// 5. commit + post-commit action (13F mechanism): commit counter, then Magic
// Action calls update_leaderboard on base with the injected escrow/escrow_auth.
const leaderboardBefore = await program.account.leaderboard.fetch(leaderboardPDA);
console.log("leaderboard.highScore on base BEFORE commit+action:", (leaderboardBefore as any).highScore.toNumber());

const t0 = Date.now();
const erSig = await erProgram.methods
  .commitAndUpdateLeaderboard()
  .accountsPartial({ payer: user.publicKey, counter: counterPDA, leaderboard: leaderboardPDA, programId: program.programId })
  .rpc();
console.log("ER commit+action sig:", erSig);

const baseSig = await GetCommitmentSignature(erSig, teeConnUser);
console.log("base commit signature (GetCommitmentSignature):", baseSig);

// confirm on base via a poll loop (avoids the deprecated no-blockhash confirmTransaction overload)
{
  let confirmed = false;
  for (let i = 0; i < 60 && !confirmed; i++) {
    const st = await baseConn.getSignatureStatus(baseSig);
    if (st.value?.confirmationStatus === "confirmed" || st.value?.confirmationStatus === "finalized") {
      confirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(confirmed, `base commit signature confirmed: ${baseSig}`);
}

// 6. poll base leaderboard.highScore until it reflects the counter, timeout 60s
let hs = -1;
let secondsToEffect = -1;
for (let i = 0; i < 60; i++) {
  const lb = await program.account.leaderboard.fetch(leaderboardPDA);
  hs = (lb as any).highScore.toNumber();
  if (hs >= erCount) {
    secondsToEffect = (Date.now() - t0) / 1000;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("leaderboard.highScore on base AFTER commit+action:", hs, "seconds from ER tx to L1 effect:", secondsToEffect);
assert(hs >= erCount, `leaderboard on L1 updated by Magic Action (highScore=${hs}, expected >= ${erCount})`);

console.log("CHECK 7 PASS (Magic Action landed on L1)", { erSig, baseSig, highScore: hs, secondsToEffect });

// 7. Direct call to the #[action] handler from base — must be rejected.
// escrowAuth = user's own wallet; escrow = the derived PDA the delegation
// program alone can sign for. A non-delegation-program caller cannot produce
// that signature.
let directErr = "";
try {
  const sig = await program.methods
    .updateLeaderboard()
    .accountsPartial({
      leaderboard: leaderboardPDA,
      counter: counterPDA,
      sourceProgram: program.programId,
      escrowAuth: user.publicKey,
      escrow: escrowPda,
    })
    .rpc();
  console.log("DIRECT CALL UNEXPECTEDLY SUCCEEDED, sig:", sig);
} catch (e: any) {
  directErr = e?.message ?? String(e);
  console.log("direct call raw error:", directErr);
  if (e?.logs) console.log("direct call logs:", e.logs);
}
assert(directErr !== "", `direct call to #[action] handler rejected: ${directErr.slice(0, 200)}`);

console.log("CHECK 7 FULL PASS", { erSig, baseSig, highScore: hs, secondsToEffect, directErr: directErr.slice(0, 200) });
