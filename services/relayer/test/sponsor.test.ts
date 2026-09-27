// services/relayer/test/sponsor.test.ts
//
// `checkWhitelist` is pure (see sponsor.ts's header comment) so the
// rejection cases are exercised directly against hand-built transactions —
// no Postgres, no network. The accept/rate-limit/budget cases go through a
// real `sponsorRouter` mounted on a throwaway `express()` server (no
// supertest dependency in this package — plain `fetch` against a
// `.listen(0)` port), with `SponsorStore`/`CostEstimator` fakes injected so
// neither needs Postgres or a live RPC.
//
// Fix round 1: `fakeStore` now emulates the real `(owner, window, slot)`
// uniqueness `pgSponsorStore` gets from a UNIQUE index (finding C), with a
// plain in-memory `Set` of taken `owner:window:slot` keys — JS's
// single-threaded event loop makes a synchronous check-and-set inside
// `reserve` just as atomic as the real UNIQUE index for the
// concurrent-duplicate test below. Capacity matches the real
// `MAX_SPONSOR_CALLS_PER_OWNER_WINDOW` so the rate-limit tests exercise the
// same ceiling production does (post-verification finding: a real
// onboarding needs up to 3 sponsored legs, so a ceiling of 1 — the
// original design — could never complete one).

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction  } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { delegateSpl, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import {
  checkWhitelist,
  DEFAULT_DAILY_BUDGET_SOL,
  DEFAULT_SPONSOR_MAX_CU_PRICE_MICROLAMPORTS,
  MAX_SPONSOR_CALLS_PER_OWNER_WINDOW,
  RATE_LIMIT_MS,
  sponsorRouter,
  type CostEstimator,
  type SponsorReservation,
  type SponsorStore,
} from "../src/sponsor.js";
import { nonceAccountsFor, nonceSeedFor } from "../src/nonce.js";
import { dexxerCoreProgram, DEXXER_CORE_PROGRAM_ID } from "../../../tests/er/lib/program.js";
import { memAuthStore } from "./memAuthStore.js";

/** Relayer SIWS sessions (spec §2.7) — `send` mints one for the tx's owner signer. */
const AUTH = memAuthStore();

const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58();
/**
 * The relayer's configured dUSDC mint (`Config.dusdcMint`, read from base at
 * boot in index.ts). Week-5 final review M2: `checkWhitelist` now pins the ATA
 * shape's `mint`@3 to it, so every test that builds a SPONSORABLE ATA must use
 * this mint, and passing it is what the production wiring does.
 */
const DUSDC_MINT = Keypair.generate().publicKey;

function fakeStore(overrides: Partial<SponsorStore> = {}): SponsorStore {
  const taken = new Set<string>();
  return {
    reserve: async (owner, ts) => {
      const window = Math.floor(ts / RATE_LIMIT_MS);
      for (let slot = 0; slot < MAX_SPONSOR_CALLS_PER_OWNER_WINDOW; slot++) {
        const key = `${owner}:${window}:${slot}`;
        if (taken.has(key)) continue;
        taken.add(key);
        return { owner, ts, window, slot };
      }
      return null;
    },
    spentSince: async () => ({ lamports: 0, count: 0 }),
    finalize: async () => {},
    release: async (r) => {
      taken.delete(`${r.owner}:${r.window}:${r.slot}`);
    },
    ...overrides,
  };
}

const fixedEstimate: CostEstimator = async () => 5000;

function coreProgram(owner: Keypair) {
  return dexxerCoreProgram(
    // dexxerCoreProgram only needs a Connection for its AnchorProvider — never used to send anything in this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { commitment: "confirmed" } as any,
    owner,
  );
}

const CONFIG = PublicKey.findProgramAddressSync([Buffer.from("config")], DEXXER_CORE_PROGRAM_ID)[0];

async function buildInitUserTx(owner: Keypair, feePayer: PublicKey, payer: PublicKey = feePayer): Promise<Transaction> {
  const core = coreProgram(owner);
  const market = Keypair.generate().publicKey;
  const userAccount = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;
  const disclosureQueue = Keypair.generate().publicKey;
  const ix = await core.methods
    .initUser(Array.from(new Uint8Array(32)))
    .accounts({
      owner: owner.publicKey,
      payer,
      config: CONFIG,
      market,
      userAccount,
      position,
      disclosureQueue,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(ix);
  tx.partialSign(owner);
  return tx;
}

async function buildFaucetInitIx(owner: PublicKey, feePayer: PublicKey): Promise<TransactionInstruction> {
  const core = coreProgram(Keypair.generate());
  const mint = Keypair.generate().publicKey;
  return core.methods
    .faucetInit(new BN(0))
    .accounts({
      owner,
      payer: feePayer,
      config: CONFIG,
      faucet: Keypair.generate().publicKey,
      dusdcMint: mint,
      mintAuth: Keypair.generate().publicKey,
      ownerAta: getAssociatedTokenAddressSync(mint, owner),
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

async function buildFaucetMintIx(owner: PublicKey, mintAuthOverride?: PublicKey): Promise<TransactionInstruction> {
  const core = coreProgram(Keypair.generate());
  const mint = Keypair.generate().publicKey;
  return core.methods
    .faucetMint(new BN(100_000_000))
    .accounts({
      owner,
      config: CONFIG,
      faucet: Keypair.generate().publicKey,
      dusdcMint: mint,
      mintAuth: mintAuthOverride ?? Keypair.generate().publicKey,
      ownerAta: getAssociatedTokenAddressSync(mint, owner),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

async function buildDelegateUserIx(owner: PublicKey, payer: PublicKey): Promise<TransactionInstruction> {
  const core = coreProgram(Keypair.generate());
  const k = () => Keypair.generate().publicKey;
  return core.methods
    .delegateUser()
    .accounts({
      owner,
      payer,
      config: CONFIG,
      market: k(),
      bufferUserAccount: k(), delegationRecordUserAccount: k(), delegationMetadataUserAccount: k(), userAccount: k(),
      bufferPosition: k(), delegationRecordPosition: k(), delegationMetadataPosition: k(), position: k(),
      bufferDisclosureQueue: k(), delegationRecordDisclosureQueue: k(), delegationMetadataDisclosureQueue: k(), disclosureQueue: k(),
      ownerProgram: DEXXER_CORE_PROGRAM_ID,
      delegationProgram: k(),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function buildInitUserReuseQueueIx(owner: PublicKey, payer: PublicKey): Promise<TransactionInstruction> {
  const core = coreProgram(Keypair.generate());
  const k = () => Keypair.generate().publicKey;
  return core.methods
    .initUserReuseQueue(Array.from(new Uint8Array(32)))
    .accounts({
      owner,
      payer,
      config: CONFIG,
      market: k(),
      userAccount: k(),
      position: k(),
      disclosureQueue: k(),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function buildDelegateSplTx(owner: Keypair, feePayer: PublicKey, payer: PublicKey = feePayer): Promise<Transaction> {
  const mint = Keypair.generate().publicKey;
  const validator = Keypair.generate().publicKey;
  const ixs = await delegateSpl(owner.publicKey, mint, 1_000_000n, {
    payer,
    validator,
    initVaultIfMissing: false,
    idempotent: false,
  });
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(...ixs);
  tx.partialSign(owner);
  return tx;
}

function ownerOf(tx: Transaction): PublicKey | null {
  return tx.signatures.find((s) => !tx.feePayer || !s.publicKey.equals(tx.feePayer))?.publicKey ?? null;
}

/** POSTs `tx` with a relayer session — by default the tx's owner signer's (a random owner's when the tx has none). */
async function send(url: string, tx: Transaction, token: string | null = null): Promise<Response> {
  const owner = ownerOf(tx) ?? Keypair.generate().publicKey;
  const bearer = token ?? AUTH.sessionFor(owner.toBase58());
  return fetch(`${url}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
  });
}

test("checkWhitelist: rejects a foreign programId", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const foreignProgram = Keypair.generate().publicKey;
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(
    new TransactionInstruction({
      programId: foreignProgram,
      keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    }),
  );
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not in whitelist/);
});

test("checkWhitelist: rejects a tx the owner never signed", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildInitUserTx(owner, feePayer.publicKey);
  // Blank out the owner's signature after the fact (simulates a tx that
  // reserved the slot via `_compile()` but was never actually signed).
  tx.signatures = tx.signatures.map((s) => (s.publicKey.equals(owner.publicKey) ? { ...s, signature: null } : s));

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not signed/);
});

test("checkWhitelist: rejects tx.feePayer that does not match the relayer's fee_payer", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const someoneElse = Keypair.generate();
  const tx = await buildInitUserTx(owner, someoneElse.publicKey);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /feePayer/);
});

test("checkWhitelist: rejects a tx whose fee_payer signature slot is already filled", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildInitUserTx(owner, feePayer.publicKey);
  tx.partialSign(feePayer); // simulate a replay of an already-sponsored tx

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /already filled/);
});

test("checkWhitelist: accepts a whitelisted init_user tx (payer=fee_payer) and identifies the owner", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildInitUserTx(owner, feePayer.publicKey);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.owner.toBase58(), owner.publicKey.toBase58());
    assert.deepEqual(result.labels, ["dexxer_core:init_user"]);
  }
});

test("checkWhitelist: rejects init_user whose payer is not fee_payer", async () => {
  // `payer` is a `Signer` in the IDL, so building the ix with a random
  // pubkey there (via `dexxerCoreProgram`) would make it a SECOND required
  // signer of the compiled message and get caught by the earlier
  // "exactly one owner signer" check instead of the position check this
  // test targets. Model it the way a hand-crafted (non-Anchor-builder)
  // attack would: clone a validly-shaped ix and swap the payer slot for a
  // non-signer foreign pubkey.
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const someoneElse = Keypair.generate().publicKey;
  const validIx = (await buildInitUserTx(owner, feePayer.publicKey)).instructions[0];
  const keys = validIx.keys.map((k, i) => (i === 1 ? { pubkey: someoneElse, isSigner: false, isWritable: k.isWritable } : k));
  const tamperedIx = new TransactionInstruction({ programId: validIx.programId, keys, data: validIx.data });
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(tamperedIx);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /payer\) must be fee_payer/);
});

test("checkWhitelist: rejects fee_payer's pubkey smuggled into an instruction's owner slot", async () => {
  // Attacker signs as the real owner on ix0 (satisfying "exactly one owner
  // signer"), then smuggles a second instruction whose owner-position holds
  // fee_payer instead of the same owner.
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.add(await buildFaucetInitIx(feePayer.publicKey, feePayer.publicKey));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /owner\) must be the tx's owner signer/);
});

test("checkWhitelist: rejects fee_payer's pubkey in an ATA CreateIdempotent payer slot funding a foreign owner", async () => {
  const attacker = Keypair.generate();
  const feePayer = Keypair.generate();
  const victim = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const victimAta = getAssociatedTokenAddressSync(mint, victim);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add((await buildInitUserTx(attacker, feePayer.publicKey)).instructions[0]);
  // `payer` (index 0) = fee_payer, `owner` (index 2) = a foreign victim —
  // the repeatable rent-drain attack finding B calls out.
  tx.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, victimAta, victim, mint));
  tx.partialSign(attacker);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /ata:create_idempotent/);
});

test("checkWhitelist: rejects a duplicate init_user in the same tx", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  const ix = (await buildInitUserTx(owner, feePayer.publicKey)).instructions[0];
  tx.add(ix, ix);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /duplicate/);
});

test("checkWhitelist: accepts the delegateSpl(payer:fee_payer, idempotent:false, initVaultIfMissing:false) instruction shape", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildDelegateSplTx(owner, feePayer.publicKey);
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions.every((ix) => ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)));

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.owner.toBase58(), owner.publicKey.toBase58());
    assert.deepEqual(result.labels, ["espl:init_ephemeral_ata", "espl:transfer_to_vault", "espl:delegate_ephemeral_ata"]);
  }
});

// Week-5 Task 5: the ATA leg is now fee_payer-paid (`ATA_SHAPE = {payerIdx:
// 0, ownerIdx: 2}`) — one of the two rent costs the 0-SOL onboarding goal
// moves off the owner. `owner`@2 must still be the signing owner, which is
// what keeps it from funding a stranger's ATA (the test right below).
test("checkWhitelist: a LONE fee_payer-paid ATA has no owner signer and is rejected", async () => {
  // Making the ATA fee_payer-paid takes the owner out of that instruction's
  // signer set entirely, so on its own the transaction has no owner signature
  // for the endpoint to bind the `owner`@2 check to. It is only ever sponsored
  // as part of the L1a leg, where `faucet_init`/`init_user` supply that
  // signature (the accept case two tests below).
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const ownerAta = getAssociatedTokenAddressSync(DUSDC_MINT, owner.publicKey);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ownerAta, owner.publicKey, DUSDC_MINT));

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /owner signer/);
});

test("checkWhitelist: rejects any SystemProgram instruction", async () => {
  // Week-5 Task 5: the session top-up branch is gone — the ER leg is never
  // sponsored (devnet-tee rejects a foreign fee_payer on an ER tx), so there
  // is no shape of SystemProgram instruction this endpoint co-signs any more.
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: owner.publicKey, lamports: 1 }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not in whitelist/);
});

test("checkWhitelist: accepts init_user_reuse_queue (payer=fee_payer)", async () => {
  // The returning owner's path: the queue survived their exit, so they come
  // back through `init_user_reuse_queue` rather than `init_user`. Same
  // owner@0/payer@1 shape, so it is sponsorable on the same terms.
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildInitUserReuseQueueIx(owner.publicKey, feePayer.publicKey));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.labels, ["dexxer_core:init_user_reuse_queue"]);
});

test("checkWhitelist: rejects delegate_user whose payer is not fee_payer", async () => {
  // Same modelling as the init_user case above: a hand-crafted instruction
  // with a NON-signer foreign pubkey in the payer slot, so the "exactly one
  // owner signer" check doesn't fire first and mask the position check.
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const someoneElse = Keypair.generate().publicKey;
  const validIx = await buildDelegateUserIx(owner.publicKey, feePayer.publicKey);
  const keys = validIx.keys.map((k, i) => (i === 1 ? { pubkey: someoneElse, isSigner: false, isWritable: k.isWritable } : k));
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(new TransactionInstruction({ programId: validIx.programId, keys, data: validIx.data }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /delegate_user: account index 1 \(payer\) must be fee_payer/);
});

test("checkWhitelist: accepts a nonce-advanced faucet_mint on one of the owner's relayer-derived nonce accounts", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const [acc0] = nonceAccountsFor(feePayer.publicKey, owner.publicKey);
  assert.equal(acc0.toBase58(), (await PublicKey.createWithSeed(feePayer.publicKey, nonceSeedFor(owner.publicKey, 0), SystemProgram.programId)).toBase58());
  const mint = new Transaction({
    feePayer: feePayer.publicKey,
    nonceInfo: { nonce: FAKE_BLOCKHASH, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: acc0, authorizedPubkey: owner.publicKey }) },
  });
  mint.add(await buildFaucetMintIx(owner.publicKey));
  mint.partialSign(owner);
  // The handler sees the WIRE form (`Transaction.from(base64)`), where web3.js has already prepended the nonce-advance at compile time.
  const wire = Transaction.from(mint.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const r = checkWhitelist(wire, feePayer.publicKey, DUSDC_MINT);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.labels, ["system:advance_nonce", "dexxer_core:faucet_mint"]);
});

test("checkWhitelist: rejects nonce-advance on a foreign nonce account, with a foreign authority, or standing alone", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const [acc0] = nonceAccountsFor(feePayer.publicKey, owner.publicKey);
  const wireOf = (tx: Transaction) => Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

  const foreign = new Transaction({
    feePayer: feePayer.publicKey,
    nonceInfo: { nonce: FAKE_BLOCKHASH, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: owner.publicKey }) },
  });
  foreign.add(await buildFaucetMintIx(owner.publicKey));
  foreign.partialSign(owner);
  const r1 = checkWhitelist(wireOf(foreign), feePayer.publicKey, DUSDC_MINT);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /not one of the owner's two relayer-derived nonce accounts/);

  // authority = fee_payer would make fee_payer a required signer of the advance — and fee_payer may only appear as payer
  const badAuth = new Transaction({
    feePayer: feePayer.publicKey,
    nonceInfo: { nonce: FAKE_BLOCKHASH, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: acc0, authorizedPubkey: feePayer.publicKey }) },
  });
  badAuth.add(await buildFaucetMintIx(owner.publicKey));
  badAuth.partialSign(owner);
  const r2 = checkWhitelist(wireOf(badAuth), feePayer.publicKey, DUSDC_MINT);
  assert.equal(r2.ok, false);

  const alone = new Transaction({
    feePayer: feePayer.publicKey,
    nonceInfo: { nonce: FAKE_BLOCKHASH, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: acc0, authorizedPubkey: owner.publicKey }) },
  });
  alone.add(SystemProgram.nonceAdvance({ noncePubkey: acc0, authorizedPubkey: owner.publicKey }));
  alone.partialSign(owner);
  const r3 = checkWhitelist(wireOf(alone), feePayer.publicKey, DUSDC_MINT);
  assert.equal(r3.ok, false);
});

test("checkWhitelist: accepts faucet_mint (Deposit leg) — owner@0, fee_payer pays only the network fee", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildFaucetMintIx(owner.publicKey));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.labels, ["dexxer_core:faucet_mint"]);
});

