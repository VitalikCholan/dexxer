// tests/er/lib/hashes.ts
//
// Pure keccak256 helpers mirroring the Rust canon (state/disclosure.rs
// state/balances_root.rs `leaf`/`pad`). Deliberately free
// of any IDL/RPC dependency so `hashes.selftest.ts` (and CI's typescript job,
// which has no `anchor build` output) can import them without loading
// `target/idl/*.json` — that ENOENT was the first real CI run's failure.
// Re-exported from `program.ts` for existing callers.

import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";

export function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

/**
 * `leaf(owner, free_margin, exit_salt, root_slot) = keccak(owner ‖
 * free_margin:u64le ‖ exit_salt(32) ‖ root_slot:u64le)` —
 * `programs/dexxer_core/src/state/balances_root.rs::leaf`.
 */
export function leaf(owner: PublicKey, freeMargin: bigint, exitSalt: Uint8Array, rootSlot: bigint): Uint8Array {
  return keccak_256(Buffer.concat([owner.toBuffer(), u64le(freeMargin), Buffer.from(exitSalt), u64le(rootSlot)]));
}

/** `pad(seed, i) = keccak(seed ‖ i:u8)` — `programs/dexxer_core/src/state/balances_root.rs::pad`. */
export function pad(seed: Uint8Array, i: number): Uint8Array {
  return keccak_256(Buffer.concat([Buffer.from(seed), Buffer.from([i])]));
}
