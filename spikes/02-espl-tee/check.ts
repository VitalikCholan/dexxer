// spikes/02-espl-tee/check.ts
//
// Check 2: Ephemeral SPL Token inside the TEE.
// Proves: deposit+delegate (delegateSpl) on base -> transferSpl between two
// owners inside the TEE ephemeral rollup -> balances readable on the ER.
// Also probes whether a non-owner (stranger, with its own TEE auth token) can
// read another owner's ER token account balance (spec §2.1: "margin is
// accounting, not tokens" — i.e. SPL balances are NOT expected to be private
// by themselves; privacy has to come from elsewhere in the design).
//
// Deviations from the brief's illustrative script (recorded in RESULT.md):
//  - delegateSpl called with `idempotent: false` (matches the brief and the
//    SDK's example test). In that code path `initAtasIfMissing` is not read
//    by the SDK at all (verified against ephemeralAta.js) — the base ATA
//    must already exist, which step 1 guarantees via
//    getOrCreateAssociatedTokenAccount. We drop the unused option instead of
//    passing a no-op key.
//  - `initVaultIfMissing` is true ONLY for the first owner delegated (user).
//    The SDK's own spl-tokens.ts test explicitly does this ("A's delegation
//    creates the shared vault for this mint; B reuses it.") — calling
//    initVaultIx a second time for the same mint's shared vault is not
//    something the reference test does, so we follow it rather than the
//    brief's literal loop (which sets initVaultIfMissing: true for both).
//  - We poll (getAccount, 500ms x up to 60 tries) after delegation and after
//    the ER transfer before asserting balances, because the SDK's own test
//    comments warn that "base-layer delegation can confirm before the ER has
//    cloned the token account."
//  - The TEE connections used for sending/confirming the ER transfer include
//    an explicit `wsEndpoint` carrying the same auth token (as Task 3's
//    check.ts does for its ER provider) rather than relying on web3.js's
//    default http->ws URL derivation, to avoid confirmTransaction hangs.
//  - Pool's deposit is attempted at 0n first (as the brief allows). Pool's
//    base ATA is pre-funded with a small mint (10_000_000n) so that if the
//    SDK/program rejects a zero-amount deposit we can immediately retry with
//    1_000_000n without another round trip. Expected balances below are
//    computed from the actual deposited amount, not hardcoded.