test("checkWhitelist: rejects faucet_mint that smuggles fee_payer into a non-payer position", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildFaucetMintIx(owner.publicKey, feePayer.publicKey));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /faucet_mint: fee_payer may only appear at the payer position/);
});

test("checkWhitelist: accepts the whole L1a leg — ATA + faucet_init + init_user, all fee_payer-paid", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const mint = DUSDC_MINT;
  const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ownerAta, owner.publicKey, mint));
  tx.add(await buildFaucetInitIx(owner.publicKey, feePayer.publicKey));
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.labels, ["ata:create_idempotent", "dexxer_core:faucet_init", "dexxer_core:init_user"]);
  }
});

test("checkWhitelist: accepts the whole L1b leg — delegateSpl + delegate_user, all fee_payer-paid", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildDelegateSplTx(owner, feePayer.publicKey);
  // `buildDelegateSplTx` already signed; rebuild so the added instruction is
  // covered by the owner's signature.
  const full = new Transaction();
  full.feePayer = feePayer.publicKey;
  full.recentBlockhash = FAKE_BLOCKHASH;
  full.add(...tx.instructions, await buildDelegateUserIx(owner.publicKey, feePayer.publicKey));
  full.partialSign(owner);

  const result = checkWhitelist(full, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.labels, [
      "espl:init_ephemeral_ata",
      "espl:transfer_to_vault",
      "espl:delegate_ephemeral_ata",
      "dexxer_core:delegate_user",
    ]);
  }
});

