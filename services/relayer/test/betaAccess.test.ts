// test/betaAccess.test.ts — closed beta: `BETA_ALLOWLIST` parsing and the 403
// from /auth/siws for a wallet that is not on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createSignInMessage } from "@solana/wallet-standard-util";
import { NOT_ON_BETA_LIST, parseAllowlist } from "../src/betaAccess.js";
import { SIWS_STATEMENT, authRouter } from "../src/auth.js";
import { memAuthStore } from "./memAuthStore.js";

const DOMAIN = "relayer.example.test";

test("parseAllowlist: unset or blank = open; commas, spaces and newlines separate; junk is reported and skipped", () => {
  assert.equal(parseAllowlist(undefined), null);
  assert.equal(parseAllowlist("  "), null);
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  const bad: string[] = [];
  const set = parseAllowlist(`${a}, ${b}\nnot-a-key`, (x) => bad.push(x));
  assert.deepEqual([...(set ?? [])].sort(), [a, b].sort());
  assert.deepEqual(bad, ["not-a-key"]);
});

async function signIn(url: string, kp: Keypair) {
  const c = (await (await fetch(`${url}/auth/challenge`, { method: "POST" })).json()) as { nonce: string; issuedAt: string; expirationTime: string };
  const msg = createSignInMessage({
    domain: DOMAIN,
    address: kp.publicKey.toBase58(),
    statement: SIWS_STATEMENT,
    uri: `https://${DOMAIN}`,
    version: "1",
    nonce: c.nonce,
    issuedAt: c.issuedAt,
    expirationTime: c.expirationTime,
  });
  return fetch(`${url}/auth/siws`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: kp.publicKey.toBase58(),
      signedMessage: Buffer.from(msg).toString("base64"),
      signature: Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("base64"),
    }),
  });
}

test("/auth/siws: an invited wallet gets a session, any other gets 403 and no session", async () => {
  const invited = Keypair.generate();
  const stranger = Keypair.generate();
  const store = memAuthStore();
  const app = express();
  app.use(authRouter({ store, domain: DOMAIN, sessionTtlMs: 3_600_000, allowlist: new Set([invited.publicKey.toBase58()]) }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await signIn(url, invited);
    assert.equal(ok.status, 200);
    const refused = await signIn(url, stranger);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: NOT_ON_BETA_LIST });
    assert.equal(store.sessions.size, 1, "the stranger got no session");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
