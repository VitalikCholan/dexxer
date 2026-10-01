import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { mergeArchive, toArchived } from '../src/features/history/historyArchive'
import type { HistoryRecord } from '../src/lib/positions'

const m = Keypair.generate().publicKey
const rec = (closedSlot: bigint, o: Partial<HistoryRecord> = {}): HistoryRecord =>
  ({ market: m, size: 10n, entry: 150n, exit: 160n, pnl: 7n, fees: 1n, openedSlot: closedSlot - 5n, closedSlot, side: 'Long', reason: 'User', ...o })

test('mergeArchive adds unseen ring records once, keeps records the ring has already overwritten, newest first', () => {
  const t0 = 1_000
  const a1 = mergeArchive([], [rec(100n), rec(101n)], t0)
  assert.deepEqual(a1.map((r) => r.closedSlot), ['101', '100'])
  assert.ok(a1.every((r) => r.seenAt === t0))
  const a2 = mergeArchive(a1, [rec(101n), rec(102n)], t0 + 5)   // 100 fell out of the ring
  assert.deepEqual(a2.map((r) => r.closedSlot), ['102', '101', '100'])
  assert.equal(a2.find((r) => r.closedSlot === '101')?.seenAt, t0, 'first-seen time is kept')
  assert.equal(a2.find((r) => r.closedSlot === '102')?.seenAt, t0 + 5)
})

test('a partial decrease and the later full close of the same position are two records', () => {
  const part = rec(50n, { reason: 'Decrease', size: 4n })
  const full = rec(60n, { reason: 'User', size: 6n })
  const a = mergeArchive([], [part, full], 1)
  assert.equal(a.length, 2)
  assert.deepEqual(a.map((r) => r.reason), ['User', 'Decrease'])
})

test('toArchived serialises bigints as decimal strings and keeps the identity key', () => {
  const r = toArchived(rec(7n, { pnl: -3n }), 42)
  assert.equal(r.pnl, '-3')
  assert.equal(r.size, '10')
  assert.match(r.key, new RegExp(`^${m.toBase58()}:2:7:10:User$`))
})

test('merging the same ring twice changes nothing', () => {
  const a1 = mergeArchive([], [rec(5n)], 1)
  assert.deepEqual(mergeArchive(a1, [rec(5n)], 99), a1)
})