// Week-5 final review M2: without `mint`@3 pinned, an owner could get
// `fee_payer` to fund an ATA for an ARBITRARY mint and then close it to
// reclaim the rent — a repeatable (if `SPONSOR_DAILY_SOL`-bounded) drain.
test("checkWhitelist: rejects a fee_payer-paid ATA for a mint that is not the configured dUSDC mint", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const foreignMint = Keypair.generate().publicKey;
  const ownerAta = getAssociatedTokenAddressSync(foreignMint, owner.publicKey);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ownerAta, owner.publicKey, foreignMint));
  // An owner-signed instruction alongside it, so the tx gets past the
  // owner-signer resolution and actually reaches the mint check.
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(
      result.error,
      `instruction 0: ata:create_idempotent: account index 3 (mint) must be the configured dUSDC mint ${DUSDC_MINT.toBase58()}`,
    );
  }
});

// A caller with no configured mint fails CLOSED rather than skipping the check.
test("checkWhitelist: rejects a sponsored ATA when the relayer has no configured dUSDC mint", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const ownerAta = getAssociatedTokenAddressSync(DUSDC_MINT, owner.publicKey);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ownerAta, owner.publicKey, DUSDC_MINT));
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no configured dUSDC mint/);
});

test("checkWhitelist: rejects the ATA program's non-idempotent Create instruction", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const ix = createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerAta, owner.publicKey, mint);
  const nonIdempotent = new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.alloc(0) });
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(nonIdempotent);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /CreateIdempotent/);
});

