// services/relayer/test/nonce.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createNonceInstructions, createWithSeedSync, nonceAccountsFor, nonceRouter, nonceSeedFor, type NonceConn } from "../src/nonce.js";
import type { SponsorStore } from "../src/sponsor.js";
import { memAuthStore } from "./memAuthStore.js";

/** Relayer SIWS sessions (spec §2.7) — the owner comes from the session. */
const AUTH = memAuthStore();

function postNonce(url: string, sessionOwner: PublicKey | null, body: unknown): Promise<Response> {
  return fetch(`${url}/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sessionOwner ? { authorization: `Bearer ${AUTH.sessionFor(sessionOwner.toBase58())}` } : {}) },
    body: JSON.stringify(body),
  });
}

test("nonceSeedFor: ≤ 32 bytes, distinct per slot, deterministic", () => {
  const owner = Keypair.generate().publicKey;
  const s0 = nonceSeedFor(owner, 0);
  const s1 = nonceSeedFor(owner, 1);
  assert.ok(Buffer.byteLength(s0) <= 32 && Buffer.byteLength(s1) <= 32);
  assert.notEqual(s0, s1);
  assert.equal(s0, nonceSeedFor(owner, 0));
});

test("createWithSeedSync matches web3.js PublicKey.createWithSeed", async () => {
  const base = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const seed = nonceSeedFor(owner, 1);
  assert.equal(createWithSeedSync(base, seed).toBase58(), (await PublicKey.createWithSeed(base, seed, SystemProgram.programId)).toBase58());
});

test("createNonceInstructions: create(from=base=fee_payer, 80 bytes, System) + init(authority=owner) per missing slot", () => {
  const feePayer = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const ixs = createNonceInstructions(feePayer, owner, [0, 1], 1_447_680);
  assert.equal(ixs.length, 4);
  const [acc0, acc1] = nonceAccountsFor(feePayer, owner);
  assert.ok(ixs[0].keys[1].pubkey.equals(acc0));
  assert.ok(ixs[2].keys[1].pubkey.equals(acc1));
  assert.ok(ixs[0].keys[0].pubkey.equals(feePayer));
  assert.equal(ixs[0].data.length > 0, true);
  assert.equal(NONCE_ACCOUNT_LENGTH, 80);
});

function fakeStore(): SponsorStore & { reserved: number; finalized: number; released: number } {
  const st = {
    reserved: 0,
    finalized: 0,
    released: 0,
    async reserve(owner: string, ts: number) {
      st.reserved++;
      return { owner, ts, window: 0, slot: 0 };
    },
    async spentSince() {
      return { lamports: 0, count: 0 };
    },
    async finalize() {
      st.finalized++;
    },
    async release() {
      st.released++;
    },
  };
  return st;
}

function fakeConn(existing: Set<string>, owner: PublicKey): NonceConn & { sent: Transaction[] } {
  const conn = {
    sent: [] as Transaction[],
    async getNonce(account: PublicKey) {
      if (!existing.has(account.toBase58())) return null;
      return { nonce: "NonceValue1111111111111111111111111111111111", authorizedPubkey: owner, feeCalculator: { lamportsPerSignature: 5000 } } as never;
    },
    async getMinimumBalanceForRentExemption() {
      return 1_447_680;
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 } as never;
    },
    async sendRawTransaction(raw: Buffer | Uint8Array | number[]) {
      const tx = Transaction.from(raw as Buffer);
      conn.sent.push(tx);
      for (const ix of tx.instructions) if (ix.keys.length > 1 && ix.programId.equals(SystemProgram.programId)) existing.add(ix.keys[1].pubkey.toBase58());
      return "SigFake111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    },
    async getSignatureStatuses() {
      return { context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] } as never;
    },
  };
  return conn;
}

async function withServer(router: express.Router, fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(router);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("POST /nonce: creates both accounts once (fee_payer-signed, authority=owner), then is idempotent and free", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const existing = new Set<string>();
  const conn = fakeConn(existing, owner.publicKey);
  const store = fakeStore();
  await withServer(nonceRouter({ conn, feePayer, store, dailyBudgetLamports: 500_000_000, authStore: AUTH }), async (url) => {
    const r1 = await postNonce(url, owner.publicKey, { owner: owner.publicKey.toBase58() });
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as { created: boolean; nonces: { account: string; nonce: string | null }[] };
    assert.equal(b1.created, true);
    assert.equal(conn.sent.length, 1);
    assert.equal(conn.sent[0].instructions.length, 4);
    assert.ok(conn.sent[0].feePayer?.equals(feePayer.publicKey));
    assert.ok(conn.sent[0].verifySignatures());
    const [acc0, acc1] = nonceAccountsFor(feePayer.publicKey, owner.publicKey);
    assert.deepEqual(b1.nonces.map((n) => n.account), [acc0.toBase58(), acc1.toBase58()]);
    assert.ok(b1.nonces.every((n) => n.nonce !== null));
    assert.equal(store.reserved, 1);
    assert.equal(store.finalized, 1);

    const r2 = await postNonce(url, owner.publicKey, { owner: owner.publicKey.toBase58() });
    const b2 = (await r2.json()) as { created: boolean };
    assert.equal(r2.status, 200);
    assert.equal(b2.created, false);
    assert.equal(conn.sent.length, 1);
    assert.equal(store.reserved, 1);
  });
});

test("POST /nonce: 400 on a bad owner; 429 when the owner's sponsor slots are exhausted", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const conn = fakeConn(new Set(), owner.publicKey);
  const store = fakeStore();
  store.reserve = async () => null;
  await withServer(nonceRouter({ conn, feePayer, store, dailyBudgetLamports: 500_000_000, authStore: AUTH }), async (url) => {
    const bad = await postNonce(url, owner.publicKey, { owner: "nope" });
    assert.equal(bad.status, 400);
    const limited = await postNonce(url, owner.publicKey, { owner: owner.publicKey.toBase58() });
    assert.equal(limited.status, 429);
    assert.equal(conn.sent.length, 0);
  });
});

test("POST /nonce: 401 without a relayer session — nothing reserved, nothing sent", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const conn = fakeConn(new Set(), owner.publicKey);
  const store = fakeStore();
  await withServer(nonceRouter({ conn, feePayer, store, dailyBudgetLamports: 500_000_000, authStore: AUTH }), async (url) => {
    const res = await postNonce(url, null, { owner: owner.publicKey.toBase58() });
    assert.equal(res.status, 401);
    assert.equal(store.reserved, 0);
    assert.equal(conn.sent.length, 0);
  });
});

test("POST /nonce: owner comes from the session; a different body.owner is 403", async () => {
  const feePayer = Keypair.generate();
  const owner = Keypair.generate();
  const conn = fakeConn(new Set(), owner.publicKey);
  const store = fakeStore();
  await withServer(nonceRouter({ conn, feePayer, store, dailyBudgetLamports: 500_000_000, authStore: AUTH }), async (url) => {
    const foreign = await postNonce(url, owner.publicKey, { owner: Keypair.generate().publicKey.toBase58() });
    assert.equal(foreign.status, 403);
    assert.equal(conn.sent.length, 0);
    const implicit = await postNonce(url, owner.publicKey, {});
    assert.equal(implicit.status, 200);
    const b = (await implicit.json()) as { owner: string; created: boolean };
    assert.equal(b.owner, owner.publicKey.toBase58());
    assert.equal(b.created, true);
  });
});
