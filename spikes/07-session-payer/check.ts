// Check 9: session key as ER fee payer after one-time top-up.
// This spike tests PAYER MECHANICS only: can a fresh on-curve keypair, topped
// up solely via gum-sdk's createSessionV2, be the fee payer and sole signer
// of an ER transaction against the TEE endpoint. Session-token validation
// *inside* the program is NOT tested (private-counter's `increment` accepts
// only `counter` — it never checks the session token account).
//
// Task 3's `set_privacy` (spikes/01-private-counter-tee/programs/private-counter/src/lib.rs)
// hardcodes the permission member list to just the counter authority (the
// user key) — there is no instruction path to add the session key as a
// member without editing lib.rs, which this task must not touch (per brief,
// no rebuild/redeploy). So the SESSION key is never a permission member of
// this counter's ephemeral permission. We still attempt getAuthToken with
// the session key (step 2a below): if it fails, we fall back to obtaining
// the TEE token via the USER key (the only member) while SESSION remains the
// fee payer and signer of the ER tx; if it succeeds, we additionally probe
// (step 2c) whether that token actually lets the session key *read* the
// private counter — auth-token issuance and per-account read gating are not
// necessarily the same check, and earlier runs showed getAuthToken succeeds
// for non-members (see RESULT.md "Key finding").
import * as anchor from "@coral-xyz/anchor";
import { BN, Program, web3 } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, loadKeypair, assert } from "../lib/env.js";
import idl from "../01-private-counter-tee/target/idl/private_counter.json" with { type: "json" };

const user = loadKeypair("user");
const session = loadKeypair("session");
const baseProvider = new anchor.AnchorProvider(baseConn, new anchor.Wallet(user), { commitment: "confirmed" });
const program = new Program(idl as anchor.Idl, baseProvider);
const [counterPDA] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("counter"), user.publicKey.toBuffer()],
  program.programId,
);

console.log("program:", program.programId.toBase58());
console.log("counterPDA:", counterPDA.toBase58());
console.log("user pubkey:", user.publicKey.toBase58());
console.log("session pubkey:", session.publicKey.toBase58());
console.log("session balance before:", await baseConn.getBalance(session.publicKey));

// 1. create session V2 on base with 0.005 SOL one-time top-up to the session signer.
// DEVIATION: installed @magicblock-labs/gum-sdk@3.0.10's SessionTokenManager
// constructor is `(wallet, connection)` only — no third "devnet"/Cluster arg
// as the brief's illustrative snippet has. Dropped here.
const stm = new SessionTokenManager(baseProvider.wallet as anchor.Wallet, baseConn);
const expiry = Math.floor(Date.now() / 1000) + 3600;

// Re-run safety: createSessionV2's session_token PDA is derived from
// (target_program, session_signer, authority) — a fixed keyset across runs —
// so a second createSessionV2 call for the same session/user pair fails
// on-chain ("Allocate: account ... already in use"). Guard it the same way
// Task 3's check.ts guards `init_permission`/`set_privacy`.
const [sessionTokenPDA] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("session_token_v2"), program.programId.toBuffer(), session.publicKey.toBuffer(), user.publicKey.toBuffer()],
  stm.program.programId,
);
let baseSig = "";
const existingSessionToken = await baseConn.getAccountInfo(sessionTokenPDA);
if (existingSessionToken !== null) {
  console.log("session token already exists — skipping createSessionV2, reusing", sessionTokenPDA.toBase58());
} else {
  const createTx = await stm.program.methods
    .createSessionV2(true, new BN(expiry), new BN(0.005 * web3.LAMPORTS_PER_SOL))
    .accounts({
      targetProgram: program.programId,
      sessionSigner: session.publicKey,
      feePayer: user.publicKey,
      authority: user.publicKey,
    })
    .transaction();
  baseSig = await baseProvider.sendAndConfirm(createTx, [session]);
  console.log("createSessionV2 sig:", baseSig);
}
const sessionBalanceAfterTopUp = await baseConn.getBalance(session.publicKey);
console.log("session balance after top-up:", sessionBalanceAfterTopUp);
assert(sessionBalanceAfterTopUp > 0, "session key holds lamports from the createSessionV2 top-up (no separate base airdrop)");

// 2a. Does the session key itself get a TEE auth token? It is not a
// permission member (see header comment) so this is not guaranteed either way.
let sessionGotOwnToken = false;
let sessionAuthError = "";
let sessionTeeToken: string | null = null;
try {
  const sTok = await getAuthToken(TEE_RPC, session.publicKey, (m) =>
    Promise.resolve(nacl.sign.detached(m, session.secretKey)),
  );
  sessionGotOwnToken = true;
  sessionTeeToken = sTok.token;
  console.log("session key obtained its own TEE token:", sTok.token.slice(0, 24) + "...");
} catch (e) {
  sessionAuthError = String((e as any)?.message ?? e);
  console.log("session key getAuthToken FAILED (not a permission member):", sessionAuthError);
}

// 2b. Always also obtain a TEE token for the USER key (the one confirmed
// permission member) — needed both as the submission-token fallback and,
// regardless of variant, to read the counter's true value before/after the
// ER tx below (step 3c), since only a member's reads are unfiltered.
const userAuthToken = await getAuthToken(TEE_RPC, user.publicKey, (m) =>
  Promise.resolve(nacl.sign.detached(m, user.secretKey)),
);
const userTee = new web3.Connection(`${TEE_RPC}?token=${userAuthToken.token}`, {
  wsEndpoint: `${TEE_WS}?token=${userAuthToken.token}`,
  commitment: "confirmed",
});