// --- ComputeBudget (fix: live Phantom smoke 24.09 — Phantom prepends these to legacy txs) ---

test("checkWhitelist: accepts an L1a batch with Phantom-prepended SetComputeUnitLimit + SetComputeUnitPrice", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const mint = DUSDC_MINT;
  const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ownerAta, owner.publicKey, mint));
  tx.add(await buildFaucetInitIx(owner.publicKey, feePayer.publicKey));
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.labels, [
      "computebudget:set_compute_unit_limit",
      "computebudget:set_compute_unit_price",
      "ata:create_idempotent",
      "dexxer_core:faucet_init",
      "dexxer_core:init_user",
    ]);
  }
});

test("checkWhitelist: rejects a SetComputeUnitPrice above SPONSOR_MAX_CU_PRICE_MICROLAMPORTS", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 600_000 }));
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT, DEFAULT_SPONSOR_MAX_CU_PRICE_MICROLAMPORTS);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(
      result.error,
      `instruction 0: ComputeBudget SetComputeUnitPrice 600000 µL exceeds SPONSOR_MAX_CU_PRICE_MICROLAMPORTS ${DEFAULT_SPONSOR_MAX_CU_PRICE_MICROLAMPORTS}`,
    );
  }
});

test("checkWhitelist: rejects RequestHeapFrame (not in the small accepted ComputeBudget surface)", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 }));
  tx.add((await buildInitUserTx(owner, feePayer.publicKey)).instructions[0]);
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /ComputeBudget instruction variant 1 not in whitelist/);
});

