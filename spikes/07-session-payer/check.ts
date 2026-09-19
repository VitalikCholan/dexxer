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
// no rebuild/redeploy). So we always run the fallback variant:
//   - TEE auth token obtained with the USER key (the only permission member)
//   - SESSION key is still the fee payer and signer of the ER transaction
// We *also* attempt getAuthToken with the session key first, to record the
// raw auth/permission error as direct evidence for "must session key be a
// member" (spec §5.4 assumes yes).
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
const createTx = await stm.program.methods
  .createSessionV2(true, new BN(expiry), new BN(0.005 * web3.LAMPORTS_PER_SOL))
  .accounts({
    targetProgram: program.programId,
    sessionSigner: session.publicKey,
    feePayer: user.publicKey,
    authority: user.publicKey,
  })
  .transaction();
const baseSig = await baseProvider.sendAndConfirm(createTx, [session]);
console.log("createSessionV2 sig:", baseSig);
const sessionBalanceAfterTopUp = await baseConn.getBalance(session.publicKey);
console.log("session balance after top-up:", sessionBalanceAfterTopUp);
assert(sessionBalanceAfterTopUp > 0, "session key received lamports from createSessionV2 top-up (no separate base airdrop)");

// 2a. Does the session key itself get a TEE auth token? Expected to fail:
// it is not a permission member (see header comment).
let sessionGotOwnToken = false;
let sessionAuthError = "";
try {
  const sTok = await getAuthToken(TEE_RPC, session.publicKey, (m) =>
    Promise.resolve(nacl.sign.detached(m, session.secretKey)),
  );
  sessionGotOwnToken = true;
  console.log("session key obtained its own TEE token (unexpected):", sTok.token.slice(0, 24) + "...");
} catch (e) {
  sessionAuthError = String((e as any)?.message ?? e);
  console.log("session key getAuthToken FAILED (expected — not a permission member):", sessionAuthError);
}

// 2b. Fallback: obtain the TEE token with the USER key (the only member),
// but keep SESSION as the fee payer / signer of the ER tx below.
let variant: "session-token" | "user-token" = sessionGotOwnToken ? "session-token" : "user-token";
const authKeypair = sessionGotOwnToken ? session : user;
const authToken = await getAuthToken(TEE_RPC, authKeypair.publicKey, (m) =>
  Promise.resolve(nacl.sign.detached(m, authKeypair.secretKey)),
);
console.log(`variant: ${variant} (TEE token owner: ${authKeypair.publicKey.toBase58()})`);
const tee = new web3.Connection(`${TEE_RPC}?token=${authToken.token}`, {
  wsEndpoint: `${TEE_WS}?token=${authToken.token}`,
  commitment: "confirmed",
});

// 3. session key is fee payer of an ER tx. Try session-only signer first;
// if the TEE rejects it because the tx isn't signed by the auth-token owner,
// retry adding `user` as a second signer (documented either way).
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
console.log("summary:", {
  variant,
  sessionGotOwnToken,
  secondSignerNeeded,
  baseSig,
  erSig,
  fee: t?.meta?.fee,
});
console.log("CHECK 9 PASS");
