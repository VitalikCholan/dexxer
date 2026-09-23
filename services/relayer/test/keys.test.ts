// services/relayer/test/keys.test.ts
//
// `keypairFromEnv`'s bs58 branch: round-trips a generated `Keypair` through
// `bs58.encode(secretKey)` -> env var -> `keypairFromEnv` and checks the
// public key comes back identical. No network, no filesystem write (the
// `fileFallback` branch is never reached when the env var is set).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { keypairFromEnv } from "../src/keys.js";

test("keypairFromEnv: bs58 env var round-trips to the same public key", () => {
  const original = Keypair.generate();
  const envVar = "TEST_KEYPAIR_FROM_ENV_B58";
  process.env[envVar] = bs58.encode(original.secretKey);
  try {
    const loaded = keypairFromEnv(envVar, "unused-file-fallback");
    assert.equal(loaded.publicKey.toBase58(), original.publicKey.toBase58());
    assert.deepEqual(Array.from(loaded.secretKey), Array.from(original.secretKey));
  } finally {
    delete process.env[envVar];
  }
});
