// services/relayer/test/auth.test.ts
//
// SIWS sessions (spec §2.7): `verifySiws` is pure and tested directly; the
// challenge/siws round-trip and `requireSession` go through a real
// `authRouter` on a throwaway express server with the in-memory store, and
// messages are signed with plain keypairs via the reference SIWS encoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createSignInMessage } from "@solana/wallet-standard-util";
import {
  CHALLENGE_TTL_MS,
  MAX_OPEN_CHALLENGES,
  SIWS_STATEMENT,
  authRouter,
  hashToken,
  requireSession,
  verifySiws,
  type AuthStore,
} from "../src/auth.js";
import { memAuthStore } from "./memAuthStore.js";

const DOMAIN = "relayer.example.test";
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const TTL_MS = 168 * 60 * 60 * 1000;

interface SiwsFields {
  domain?: string;
  address?: string;
  uri?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
}

function siwsMessage(kp: Keypair, f: SiwsFields = {}): Uint8Array {
  return createSignInMessage({
    domain: f.domain ?? DOMAIN,
    address: f.address ?? kp.publicKey.toBase58(),
    statement: SIWS_STATEMENT,
    uri: f.uri ?? `https://${DOMAIN}`,
    version: "1",
    nonce: f.nonce ?? "0123456789abcdef0123456789abcdef",
    issuedAt: f.issuedAt ?? new Date(NOW).toISOString(),
    ...(f.expirationTime ? { expirationTime: f.expirationTime } : {}),
    ...(f.notBefore ? { notBefore: f.notBefore } : {}),
  });
}

function signed(kp: Keypair, f: SiwsFields = {}, signer: Keypair = kp) {
  const signedMessage = siwsMessage(kp, f);
  return { address: kp.publicKey.toBase58(), signedMessage, signature: nacl.sign.detached(signedMessage, signer.secretKey) };
}

function asBody(s: { address: string; signedMessage: Uint8Array; signature: Uint8Array }) {
  return {
    address: s.address,
    signedMessage: Buffer.from(s.signedMessage).toString("base64"),
    signature: Buffer.from(s.signature).toString("base64"),
  };
}

// --- verifySiws (pure) ---

test("verifySiws: accepts a well-formed message signed by its address", () => {
  const kp = Keypair.generate();
  const r = verifySiws(signed(kp), DOMAIN, NOW);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.owner.equals(kp.publicKey));
    assert.equal(r.nonce, "0123456789abcdef0123456789abcdef");
  }
});

test("verifySiws: 400 when the bytes are not a SIWS message", () => {
  const kp = Keypair.generate();
  const msg = new TextEncoder().encode("hello");
  const r = verifySiws({ address: kp.publicKey.toBase58(), signedMessage: msg, signature: nacl.sign.detached(msg, kp.secretKey) }, DOMAIN, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.match(r.error, /Sign-In With Solana/);
  }
});

const REJECTIONS: [string, (kp: Keypair) => { address: string; signedMessage: Uint8Array; signature: Uint8Array }, RegExp][] = [
  ["another domain", (kp) => signed(kp, { domain: "evil.example" }), /domain/],
  ["a uri on another host", (kp) => signed(kp, { uri: "https://evil.example" }), /uri/],
  ["a message for a different address than body.address", (kp) => ({ ...signed(kp), address: Keypair.generate().publicKey.toBase58() }), /address/],
  ["issuedAt 6 minutes old", (kp) => signed(kp, { issuedAt: new Date(NOW - 6 * 60 * 1000).toISOString() }), /issuedAt/],
  ["an expirationTime in the past", (kp) => signed(kp, { expirationTime: new Date(NOW - 1000).toISOString() }), /expired/],
  ["a notBefore in the future", (kp) => signed(kp, { notBefore: new Date(NOW + 60_000).toISOString() }), /not yet valid/],
  ["a signature by another key", (kp) => signed(kp, {}, Keypair.generate()), /invalid signature/],
  [
    "a 128-byte message‖signature blob",
    (kp) => {
      const s = signed(kp);
      return { ...s, signature: Buffer.concat([Buffer.from(s.signedMessage.slice(0, 64)), Buffer.from(s.signature)]) };
    },
    /64 bytes/,
  ],
];
for (const [label, make, re] of REJECTIONS) {
  test(`verifySiws: 401 on ${label}`, () => {
    const r = verifySiws(make(Keypair.generate()), DOMAIN, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.match(r.error, re);
    }
  });
}

