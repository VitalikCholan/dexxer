// test/candlesRefetch.test.ts — `/prices` refetch cadence per timeframe and the candles query key (`src/lib/indexer.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QK, candlesRefetchMs } from '../src/lib/indexer'

test('candlesRefetchMs: 15 s for 1s, 30 s otherwise', () => {
  assert.equal(candlesRefetchMs('1s'), 15_000)
  assert.equal(candlesRefetchMs('1m'), 30_000)
  assert.equal(candlesRefetchMs('1M'), 30_000)
})

test('QK.candles: the limit is part of the key (header 96×15m ≠ chart 300×15m)', () => {
  assert.notDeepEqual(QK.candles('SOL', '15m', 96), QK.candles('SOL', '15m', 300))
  assert.deepEqual(QK.candles('SOL', '15m', 300), ['indexer', 'candles', 'SOL', '15m', 300])
})