// 2c. If the session key did get its own token, use it to attempt a read of
// the private counter BEFORE the ER tx below — this is the actual membership
// proof (auth-token issuance alone does not demonstrate membership: Task 1's
// `stranger` key also got a token but was denied reads). If getAuthToken
// failed for session, there is no session-token connection to probe with,
// and the auth failure itself is the non-membership evidence.
let sessionTee: web3.Connection | null = null;
if (sessionTeeToken !== null) {
  sessionTee = new web3.Connection(`${TEE_RPC}?token=${sessionTeeToken}`, {
    wsEndpoint: `${TEE_WS}?token=${sessionTeeToken}`,
    commitment: "confirmed",
  });
}

let sessionReadResult: web3.AccountInfo<Buffer> | null = null;
let sessionReadError = "";
if (sessionTee !== null) {
  try {
    sessionReadResult = await sessionTee.getAccountInfo(counterPDA);
    console.log("session-token read of counterPDA (raw):", sessionReadResult);
  } catch (e) {
    sessionReadError = String((e as any)?.message ?? e);
    console.log("session-token read of counterPDA FAILED (raw error):", sessionReadError);
  }
  const sessionCanRead = sessionReadResult !== null && sessionReadError === "";
  console.log(
    sessionCanRead
      ? "MEMBERSHIP PROOF: session key CAN read the private counter with its own token (unexpected — reads are not gated the way assumed)."
      : "MEMBERSHIP PROOF: session key CANNOT read the private counter with its own token (null/error) — reads are gated, session is not an effective member.",
  );
} else {
  console.log("MEMBERSHIP PROOF: session key never obtained a TEE token at all — non-membership demonstrated by the getAuthToken failure above.");
}

function decodeCount(info: web3.AccountInfo<Buffer> | null): bigint | null {
  // Counter layout: 8-byte anchor discriminator, then `count: u64` (LE), then `authority: Pubkey` (32 bytes).
  if (info === null || info.data.length < 16) return null;
  return info.data.readBigUInt64LE(8);
}

const counterBeforeInfo = await userTee.getAccountInfo(counterPDA);
const counterBefore = decodeCount(counterBeforeInfo);
console.log("counter count BEFORE (via user-token read):", counterBefore?.toString());
assert(counterBefore !== null, "user (permission member) can read the counter and decode its count before the ER tx");

// 3. session key is fee payer of an ER tx. Submission connection is the
// session's own token if it got one, otherwise the user's token (fallback),
// while SESSION remains the fee payer and (first attempt) sole signer.
const variant: "session-token" | "user-token" = sessionGotOwnToken ? "session-token" : "user-token";
const tee = sessionGotOwnToken ? (sessionTee as web3.Connection) : userTee;
console.log(`variant: ${variant} (submitting via ${sessionGotOwnToken ? "session" : "user"}'s TEE token)`);

const ix = await program.methods.increment().accounts({ counter: counterPDA }).instruction();

async function buildAndSend(signers: web3.Keypair[]): Promise<{ sig: string } | { error: string }> {
  const erTx = new web3.Transaction().add(ix);
  erTx.feePayer = session.publicKey;
  erTx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  erTx.sign(...signers);
  try {
    const sig = await tee.sendRawTransaction(erTx.serialize());
    return { sig };
  } catch (e) {
    return { error: String((e as any)?.message ?? e) };
  }
}

let erSig: string | null = null;
let secondSignerNeeded = false;
let firstAttemptError = "";

const attempt1 = await buildAndSend([session]);
if ("sig" in attempt1) {
  erSig = attempt1.sig;
  console.log("er tx paid by session (session-only signer):", erSig);
} else {
  firstAttemptError = attempt1.error;
  console.log("session-only signer attempt FAILED, raw error:", firstAttemptError);
  console.log("retrying with user added as a second signer (token-holder-must-sign hypothesis)...");
  const attempt2 = await buildAndSend([session, user]);
  if ("sig" in attempt2) {
    erSig = attempt2.sig;
    secondSignerNeeded = true;
    console.log("er tx paid by session (session + user signers):", erSig);
  } else {
    console.log("session + user signers attempt ALSO FAILED, raw error:", attempt2.error);
  }
}

if (erSig === null) {
  console.log("CHECK 9 FAIL: ER rejected session key as fee payer in both variants tried.");
  process.exit(1);
}

await tee.confirmTransaction(erSig, "confirmed");
const t = await tee.getTransaction(erSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
assert(t !== null && t.meta?.err === null, "ER tx with session key as payer succeeded");
console.log("fee charged:", t?.meta?.fee);
console.log("session balance after ER tx:", await baseConn.getBalance(session.publicKey), "(base layer; ER fee is charged on the ER, not necessarily mirrored to base)");

// 3c. Read the counter again via the USER-token connection and confirm state
// actually mutated (proves the session-paid tx wasn't a silent no-op).
const counterAfterInfo = await userTee.getAccountInfo(counterPDA);
const counterAfter = decodeCount(counterAfterInfo);
console.log("counter count AFTER (via user-token read):", counterAfter?.toString());
// private-counter's `increment` resets to 0 once it would exceed 1000.
const expectedAfter = counterBefore !== null ? (counterBefore >= 1000n ? 0n : counterBefore + 1n) : null;
assert(
  counterAfter !== null && expectedAfter !== null && counterAfter === expectedAfter,
  `counter mutated by the session-paid ER tx: before=${counterBefore} after=${counterAfter} expected=${expectedAfter}`,
);

console.log("summary:", {
  variant,
  sessionGotOwnToken,
  sessionCanReadPrivateCounter: sessionReadResult !== null && sessionReadError === "",
  secondSignerNeeded,
  baseSig,
  erSig,
  fee: t?.meta?.fee,
  counterBefore: counterBefore?.toString(),
  counterAfter: counterAfter?.toString(),
});
console.log("CHECK 9 PASS");