test("verifySiws: 401 when the message carries no nonce", () => {
  const kp = Keypair.generate();
  const msg = createSignInMessage({ domain: DOMAIN, address: kp.publicKey.toBase58(), uri: `https://${DOMAIN}`, version: "1", issuedAt: new Date(NOW).toISOString() });
  const r = verifySiws({ address: kp.publicKey.toBase58(), signedMessage: msg, signature: nacl.sign.detached(msg, kp.secretKey) }, DOMAIN, NOW);
  assert.equal(r.ok ? 0 : r.status, 401);
});

// --- router ---

async function withAuthServer(store: AuthStore, now: () => number, fn: (url: string) => Promise<void>) {
  const app = express();
  app.use(authRouter({ store, domain: DOMAIN, sessionTtlMs: TTL_MS, now }));
  app.get("/whoami", requireSession(store, now), (_req, res) => {
    res.json({ owner: res.locals.sessionOwner.toBase58() });
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function challenge(url: string) {
  const res = await fetch(`${url}/auth/challenge`, { method: "POST" });
  assert.equal(res.status, 200);
  return (await res.json()) as { nonce: string; issuedAt: string; expirationTime: string; domain: string; uri: string; statement: string; version: string };
}

function postSiws(url: string, body: unknown) {
  return fetch(`${url}/auth/siws`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("POST /auth/challenge → /auth/siws issues a session; only sha256(token) is stored", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const c = await challenge(url);
    assert.match(c.nonce, /^[0-9a-f]{32}$/);
    assert.equal(c.domain, DOMAIN);
    assert.equal(c.uri, `https://${DOMAIN}`);
    assert.equal(Date.parse(c.expirationTime) - Date.parse(c.issuedAt), CHALLENGE_TTL_MS);
    const res = await postSiws(url, asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt, expirationTime: c.expirationTime })));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; owner: string; expiresAt: number };
    assert.equal(body.owner, kp.publicKey.toBase58());
    assert.equal(body.expiresAt, NOW + TTL_MS);
    assert.ok(store.sessions.has(hashToken(body.token)));
    assert.ok(![...store.sessions.keys()].includes(body.token));
    const who = await fetch(`${url}/whoami`, { headers: { authorization: `Bearer ${body.token}` } });
    assert.deepEqual(await who.json(), { owner: kp.publicKey.toBase58() });
  });
});

test("POST /auth/siws: replaying the same signed message is rejected (single-use nonce)", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const c = await challenge(url);
    const body = asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt }));
    const [a, b] = await Promise.all([postSiws(url, body), postSiws(url, body)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 401]);
  });
});

test("POST /auth/siws: a bad signature does not burn the nonce", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const c = await challenge(url);
    const bad = await postSiws(url, asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt }, Keypair.generate())));
    assert.equal(bad.status, 401);
    const good = await postSiws(url, asBody(signed(kp, { nonce: c.nonce, issuedAt: c.issuedAt })));
    assert.equal(good.status, 200);
  });
});

test("POST /auth/siws: 401 on a nonce the relayer never issued, and on an expired challenge", async () => {
  const store = memAuthStore();
  const kp = Keypair.generate();
  await withAuthServer(store, () => NOW, async (url) => {
    const unknown = await postSiws(url, asBody(signed(kp, { nonce: "ffffffffffffffffffffffffffffffff" })));
    assert.equal(unknown.status, 401);
    assert.match(((await unknown.json()) as { error: string }).error, /nonce/);
    await store.createChallenge("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", NOW - 1);
    const expired = await postSiws(url, asBody(signed(kp, { nonce: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })));
    assert.equal(expired.status, 401);
  });
});

test("POST /auth/siws: 400 when body fields are missing", async () => {
  await withAuthServer(memAuthStore(), () => NOW, async (url) => {
    const res = await postSiws(url, { address: "x" });
    assert.equal(res.status, 400);
  });
});

test("POST /auth/challenge: 503 once MAX_OPEN_CHALLENGES are outstanding", async () => {
  const store = memAuthStore();
  store.countOpenChallenges = async () => MAX_OPEN_CHALLENGES;
  await withAuthServer(store, () => NOW, async (url) => {
    const res = await fetch(`${url}/auth/challenge`, { method: "POST" });
    assert.equal(res.status, 503);
    assert.equal(store.challenges.size, 0);
  });
});

test("requireSession: 401 on no header, a malformed header, an unknown token and an expired session", async () => {
  const store = memAuthStore();
  const owner = Keypair.generate().publicKey.toBase58();
  await store.createSession(hashToken("expired-token"), owner, NOW - 1);
  await withAuthServer(store, () => NOW, async (url) => {
    for (const authorization of [undefined, "bearer abc", "Bearer ", "Basic abc", "Bearer unknown-token", "Bearer expired-token"]) {
      const res = await fetch(`${url}/whoami`, { headers: authorization ? { authorization } : {} });
      assert.equal(res.status, 401, `authorization=${authorization}`);
    }
  });
});
