// Check 6: does a non-member (stranger wallet, or no token at all) see transactions
// touching a privacy-gated account on the TEE RPC — signatures, tx message/account keys, logs?
// Consumes: counterPDA, program deployed in Task 3; user has done >=1 `increment` on the TEE.
import { web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_RPC, loadKeypair, assert } from "../lib/env.js";

const user = loadKeypair("user");
const stranger = loadKeypair("stranger");
const PROGRAM_ID = new web3.PublicKey(process.argv[2]); // from RESULT.md
// Optional fallback: an ER tx signature from Task 3's report, in case getSignaturesForAddress
// returns empty for the owner (ER may not index by address).
const fallbackSig: string | undefined = process.argv[3];

const [counterPDA] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("counter"), user.publicKey.toBuffer()],
  PROGRAM_ID,
);
console.log("program:", PROGRAM_ID.toBase58());
console.log("counterPDA:", counterPDA.toBase58());

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return r.json();
}

const userTok = (
  await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)))
).token;
const strTok = (
  await getAuthToken(TEE_RPC, stranger.publicKey, (m: Uint8Array) =>
    Promise.resolve(nacl.sign.detached(m, stranger.secretKey)),
  )
).token;

const ownerSigs = await rpc(`${TEE_RPC}?token=${userTok}`, "getSignaturesForAddress", [
  counterPDA.toBase58(),
  { limit: 5 },
]);
console.log("owner sigs (raw, first 300 chars):", JSON.stringify(ownerSigs).slice(0, 300));

let sig: string | undefined;
let sigSource: "owner-getSignaturesForAddress" | "fallback-arg" = "owner-getSignaturesForAddress";
if (Array.isArray(ownerSigs.result) && ownerSigs.result.length > 0) {
  sig = ownerSigs.result[0].signature;
} else {
  console.log("owner getSignaturesForAddress returned empty/error — falling back to argv[3] signature");
  sig = fallbackSig;
  sigSource = "fallback-arg";
}
assert(!!sig, `have a signature to test getTransaction with (source: ${sigSource})`);
console.log("using sig:", sig, "source:", sigSource);

// Soft check (does not exit process): we want ALL of stranger + no-token + the program-id probe
// recorded in one run even if one of them reveals a leak. Overall pass/fail is decided at the end.
let anyLeak = false;
function soft(cond: boolean, msg: string) {
  if (cond) {
    console.log("ok:", msg);
  } else {
    console.log("FAIL:", msg);
    anyLeak = true;
  }
}

for (const [label, url] of [
  ["stranger", `${TEE_RPC}?token=${strTok}`],
  ["no-token", TEE_RPC],
] as const) {
  const sigs = await rpc(url, "getSignaturesForAddress", [counterPDA.toBase58(), { limit: 5 }]);
  const tx = await rpc(url, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  console.log(label, "sigs (raw, first 300 chars):", JSON.stringify(sigs).slice(0, 300));
  console.log(label, "tx (raw, first 300 chars):", JSON.stringify(tx).slice(0, 300));
  const sigsHidden = sigs.error !== undefined || !Array.isArray(sigs.result) || sigs.result.length === 0;
  const txHidden = tx.error !== undefined || tx.result === null;
  soft(sigsHidden, `${label}: getSignaturesForAddress hidden`);
  soft(txHidden, `${label}: getTransaction hidden`);
}

// Extra probe (not an assertion, just data): does the program's own activity list leak to a
// stranger via getSignaturesForAddress on the PROGRAM ID (not the PDA)?
const programSigsStranger = await rpc(`${TEE_RPC}?token=${strTok}`, "getSignaturesForAddress", [
  PROGRAM_ID.toBase58(),
  { limit: 5 },
]);
console.log(
  "stranger program-id sigs (raw, first 300 chars):",
  JSON.stringify(programSigsStranger).slice(0, 300),
);

if (anyLeak) {
  console.log("CHECK 6 FAIL");
  process.exit(1);
} else {
  console.log("CHECK 6 PASS");
}