test("checkWhitelist: rejects a tx made ENTIRELY of ComputeBudget instructions", async () => {
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));

  const result = checkWhitelist(tx, feePayer.publicKey, DUSDC_MINT);
  assert.equal(result.ok, false);
});

// --- router (express server, in-memory store/estimator) ---

async function withServer(
  feePayer: Keypair,
  store: SponsorStore,
  fn: (url: string) => Promise<void>,
  estimateLamports: CostEstimator = fixedEstimate,
  dailyBudgetSol = DEFAULT_DAILY_BUDGET_SOL,
): Promise<void> {
  const app = express();
  app.use(sponsorRouter({ feePayer, store, estimateLamports, dailyBudgetSol, dusdcMint: DUSDC_MINT, authStore: AUTH }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("POST /sponsor: 400 on missing body", async () => {
  const feePayer = Keypair.generate();
  await withServer(feePayer, fakeStore(), async (url) => {
    const res = await fetch(`${url}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AUTH.sessionFor(Keypair.generate().publicKey.toBase58())}` },
      body: "{}",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /tx.*required/);
  });
});

test("POST /sponsor: accepts a whitelisted tx and returns it with the fee_payer signature attached", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  let finalized: { reservation: SponsorReservation; sig: string; lamports: number } | null = null;
  const store = fakeStore({
    finalize: async (reservation, sig, lamports) => {
      finalized = { reservation, sig, lamports };
    },
  });

  await withServer(feePayer, store, async (url) => {
    const tx = await buildInitUserTx(owner, feePayer.publicKey);
    const res = await send(url, tx);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tx: string };
    const out = Transaction.from(Buffer.from(body.tx, "base64"));
    const feePayerSig = out.signatures.find((s) => s.publicKey.equals(feePayer.publicKey));
    const ownerSig = out.signatures.find((s) => s.publicKey.equals(owner.publicKey));
    assert.ok(feePayerSig?.signature, "fee_payer signature must be present");
    assert.ok(ownerSig?.signature, "owner signature must still be present");
    assert.equal(out.verifySignatures(true), true, "fully-signed tx must verify");
  });

  assert.ok(finalized, "store.finalize must have been called");
  const f = finalized as unknown as { reservation: SponsorReservation; sig: string; lamports: number };
  assert.equal(f.reservation.owner, owner.publicKey.toBase58());
  assert.ok(bs58.decode(f.sig).length === 64, "recorded sig must be a valid base58-encoded 64-byte signature");
  assert.equal(f.lamports, 5000);
});

