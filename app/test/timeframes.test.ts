// test/timeframes.test.ts — the app's copy of the bucketing logic must agree
// byte-for-byte with the relayer's (services/relayer/src/indexer/timeframes.ts):
// both read tests/fixtures/timeframes.golden.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  TIMEFRAMES,
  bucketStart,
  isTf,
  mergeCandles,
  nthPrevBucket,
  prevBucket,
  tierOf,
  type Tf,
} from '../src/features/chart/timeframes'

interface Golden {
  tf: Tf
  iso: string
  ms: number
  bucketStart: number
  prevBucket: number
}
const golden = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'timeframes.golden.json'), 'utf8'),
) as Golden[]

test('timeframes: the 16 TradingView tfs in display order', () => {
  assert.deepEqual(
    [...TIMEFRAMES],
    ['1s', '1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '24h', '2D', '5D', '1W', '1M'],
  )
  assert.ok(isTf('2D'))
  assert.ok(!isTf('1D'))
})

test('timeframes: golden vectors shared with the relayer', () => {
  assert.ok(golden.length >= 14)
  for (const g of golden) {
    assert.equal(bucketStart(g.tf, g.ms), g.bucketStart, `${g.tf} ${g.iso}`)
    assert.equal(prevBucket(g.tf, g.bucketStart), g.prevBucket, `${g.tf} prev ${g.iso}`)
  }
})

test('timeframes: tiers and nthPrevBucket', () => {
  assert.equal(tierOf('1s'), 'ticks')
  assert.equal(tierOf('30m'), '1m')
  assert.equal(tierOf('12h'), '1h')
  assert.equal(tierOf('1M'), '1d')
  assert.equal(nthPrevBucket('1M', Date.UTC(2026, 2, 1), 2), Date.UTC(2026, 0, 1))
})

test('mergeCandles on numbers: o first, h max, l min, c last, grouped by the target bucket', () => {
  const M = 60_000
  const rows = [
    { t: 0, o: 1, h: 3, l: 1, c: 2 },
    { t: M, o: 2, h: 2, l: 0, c: 1 },
    { t: 5 * M, o: 1, h: 1, l: 1, c: 1 },
  ]
  assert.deepEqual(mergeCandles(rows, '5m'), [
    { t: 0, o: 1, h: 3, l: 0, c: 1 },
    { t: 5 * M, o: 1, h: 1, l: 1, c: 1 },
  ])
})
