// tests/er/lib/hashes.selftest.ts
//
// Week 3 (Task 7) golden-vector self-test: asserts the TS keccak256 helpers
// in `program.ts` (`commitmentHash`, `leaf`, `pad`) produce byte-for-byte the
// same hex as the Rust unit tests `commitment_hash_golden_vector`
// (programs/dexxer_core/src/state/disclosure.rs) and
// `leaf_and_pad_golden_vectors` (programs/dexxer_core/src/state/balances_root.rs)
// for the exact same fixed inputs. No test runner is wired up in this
// package (see package.json) — this is a standalone script that throws (and
// exits non-zero) on any mismatch. Run: `npm run selftest:hashes`.

import { PublicKey } from "@solana/web3.js";
import { commitmentHash, leaf, pad } from "./program.js";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}\n  actual:   ${actual}\n  expected: ${expected}`);
    process.exit(1);
  }
  console.log(`ok: ${label} = ${actual}`);
}

// Same fixed inputs as `commitment_hash_golden_vector` (disclosure.rs).
const commitmentArgs = {
  market: new PublicKey(new Uint8Array(32).fill(1)),
  side: 0, // Side::Long
  size: 1_000_000n,
  entry: 150_000_000n,
  exit: 151_000_000n,
  pnl: -5n,
  fees: 7n,
  reason: 0, // CloseReason::User
  openedSlot: 10n,
  closedSlot: 20n,
  nonce: 3n,
  revealAfterSlot: 25n,
};
const commitmentSalt = new Uint8Array(32).fill(2);
assertEqual(
  hex(commitmentHash(commitmentArgs, commitmentSalt)),
  "26e982cc691717451020afc4cb1146e7489b0953c9b26b3ad589f19741c4103f",
  "commitmentHash golden vector",
);

// Same fixed inputs as `leaf_and_pad_golden_vectors` (balances_root.rs).
const leafOwner = new PublicKey(new Uint8Array(32).fill(3));
const exitSalt = new Uint8Array(32).fill(4);
assertEqual(
  hex(leaf(leafOwner, 42n, exitSalt, 99n)),
  "79107674f9ef863f98a85fdbc056ddf1121f71870dffb8628f206b6c82f31572",
  "leaf golden vector",
);

const padSeed = new Uint8Array(32).fill(5);
assertEqual(hex(pad(padSeed, 7)), "ee5497d0b6b70660e0c594f242962c673db850a86ce614f3706820cf5b19dfb3", "pad golden vector");

console.log("hashes.selftest: ALL PASS");
