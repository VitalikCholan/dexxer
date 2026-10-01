// app/src/lib/hashes.ts
//
// keccak256 primitives the app must reproduce byte-for-byte from the program:
// the `BalancesRoot` leaf (`leafHex`). Split out of `program.ts` (week 6). Golden vectors are
// shared with `programs/dexxer_core` (Rust unit tests) and
// `tests/er/lib/hashes.selftest.ts`; `test/selfchecks.test.ts` runs them.
import { PublicKey } from '@solana/web3.js'
import { keccak_256 } from '@noble/hashes/sha3'

/**
 * `u64::to_le_bytes()` as a plain `Uint8Array` — NOT `Buffer` (see
 * `leafHex` below for why): the app's pinned `@types/node` is old enough
 * that `Buffer`'s inherited `Uint8Array` shape doesn't satisfy TS's newer
 * `Uint8Array<ArrayBufferLike>` iterator methods, so anything feeding
 * `@noble/hashes` has to stay a plain `Uint8Array` end-to-end rather than
 * relying on `Buffer.concat`/`Buffer.alloc`.
 */
function u64leBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, v, true)
  return out
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * `leaf(owner, free_margin, exit_salt, root_slot) = keccak256(owner(32) ‖
 * free_margin:u64le(8) ‖ exit_salt(32) ‖ root_slot:u64le(8))` —
 * `programs/dexxer_core/src/state/balances_root.rs::leaf` /
 * `tests/er/lib/program.ts::leaf`, returned as lowercase hex (this file's
 * name for it, per the Task-9 brief interface) rather than raw bytes.
 * Built from plain `Uint8Array`s (`owner.toBytes()`, not `.toBuffer()`) —
 * see `u64leBytes`'s doc comment.
 */
export function leafHex(owner: PublicKey, freeMargin: bigint, exitSalt: Uint8Array, rootSlot: bigint): string {
  const input = concatBytes(owner.toBytes(), u64leBytes(freeMargin), exitSalt, u64leBytes(rootSlot))
  const bytes = keccak_256(input)
  return Buffer.from(bytes).toString('hex')
}

/**
 * Golden-vector self-check (Task 9): asserts `leafHex` above produces the
 * exact same hex as the Rust `leaf_and_pad_golden_vectors` unit test
 * (`programs/dexxer_core/src/state/balances_root.rs`) and the TS reference
 * (`tests/er/lib/hashes.selftest.ts`) for the same fixed inputs — so a
 * layout/byte-order mistake here would be caught immediately rather than
 * silently producing wrong Receipt verdicts. Not a test-runner test (none is
 * wired up for this app package, mirroring `tests/er`'s standalone
 * `hashes.selftest.ts`) — call once, e.g. from `__DEV__` startup logging.
 * Throws on mismatch.
 */
export function assertLeafGolden(): void {
  const owner = new PublicKey(new Uint8Array(32).fill(3))
  const exitSalt = new Uint8Array(32).fill(4)
  const got = leafHex(owner, 42n, exitSalt, 99n)
  const expected = '79107674f9ef863f98a85fdbc056ddf1121f71870dffb8628f206b6c82f31572'
  if (got !== expected) {
    throw new Error(`assertLeafGolden: leafHex mismatch — got ${got}, expected ${expected}`)
  }
}

if (__DEV__) {
  try {
    assertLeafGolden()
    console.log('[dexxer] assertLeafGolden: keccak leaf hash OK (golden vector matched)')
  } catch (e) {
    console.error('[dexxer] assertLeafGolden FAILED', e)
  }
}