import { web3 } from "@coral-xyz/anchor";
import { Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";
import { delegateSpl, transferSpl, deriveRentPda, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { baseConn, TEE_RPC, TEE_WS, TEE_VALIDATOR, loadKeypair, assert } from "../lib/env.js";

const payer = loadKeypair("payer");
const user = loadKeypair("user");
const pool = loadKeypair("stranger"); // "pool" = second owner = also the "stranger" identity used for the read-probe

function authedConn(token: string): web3.Connection {
  return new web3.Connection(`${TEE_RPC}?token=${token}`, {
    wsEndpoint: `${TEE_WS}?token=${token}`,
    commitment: "confirmed",
  });
}

async function waitForErBalance(conn: web3.Connection, ata: web3.PublicKey, expected: bigint, label: string) {
  let last = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const acct = await getAccount(conn, ata);
      if (acct.amount === expected) {
        console.log(`ok (poll): ${label} = ${acct.amount} (attempt ${attempt})`);
        return acct;
      }
      last = `amount=${acct.amount}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${label} == ${expected}: last=${last}`);
}

async function main() {
  // 1. mint + ATAs + fund user (and a small buffer for pool in case the 0n deposit is rejected)
  const mint = await createMint(baseConn, payer, payer.publicKey, null, 6);
  const userAta = await getOrCreateAssociatedTokenAccount(baseConn, payer, mint, user.publicKey);
  const poolAta = await getOrCreateAssociatedTokenAccount(baseConn, payer, mint, pool.publicKey);
  await mintTo(baseConn, payer, mint, userAta.address, payer, 1_000_000_000n); // 1000 dUSDC
  await mintTo(baseConn, payer, mint, poolAta.address, payer, 10_000_000n); // 10 dUSDC buffer for pool
  console.log("mint", mint.toBase58());
  console.log("userAta", userAta.address.toBase58());
  console.log("poolAta", poolAta.address.toBase58());

  // 2. fund rent PDA (shuttle rent) once, only if below threshold
  const [rentPda] = deriveRentPda();
  const rentBal = await baseConn.getBalance(rentPda);
  console.log("rentPda", rentPda.toBase58(), "balance", rentBal / LAMPORTS_PER_SOL, "SOL");
  if (rentBal < 0.1 * LAMPORTS_PER_SOL) {
    const sig = await web3.sendAndConfirmTransaction(
      baseConn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentPda, lamports: 0.2 * LAMPORTS_PER_SOL })),
      [payer],
    );
    console.log("funded rentPda", sig);
  }

  // 3. deposit+delegate both owners to the TEE validator (base).
  // First owner (user) creates the shared per-mint vault; second owner (pool)
  // reuses it (initVaultIfMissing: false) — see deviation notes above.
  const userDeposit = 500_000_000n;
  const userIxs = await delegateSpl(user.publicKey, mint, userDeposit, {
    validator: TEE_VALIDATOR,
    payer: payer.publicKey,
    initVaultIfMissing: true,
    idempotent: false,
  });
  const userDelegateSig = await web3.sendAndConfirmTransaction(baseConn, new Transaction().add(...userIxs), [user, payer], { commitment: "confirmed" });
  console.log("delegateSpl user", user.publicKey.toBase58(), userDelegateSig);

  let poolDeposit = 0n;
  let poolDelegateSig: string;
  try {
    const poolIxs = await delegateSpl(pool.publicKey, mint, poolDeposit, {
      validator: TEE_VALIDATOR,
      payer: payer.publicKey,
      initVaultIfMissing: false,
      idempotent: false,
    });
    poolDelegateSig = await web3.sendAndConfirmTransaction(baseConn, new Transaction().add(...poolIxs), [pool, payer], { commitment: "confirmed" });
    console.log("delegateSpl pool (deposit 0)", pool.publicKey.toBase58(), poolDelegateSig);
  } catch (e) {
    console.log("delegateSpl pool with 0n deposit FAILED, retrying with 1_000_000n. raw error:", e);
    poolDeposit = 1_000_000n;
    const poolIxs = await delegateSpl(pool.publicKey, mint, poolDeposit, {
      validator: TEE_VALIDATOR,
      payer: payer.publicKey,
      initVaultIfMissing: false,
      idempotent: false,
    });
    poolDelegateSig = await web3.sendAndConfirmTransaction(baseConn, new Transaction().add(...poolIxs), [pool, payer], { commitment: "confirmed" });
    console.log("delegateSpl pool (deposit 1_000_000)", pool.publicKey.toBase58(), poolDelegateSig);
  }

  // 4. TEE auth tokens + connections for both owners.
  const userTok = (await getAuthToken(TEE_RPC, user.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, user.secretKey)))).token;
  const poolTok = (await getAuthToken(TEE_RPC, pool.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, pool.secretKey)))).token;
  const teeUser = authedConn(userTok);
  const teePool = authedConn(poolTok);

  const userAtaAddr = getAssociatedTokenAddressSync(mint, user.publicKey);
  const poolAtaAddr = getAssociatedTokenAddressSync(mint, pool.publicKey);

  // Wait for the ER to have cloned the delegated deposits before transferring.
  await waitForErBalance(teeUser, userAtaAddr, userDeposit, "user ER balance (post-delegate)");
  await waitForErBalance(teePool, poolAtaAddr, poolDeposit, "pool ER balance (post-delegate)");

  // 5. transfer inside the TEE ER as user
  const transferAmount = 100_000_000n;
  const transferIxs = await transferSpl(user.publicKey, pool.publicKey, mint, transferAmount, {
    visibility: "public",
    fromBalance: "ephemeral",
    toBalance: "ephemeral",
  });
  const tx = new Transaction().add(...transferIxs);
  tx.feePayer = user.publicKey;
  tx.recentBlockhash = (await teeUser.getLatestBlockhash()).blockhash;
  tx.sign(user);
  const erSig = await teeUser.sendRawTransaction(tx.serialize());
  await teeUser.confirmTransaction(erSig, "confirmed");
  console.log("er transfer", erSig);

  // 6. balances on ER (each owner reading its own token account via its own auth token)
  const expectedUserErBal = userDeposit - transferAmount;
  const expectedPoolErBal = poolDeposit + transferAmount;
  const userAtaEr = await waitForErBalance(teeUser, userAtaAddr, expectedUserErBal, "user ER balance (post-transfer)");
  const poolAtaEr = await waitForErBalance(teePool, poolAtaAddr, expectedPoolErBal, "pool ER balance (post-transfer)");
  console.log("ER balances user/pool:", userAtaEr.amount, poolAtaEr.amount);
  assert(poolAtaEr.amount === expectedPoolErBal, `pool ER balance = ${expectedPoolErBal} after transfer`);
  assert(userAtaEr.amount === expectedUserErBal, `user ER balance = ${expectedUserErBal}`);

  // 7. Extra probe: can "stranger" (pool's own auth token, i.e. a non-owner of
  // the user's ATA) read the USER's ER token account? Record the raw result
  // either way — this decides spec §2.1's "margin is accounting, not tokens"
  // rule: if SPL balances are readable cross-owner, token-level custody alone
  // does not give privacy and margin/position accounting must be hidden by a
  // separate mechanism (the private counter / PER account, not the token).
  let strangerReadOk = false;
  let strangerReadRaw: unknown;
  try {
    const viaStranger = await getAccount(teePool, userAtaAddr);
    strangerReadOk = true;
    strangerReadRaw = { amount: viaStranger.amount.toString(), owner: viaStranger.owner.toBase58(), mint: viaStranger.mint.toBase58() };
    console.log("stranger read of user's ER ATA SUCCEEDED:", strangerReadRaw);
  } catch (e) {
    strangerReadRaw = String(e);
    console.log("stranger read of user's ER ATA FAILED:", strangerReadRaw);
  }

  console.log("CHECK 2 PASS", {
    mint: mint.toBase58(),
    userDelegateSig,
    poolDelegateSig,
    erSig,
    userDeposit: userDeposit.toString(),
    poolDeposit: poolDeposit.toString(),
    transferAmount: transferAmount.toString(),
    userErBalance: userAtaEr.amount.toString(),
    poolErBalance: poolAtaEr.amount.toString(),
    strangerReadOk,
    strangerReadRaw,
  });
}

main().catch((e) => {
  console.error("CHECK 2 FAIL (raw error below)");
  console.error(e);
  if (e?.logs) console.error("logs:", e.logs);
  if (String(e).includes("0x7") || String(e).includes("EphemeralAtaValidatorMismatch")) {
    console.error(
      "EphemeralAtaValidatorMismatch (0x7): one of the owner ATAs was already delegated to a different validator earlier. Do not create new keys — report this to the RESULT.md as a spike blocker.",
    );
  }
  process.exit(1);
});
