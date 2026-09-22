// services/relayer/test/sponsor.test.ts
//
// `checkWhitelist` is pure (see sponsor.ts's header comment) so the
// rejection cases are exercised directly against hand-built transactions —
// no Postgres, no network. The accept/rate-limit cases go through a real
// `sponsorRouter` mounted on a throwaway `express()` server (no supertest
// dependency in this package — plain `fetch` against a `.listen(0)` port),
// with `SponsorStore`/`CostEstimator` fakes injected so neither needs
// Postgres or a live RPC (per the task-6 brief: "keep the store behind an
// interface so tests need no Postgres").

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { delegateSpl, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import {
  checkWhitelist,
  DAY_MS,
  DEFAULT_DAILY_BUDGET_SOL,
  RATE_LIMIT_MS,
  sponsorRouter,
  type CostEstimator,
  type SponsorStore,
} from "../src/sponsor.js";
import { dexxerCoreProgram, DEXXER_CORE_PROGRAM_ID } from "../../../tests/er/lib/program.js";

const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58();

function fakeStore(overrides: Partial<SponsorStore> = {}): SponsorStore {
  return {
    lastSponsorAt: async () => null,
    spentSince: async () => ({ lamports: 0, count: 0 }),
    record: async () => {},
    ...overrides,
  };
}

const fixedEstimate: CostEstimator = async () => 5000;

async function buildInitUserTx(owner: Keypair, feePayer: PublicKey): Promise<Transaction> {
  const core = dexxerCoreProgram(
    // dexxerCoreProgram only needs a Connection for its AnchorProvider — never used to send anything in this test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { commitment: "confirmed" } as any,
    owner,
  );
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], DEXXER_CORE_PROGRAM_ID)[0];
  const market = Keypair.generate().publicKey;
  const userAccount = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;
  const disclosureQueue = Keypair.generate().publicKey;
  const ix = await core.methods
    .initUser(Array.from(new Uint8Array(32)))
    .accounts({
      owner: owner.publicKey,
      config,
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

async function buildDelegateSplTx(owner: Keypair, feePayer: PublicKey): Promise<Transaction> {
  const mint = Keypair.generate().publicKey;
  const validator = Keypair.generate().publicKey;
  const ixs = await delegateSpl(owner.publicKey, mint, 1_000_000n, {
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

test("checkWhitelist: rejects any SystemProgram instruction", async () => {
  const owner = Keypair.generate();
  const feePayer = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = FAKE_BLOCKHASH;
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: owner.publicKey, lamports: 1_000_000_000 }));
  // No signature needed: the SystemProgram check fires while scanning
  // instructions, before signer-consistency/ownership is even considered.

  const result = checkWhitelist(tx, feePayer.publicKey);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /SystemProgram/);
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

test("checkWhitelist: accepts a whitelisted init_user tx and identifies the owner", async () => {
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

test("checkWhitelist: accepts the delegateSpl(idempotent:false, initVaultIfMissing:false) instruction shape", async () => {
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
  let recorded: { owner: string; ts: number; sig: string; lamports: number } | null = null;
  const store = fakeStore({
    record: async (o, ts, sig, lamports) => {
      recorded = { owner: o, ts, sig, lamports };
    },
  });

  await withServer(feePayer, store, async (url) => {
    const tx = await buildInitUserTx(owner, feePayer.publicKey);
    const res = await fetch(`${url}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tx: string };
    const out = Transaction.from(Buffer.from(body.tx, "base64"));
    const feePayerSig = out.signatures.find((s) => s.publicKey.equals(feePayer.publicKey));
    const ownerSig = out.signatures.find((s) => s.publicKey.equals(owner.publicKey));
    assert.ok(feePayerSig?.signature, "fee_payer signature must be present");
    assert.ok(ownerSig?.signature, "owner signature must still be present");
    assert.equal(out.verifySignatures(true), true, "fully-signed tx must verify");
  });

  assert.ok(recorded, "store.record must have been called");
  const r = recorded as unknown as { owner: string; sig: string; lamports: number };
  assert.equal(r.owner, owner.publicKey.toBase58());
  assert.ok(bs58.decode(r.sig).length === 64, "recorded sig must be a valid base58-encoded 64-byte signature");
  assert.equal(r.lamports, 5000);
});

test("POST /sponsor: 400 on a non-whitelisted instruction", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  await withServer(feePayer, fakeStore(), async (url) => {
    const tx = new Transaction();
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = FAKE_BLOCKHASH;
    tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: owner.publicKey, lamports: 1 }));
    const res = await fetch(`${url}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /SystemProgram/);
  });
});

test("POST /sponsor: rate-limits a second call for the same owner within 60 min (429)", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const lastCall = { at: null as number | null };
  const store = fakeStore({
    lastSponsorAt: async (o) => (o === owner.publicKey.toBase58() ? lastCall.at : null),
    record: async (_o, ts) => {
      lastCall.at = ts;
    },
  });

  await withServer(feePayer, store, async (url) => {
    const send = async () => {
      const tx = await buildInitUserTx(owner, feePayer.publicKey);
      return fetch(`${url}/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
      });
    };
    const first = await send();
    assert.equal(first.status, 200);

    const second = await send();
    assert.equal(second.status, 429);
    const body = (await second.json()) as { error: string };
    assert.match(body.error, /rate limit/);
  });
});

test("POST /sponsor: a different owner is not rate-limited by someone else's recent sponsor", async () => {
  const feePayer = Keypair.generate();
  const ownerA = Keypair.generate();
  const ownerB = Keypair.generate();
  const calls = new Map<string, number>();
  const store = fakeStore({
    lastSponsorAt: async (o) => calls.get(o) ?? null,
    record: async (o, ts) => {
      calls.set(o, ts);
    },
  });

  await withServer(feePayer, store, async (url) => {
    const send = async (owner: Keypair) => {
      const tx = await buildInitUserTx(owner, feePayer.publicKey);
      return fetch(`${url}/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
      });
    };
    assert.equal((await send(ownerA)).status, 200);
    assert.equal((await send(ownerB)).status, 200);
  });
});

test("POST /sponsor: 400 when the daily budget would be exceeded", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const store = fakeStore({ spentSince: async () => ({ lamports: Math.round(DEFAULT_DAILY_BUDGET_SOL * 1e9), count: 100 }) });

  await withServer(
    feePayer,
    store,
    async (url) => {
      const tx = await buildInitUserTx(owner, feePayer.publicKey);
      const res = await fetch(`${url}/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /budget/);
    },
    fixedEstimate,
  );
});

void DAY_MS;
void RATE_LIMIT_MS;
