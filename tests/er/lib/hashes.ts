// tests/er/lib/hashes.ts
//
// Pure keccak256 helpers mirroring the Rust canon (state/disclosure.rs
// `commitment_hash`, state/balances_root.rs `leaf`/`pad`). Deliberately free
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

export function i64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
}

/** `Side::Long as u8 = 0`, `Side::Short as u8 = 1` (Borsh enum discriminant order — see state/mod.rs). */
export function sideIndex(side: "long" | "short" | { long?: unknown; short?: unknown }): number {
  if (typeof side === "string") return side === "long" ? 0 : 1;
  return "long" in side ? 0 : 1;
}

/** `CloseReason::User as u8 = 0`, `CloseReason::Liquidated as u8 = 1`. */
export function reasonIndex(reason: "user" | "liquidated" | { user?: unknown; liquidated?: unknown }): number {
  if (typeof reason === "string") return reason === "user" ? 0 : 1;
  return "user" in reason ? 0 : 1;
}

/**
 * Mirrors `state::disclosure::DisclosureArgs` field-for-field. `side`/`reason`
 * take the raw Borsh variant index (0/1) — callers holding an Anchor-decoded
 * enum object (`{ long: {} }`) should convert with `sideIndex`/`reasonIndex`
 * first.
 */
export interface DisclosureArgsBytes {
  market: PublicKey;
  side: number;
  size: bigint;
  entry: bigint;
  exit: bigint;
  pnl: bigint;
  fees: bigint;
  reason: number;
  openedSlot: bigint;
  closedSlot: bigint;
  nonce: bigint;
  revealAfterSlot: bigint;
}

/**
 * `commitment_hash(a, salt) = keccak(market ‖ side:u8 ‖ size:u64le ‖ entry:u64le
 * ‖ exit:u64le ‖ pnl:i64le ‖ fees:u64le ‖ reason:u8 ‖ opened_slot:u64le ‖
 * closed_slot:u64le ‖ nonce:u64le ‖ reveal_after_slot:u64le ‖ salt(32))` —
 * field order is significant, see Global Constraints and
 * `programs/dexxer_core/src/state/disclosure.rs::commitment_hash`.
 */
export function commitmentHash(a: DisclosureArgsBytes, salt: Uint8Array): Uint8Array {
  return keccak_256(
    Buffer.concat([
      a.market.toBuffer(),
      Buffer.from([a.side]),
      u64le(a.size),
      u64le(a.entry),
      u64le(a.exit),
      i64le(a.pnl),
      u64le(a.fees),
      Buffer.from([a.reason]),
      u64le(a.openedSlot),
      u64le(a.closedSlot),
      u64le(a.nonce),
      u64le(a.revealAfterSlot),
      Buffer.from(salt),
    ]),
  );
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