test("POST /sponsor: 400 on a non-whitelisted instruction", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  await withServer(feePayer, fakeStore(), async (url) => {
    const tx = new Transaction();
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = FAKE_BLOCKHASH;
    tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: owner.publicKey, lamports: 1 }));
    const res = await send(url, tx);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /owner signer/);
  });
});

test(`POST /sponsor: allows ${MAX_SPONSOR_CALLS_PER_OWNER_WINDOW} calls for the same owner within 60 min, rate-limits the ${MAX_SPONSOR_CALLS_PER_OWNER_WINDOW + 1}th (429)`, async () => {
  // Post-verification finding: a real onboarding needs up to 3 sponsored
  // legs (L1a, L1b, the ER leg) for the SAME owner within the same 60-minute
  // window — a ceiling of 1 (the original design) could never complete an
  // onboarding at all. This is the regression test for that.
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const store = fakeStore();

  await withServer(feePayer, store, async (url) => {
    for (let i = 0; i < MAX_SPONSOR_CALLS_PER_OWNER_WINDOW; i++) {
      const res = await send(url, await buildInitUserTx(owner, feePayer.publicKey));
      assert.equal(res.status, 200, `call ${i + 1}/${MAX_SPONSOR_CALLS_PER_OWNER_WINDOW} should succeed`);
    }
    const over = await send(url, await buildInitUserTx(owner, feePayer.publicKey));
    assert.equal(over.status, 429);
    const body = (await over.json()) as { error: string };
    assert.match(body.error, /rate limit/);
  });
});

