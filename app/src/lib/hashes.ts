// app/src/lib/hashes.ts
//
// keccak256 primitives the app must reproduce byte-for-byte from the program:
// the `BalancesRoot` leaf (`leafHex`) and the 13F commitment hash
// (`commitmentHash`). Split out of `program.ts` (week 6). Golden vectors are
// shared with `programs/dexxer_core` (Rust unit tests) and
// `tests/er/lib/hashes.selftest.ts`; `test/selfchecks.test.ts` runs them.
import { PublicKey } from '@solana/web3.js'
import { keccak_256 } from '@noble/hashes/sha3'
import { CLOSE_REASONS, SIDES, type CloseReasonName, type SideName } from './codecs'

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

/** `i64::to_le_bytes()` as a plain `Uint8Array` (see `u64leBytes`'s doc comment — `pnl` is signed). */
function i64leBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, v, true)
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

/**
 * Mirrors `DisclosureArgs`/`state::disclosure::commitment_hash` field-for-field
 * (`programs/dexxer_core/src/state/disclosure.rs`, `tests/er/lib/program.ts`'s
 * `DisclosureArgsBytes`). Task 8b: History matches an L1 `Disclosure` to this
 * device's own closed trade by this hash, not by `nonce` — `nonce` is
 * `UserAccount.nonce`, a per-user counter, so two different traders' revealed
 * `Disclosure.nonce` values can collide (ruling 9's whole point). `side`/
 * `reason` take the decoded name (`SideName`/`CloseReasonName`) rather than a
 * raw index, since that is what `DecodedClosedRecord` already carries.
 */
export interface CommitmentArgs {
  market: PublicKey
  side: SideName
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  reason: CloseReasonName
  openedSlot: bigint
  closedSlot: bigint
  nonce: bigint
  revealAfterSlot: bigint
}

/**
 * `commitment_hash(a, salt) = keccak256(market(32) ‖ side:u8(1) ‖ size:u64le(8)
 * ‖ entry:u64le(8) ‖ exit:u64le(8) ‖ pnl:i64le(8) ‖ fees:u64le(8) ‖
 * reason:u8(1) ‖ opened_slot:u64le(8) ‖ closed_slot:u64le(8) ‖ nonce:u64le(8)
 * ‖ reveal_after_slot:u64le(8) ‖ salt(32))` — byte-for-byte
 * `programs/dexxer_core/src/state/disclosure.rs::commitment_hash` /
 * `tests/er/lib/program.ts::commitmentHash`. Returns raw bytes (32); a caller
 * needing a PDA seed or a persisted key converts with
 * `Buffer.from(...).toString('hex')` (see `pdas.commitment`/`pdas.disclosure`,
 * which also accept the hex form directly).
 */
export function commitmentHash(a: CommitmentArgs, salt: Uint8Array): Uint8Array {
  const input = concatBytes(
    a.market.toBytes(),
    Uint8Array.of(SIDES.indexOf(a.side)),
    u64leBytes(a.size),
    u64leBytes(a.entry),
    u64leBytes(a.exit),
    i64leBytes(a.pnl),
    u64leBytes(a.fees),
    Uint8Array.of(CLOSE_REASONS.indexOf(a.reason)),
    u64leBytes(a.openedSlot),
    u64leBytes(a.closedSlot),
    u64leBytes(a.nonce),
    u64leBytes(a.revealAfterSlot),
    salt,
  )
  return keccak_256(input)
}

/**
 * Golden-vector self-check (Task 8b), same pattern as `assertLeafGolden`:
 * asserts `commitmentHash` above produces the exact same hex as the Rust
 * `commitment_hash_golden_vector` unit test
 * (`programs/dexxer_core/src/state/disclosure.rs`) and the TS reference
 * (`tests/er/lib/hashes.selftest.ts`) for the same fixed inputs. Throws on
 * mismatch.
 */
export function assertCommitmentGolden(): void {
  const args: CommitmentArgs = {
    market: new PublicKey(new Uint8Array(32).fill(1)),
    side: 'Long',
    size: 1_000_000n,
    entry: 150_000_000n,
    exit: 151_000_000n,
    pnl: -5n,
    fees: 7n,
    reason: 'User',
    openedSlot: 10n,
    closedSlot: 20n,
    nonce: 3n,
    revealAfterSlot: 25n,
  }
  const salt = new Uint8Array(32).fill(2)
  const got = Buffer.from(commitmentHash(args, salt)).toString('hex')
  const expected = '26e982cc691717451020afc4cb1146e7489b0953c9b26b3ad589f19741c4103f'
  if (got !== expected) {
    throw new Error(`assertCommitmentGolden: hash mismatch — got ${got}, expected ${expected}`)
  }
}

if (__DEV__) {
  try {
    assertLeafGolden()
    console.log('[dexxer] assertLeafGolden: keccak leaf hash OK (golden vector matched)')
  } catch (e) {
    console.error('[dexxer] assertLeafGolden FAILED', e)
  }
  try {
    assertCommitmentGolden()
    console.log('[dexxer] assertCommitmentGolden: keccak commitment hash OK (golden vector matched)')
  } catch (e) {
    console.error('[dexxer] assertCommitmentGolden FAILED', e)
  }
}
