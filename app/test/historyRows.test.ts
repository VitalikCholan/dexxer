import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { toArchived } from '../src/features/history/historyArchive'
import { historyRowsFrom, reasonLabel } from '../src/features/history/historyRows'
import type { HistoryRecord } from '../src/lib/positions'

const m = Keypair.generate().publicKey
const rec = (closedSlot: bigint, o: Partial<HistoryRecord> = {}): HistoryRecord =>
  ({ market: m, size: 10n, entry: 150n, exit: 160n, pnl: -7n, fees: 1n, openedSlot: 1n, closedSlot, side: 'Short', reason: 'User', ...o })

test('historyRowsFrom resolves the symbol, restores bigints and keeps the order', () => {
  const archive = [toArchived(rec(9n), 11), toArchived(rec(4n, { reason: 'Liquidated' }), 12)]
  const rows = historyRowsFrom(archive, (k) => (k === m.toBase58() ? 'SOL' : '?'))
  assert.deepEqual(rows.map((r) => r.closedSlot), [9n, 4n])
  assert.equal(rows[0].symbol, 'SOL')
  assert.equal(rows[0].pnl, -7n)
  assert.equal(rows[0].size, 10n)
  assert.equal(rows[0].side, 'Short')
  assert.equal(rows[1].seenAt, 12)
  assert.equal(rows[1].reason, 'Liquidated')
})

test('reasonLabel covers the three reasons', () => {
  assert.equal(reasonLabel('User'), 'Closed')
  assert.equal(reasonLabel('Liquidated'), 'Liquidated')
  assert.equal(reasonLabel('Decrease'), 'Partial close')
})
