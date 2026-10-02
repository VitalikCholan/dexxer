// test/candlesRefetch.test.ts — `/prices` refetch cadence per timeframe (`src/lib/indexer.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candlesRefetchMs } from '../src/lib/indexer'

test('candlesRefetchMs: 15 s for 1s, 30 s otherwise', () => {
  assert.equal(candlesRefetchMs('1s'), 15_000)
  assert.equal(candlesRefetchMs('1m'), 30_000)
  assert.equal(candlesRefetchMs('1M'), 30_000)
})
