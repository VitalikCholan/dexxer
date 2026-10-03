// Final review I5: operator logs carry a per-process tag, never a trader key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { PROCESS_SALT, tagOf } from "../src/logTag.js";

test("tagOf: 8 hex chars, stable within a process (same salt), different with another salt", () => {
  const key = Keypair.generate().publicKey;
  const a = tagOf(PROCESS_SALT, key);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(tagOf(PROCESS_SALT, key), a, "stable");
  assert.equal(tagOf(PROCESS_SALT, key.toBase58()), a, "a base58 string tags the same as the key");
  const other = randomBytes(16);
  assert.notEqual(tagOf(other, key), a, "another salt, another tag");
  assert.notEqual(tagOf(PROCESS_SALT, Keypair.generate().publicKey), a, "another key, another tag");
});

test("tagOf never contains the key, in base58 or hex", () => {
  for (let i = 0; i < 50; i++) {
    const key = Keypair.generate().publicKey;
    const t = tagOf(PROCESS_SALT, key);
    assert.ok(!key.toBase58().includes(t), "not a base58 substring");
    assert.ok(!key.toBuffer().toString("hex").includes(t), "not a hex substring");
    assert.notEqual(t, bs58.encode(key.toBuffer()).slice(0, 8));
  }
  assert.equal(PROCESS_SALT.length, 16);
});
