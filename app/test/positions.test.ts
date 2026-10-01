// test/positions.test.ts — the hand-written `Positions` decoder against bytes
// laid out by the SAME offset table the Rust test
// `offsets_match_the_off_chain_decoders` pins. zero-copy: Anchor's coder
// cannot encode it, so the fixture writes bytes directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import {
  HISTORY_LEN,
  MAX_SLOTS,
  POSITIONS_DISC,
  POSITIONS_SIZE,
  decodePositions,
  historyKey,
  slotFor,
} from '../src/lib/positions'

const SLOTS = 8 + 32
const HISTORY = 8 + 1568
const HEAD = 8 + 3104

function blank(owner: PublicKey): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE)
  Buffer.from(POSITIONS_DISC).copy(b, 0)
  owner.toBuffer().copy(b, 8)
  b.writeUInt8(1, 8 + 3106)
  b.writeUInt8(254, 8 + 3107)
  return b
}
function putSlot(b: Buffer, i: number, market: PublicKey, o: { size: bigint; margin: bigint; side: 0 | 1; state?: number; liqTicks?: number }) {
  const at = SLOTS + i * 96
  market.toBuffer().copy(b, at)
  b.writeBigUInt64LE(o.size, at + 32)
  b.writeBigUInt64LE(150_000_000n, at + 40)
  b.writeBigUInt64LE(o.margin, at + 48)
  b.writeBigUInt64LE(140_000_000n, at + 56)
  b.writeBigUInt64LE(77n, at + 64)
  b.writeBigUInt64LE(1_500_000_000n, at + 72)
  b.writeBigUInt64LE(5n, at + 80)
  b.writeUInt8(o.state ?? 1, at + 88)
  b.writeUInt8(o.side, at + 89)
  b.writeUInt8(o.liqTicks ?? 0, at + 90)
}
function putHistory(b: Buffer, i: number, market: PublicKey, closedSlot: bigint, pnl: bigint, reason: number) {
  const at = HISTORY + i * 96
  market.toBuffer().copy(b, at)
  b.writeBigUInt64LE(10n, at + 32)
  b.writeBigUInt64LE(150_000_000n, at + 40)
  b.writeBigUInt64LE(160_000_000n, at + 48)
  b.writeBigInt64LE(pnl, at + 56)
  b.writeBigUInt64LE(3n, at + 64)
  b.writeBigUInt64LE(closedSlot - 5n, at + 72)
  b.writeBigUInt64LE(closedSlot, at + 80)
  b.writeUInt8(1, at + 88)
  b.writeUInt8(reason, at + 89)
}

test('POSITIONS_DISC is the IDL discriminator of Positions', () => {
  const acc = (DEXXER_CORE_IDL as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find(
    (a) => a.name === 'Positions',
  )
  assert.deepEqual(Array.from(POSITIONS_DISC), acc?.discriminator)
})

test('decodePositions returns only OPEN slots with their index; empty slots with residue are ignored', () => {
  const owner = Keypair.generate().publicKey
  const sol = Keypair.generate().publicKey
  const btc = Keypair.generate().publicKey
  const b = blank(owner)
  putSlot(b, 0, sol, { size: 10n, margin: 150n, side: 0 })
  putSlot(b, 3, btc, { size: 7n, margin: 80n, side: 1, liqTicks: 1 })
  putSlot(b, 5, Keypair.generate().publicKey, { size: 1n, margin: 1n, side: 0, state: 0 })
  const p = decodePositions(b)
  assert.equal(p.owner.toBase58(), owner.toBase58())
  assert.deepEqual(p.slots.map((s) => s.index), [0, 3])
  assert.equal(p.slots[1].side, 'Short')
  assert.equal(p.slots[1].liqTicks, 1)
  assert.equal(p.slots[0].entry, 150_000_000n)
  assert.equal(p.slots[0].liqPrice, 140_000_000n)
  assert.equal(slotFor(p, btc)?.index, 3)
  assert.equal(slotFor(p, Keypair.generate().publicKey), null)
  assert.equal(slotFor(null, sol), null)
  assert.equal(p.version, 1)
  assert.equal(p.bump, 254)
})

test('history is oldest-first, signed pnl and all three reasons decode, and the ring wrap is handled', () => {
  const m = Keypair.generate().publicKey
  const b = blank(Keypair.generate().publicKey)
  putHistory(b, 0, m, 100n, -5n, 0)
  putHistory(b, 1, m, 101n, 7n, 1)
  putHistory(b, 2, m, 102n, 0n, 2)
  b.writeUInt8(3, HEAD)
  b.writeUInt8(3, HEAD + 1)
  const p = decodePositions(b)
  assert.deepEqual(p.history.map((h) => h.closedSlot), [100n, 101n, 102n])
  assert.deepEqual(p.history.map((h) => h.reason), ['User', 'Liquidated', 'Decrease'])
  assert.equal(p.history[0].pnl, -5n)
  assert.equal(p.history[0].side, 'Short')
  assert.notEqual(historyKey(p.history[0]), historyKey(p.history[1]))

  const w = blank(Keypair.generate().publicKey)
  for (let i = 0; i < HISTORY_LEN; i++) putHistory(w, i, m, BigInt(200 + i), 0n, 0)
  putHistory(w, 0, m, 300n, 0n, 0)
  w.writeUInt8(1, HEAD)
  w.writeUInt8(HISTORY_LEN, HEAD + 1)
  const q = decodePositions(w)
  assert.equal(q.history.length, HISTORY_LEN)
  assert.equal(q.history[0].closedSlot, 201n)
  assert.equal(q.history[HISTORY_LEN - 1].closedSlot, 300n)
})

test('decodePositions refuses a wrong length and a foreign discriminator; MAX_SLOTS is 16', () => {
  const b = blank(Keypair.generate().publicKey)
  assert.throws(() => decodePositions(b.subarray(0, POSITIONS_SIZE - 1)), /length/)
  const foreign = Buffer.from(b)
  foreign.writeUInt8(foreign[0] ^ 0xff, 0)
  assert.throws(() => decodePositions(foreign), /discriminator/)
  assert.equal(MAX_SLOTS, 16)
})
