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
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { delegateSpl, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import {
  checkWhitelist,
  DEFAULT_DAILY_BUDGET_SOL,
  MAX_SPONSOR_CALLS_PER_OWNER_WINDOW,
  RATE_LIMIT_MS,
  SESSION_FUND_LAMPORTS,
  sponsorRouter,
  type CostEstimator,
  type SponsorReservation,
  type SponsorStore,
} from "../src/sponsor.js";
import { dexxerCoreProgram, DEXXER_CORE_PROGRAM_ID } from "../../../tests/er/lib/program.js";

const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58();

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

async function buildInitPermissionsIx(owner: PublicKey): Promise<TransactionInstruction> {
  const core = coreProgram(Keypair.generate());
  return core.methods
    .initPermissions()
    .accounts({
      owner,
      config: CONFIG,
      market: Keypair.generate().publicKey,
      userAccount: Keypair.generate().publicKey,
      position: Keypair.generate().publicKey,
      disclosureQueue: Keypair.generate().publicKey,
      userPermission: Keypair.generate().publicKey,
      positionPermission: Keypair.generate().publicKey,
      dqPermission: Keypair.generate().publicKey,
      permissionProgram: Keypair.generate().publicKey,
      ephemeralVault: Keypair.generate().publicKey,
      magicProgram: Keypair.generate().publicKey,
    })
    .instruction();
}

async function buildSetSessionIx(owner: PublicKey, sessionKey: PublicKey): Promise<TransactionInstruction> {
  const core = coreProgram(Keypair.generate());
  return core.methods
    .setSession(sessionKey, new BN(0), 20)
    .accounts({
      owner,
      config: CONFIG,
      market: Keypair.generate().publicKey,
      userAccount: Keypair.generate().publicKey,
      position: Keypair.generate().publicKey,
      disclosureQueue: Keypair.generate().publicKey,
      userPermission: Keypair.generate().publicKey,
      positionPermission: Keypair.generate().publicKey,
      dqPermission: Keypair.generate().publicKey,
      permissionProgram: Keypair.generate().publicKey,
      ephemeralVault: Keypair.generate().publicKey,
      magicProgram: Keypair.generate().publicKey,
    })
    .instruction();
}

async function send(url: string, tx: Transaction): Promise<Response> {
  return fetch(`${url}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not in whitelist/);
});

test("checkWhitelist: rejects a lone SystemProgram transfer (no owner signer, no set_session)", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: owner.publicKey, lamports: 1_000_000_000 }));
  // Only `feePayer` is a required signer of this instruction (`from`) — no
  // owner signer exists at all, so this is rejected before the
  // SystemProgram-specific checks are even reached.

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /owner signer/);
});

test("checkWhitelist: rejects a SystemProgram transfer with no accompanying set_session", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const session = Keypair.generate().publicKey;
  const initUserIx = (await buildInitUserTx(owner, feePayer.publicKey)).instructions[0];
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  // Both instructions must be added BEFORE signing once — signing then
  // adding another instruction changes the message and invalidates the
  // signature, which would mask this test's actual assertion.
  tx.add(initUserIx, SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: session, lamports: 1_000_000 }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /without a set_session/);
});

test("checkWhitelist: rejects a SystemProgram transfer whose destination isn't set_session's session_key", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const session = Keypair.generate().publicKey;
  const wrongDestination = Keypair.generate().publicKey;
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildSetSessionIx(owner.publicKey, session));
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: wrongDestination, lamports: 1_000_000 }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /session_key argument/);
});

test("checkWhitelist: rejects a SystemProgram transfer over the session fund cap", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const session = Keypair.generate().publicKey;
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildSetSessionIx(owner.publicKey, session));
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: session, lamports: SESSION_FUND_LAMPORTS + 1 }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /exceeds the session fund cap/);
});

test("checkWhitelist: rejects a SystemProgram transfer not originating from fee_payer", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const session = Keypair.generate().publicKey;
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildSetSessionIx(owner.publicKey, session));
  tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: session, lamports: 1_000_000 }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /must originate from fee_payer/);
});

test("checkWhitelist: accepts init_permissions + set_session + the matching session top-up transfer", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const session = Keypair.generate().publicKey;
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(await buildInitPermissionsIx(owner.publicKey));
  tx.add(await buildSetSessionIx(owner.publicKey, session));
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: session, lamports: SESSION_FUND_LAMPORTS }));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.owner.toBase58(), owner.publicKey.toBase58());
    assert.deepEqual(result.labels, ["dexxer_core:init_permissions", "dexxer_core:set_session", "system:transfer"]);
  }
});

test("checkWhitelist: rejects a tx the owner never signed", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildInitUserTx(owner, feePayer.publicKey);
  // Blank out the owner's signature after the fact (simulates a tx that
  // reserved the slot via `_compile()` but was never actually signed).
  tx.signatures = tx.signatures.map((s) => (s.publicKey.equals(owner.publicKey) ? { ...s, signature: null } : s));

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not signed/);
});

test("checkWhitelist: rejects tx.feePayer that does not match the relayer's fee_payer", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const someoneElse = Keypair.generate();
  const tx = await buildInitUserTx(owner, someoneElse.publicKey);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /feePayer/);
});

test("checkWhitelist: rejects a tx whose fee_payer signature slot is already filled", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildInitUserTx(owner, feePayer.publicKey);
  tx.partialSign(feePayer); // simulate a replay of an already-sponsored tx

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /already filled/);
});

test("checkWhitelist: accepts a whitelisted init_user tx (payer=fee_payer) and identifies the owner", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildInitUserTx(owner, feePayer.publicKey);

  const result = checkWhitelist(tx, feePayer.publicKey);
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

  const result = checkWhitelist(tx, feePayer.publicKey);
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

  const result = checkWhitelist(tx, feePayer.publicKey);
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

  const result = checkWhitelist(tx, feePayer.publicKey);
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

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /duplicate/);
});

test("checkWhitelist: accepts the delegateSpl(payer:fee_payer, idempotent:false, initVaultIfMissing:false) instruction shape", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = await buildDelegateSplTx(owner, feePayer.publicKey);
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions.every((ix) => ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)));

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.owner.toBase58(), owner.publicKey.toBase58());
    assert.deepEqual(result.labels, ["espl:init_ephemeral_ata", "espl:transfer_to_vault", "espl:delegate_ephemeral_ata"]);
  }
});

test("checkWhitelist: accepts the ATA program's CreateIdempotent instruction (owner-funded, not fee_payer)", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerAta, owner.publicKey, mint));
  tx.partialSign(owner);

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.owner.toBase58(), owner.publicKey.toBase58());
    assert.deepEqual(result.labels, ["ata:create_idempotent"]);
  }
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

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /CreateIdempotent/);
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
  app.use(sponsorRouter({ feePayer, store, estimateLamports, dailyBudgetSol }));
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
    const res = await fetch(`${url}/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
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