test("POST /sponsor: two concurrent calls for the same owner's last remaining slot yield exactly one 200 and one 429", async () => {
  // Fix round 1, finding C regression: `reserve`'s atomic check-and-set must
  // hold even when both requests are in flight at once, not just when they
  // run strictly sequentially (the test above) — exhaust every slot but one
  // first, then race two requests for that last slot.
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const store = fakeStore();
  const ownerStr = owner.publicKey.toBase58();
  const now = Date.now();
  for (let i = 0; i < MAX_SPONSOR_CALLS_PER_OWNER_WINDOW - 1; i++) {
    assert.ok(await store.reserve(ownerStr, now), `pre-fill slot ${i} should succeed`);
  }

  await withServer(feePayer, store, async (url) => {
    const [a, b] = await Promise.all([
      send(url, await buildInitUserTx(owner, feePayer.publicKey)),
      send(url, await buildInitUserTx(owner, feePayer.publicKey)),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 429]);
  });
});

test("POST /sponsor: a different owner is not rate-limited by someone else's recent sponsor", async () => {
  const feePayer = Keypair.generate();
  const ownerA = Keypair.generate();
  const ownerB = Keypair.generate();
  const store = fakeStore();

  await withServer(feePayer, store, async (url) => {
    assert.equal((await send(url, await buildInitUserTx(ownerA, feePayer.publicKey))).status, 200);
    assert.equal((await send(url, await buildInitUserTx(ownerB, feePayer.publicKey))).status, 200);
  });
});

test("POST /sponsor: 400 when the daily budget would be exceeded, and the reservation is released (not rate-limited on retry)", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const store = fakeStore({ spentSince: async () => ({ lamports: Math.round(DEFAULT_DAILY_BUDGET_SOL * 1e9), count: 100 }) });

  await withServer(
    feePayer,
    store,
    async (url) => {
      const res = await send(url, await buildInitUserTx(owner, feePayer.publicKey));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /budget/);

      // finding C: a budget rejection must release the reservation, so a
      // retry in the same window isn't ALSO rate-limited.
      const retry = await send(url, await buildInitUserTx(owner, feePayer.publicKey));
      assert.equal(retry.status, 400); // still over budget, but not 429
    },
    fixedEstimate,
  );
});

// --- relayer SIWS session gate (spec §2.7) ---

test("POST /sponsor: 401 without a relayer session — no slot is reserved", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  let reserved = 0;
  const store = fakeStore({
    reserve: async (o, ts) => {
      reserved++;
      return { owner: o, ts, window: 0, slot: 0 };
    },
  });
  await withServer(feePayer, store, async (url) => {
    const tx = await buildInitUserTx(owner, feePayer.publicKey);
    const res = await fetch(`${url}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
    });
    assert.equal(res.status, 401);
    assert.equal(reserved, 0);
  });
});

test("POST /sponsor: 403 when the session belongs to someone other than the tx signer — no slot is reserved", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  let reserved = 0;
  const store = fakeStore({
    reserve: async (o, ts) => {
      reserved++;
      return { owner: o, ts, window: 0, slot: 0 };
    },
  });
  await withServer(feePayer, store, async (url) => {
    const tx = await buildInitUserTx(owner, feePayer.publicKey);
    const res = await send(url, tx, AUTH.sessionFor(Keypair.generate().publicKey.toBase58()));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /session owner/);
    assert.equal(reserved, 0);
  });
});
