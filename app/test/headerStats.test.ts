// test/headerStats.test.ts — the market header's pure numbers (`src/features/trade/headerStats.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCompactUsd, maxLeverage, rangeStats } from '../src/features/trade/headerStats'

const H = 3_600_000

test('maxLeverage: the tighter of max_lev_bps and imr_bps, never below 1', () => {
  assert.equal(maxLeverage(100_000, 1_000), 10) // devnet sol_perp_defaults
  assert.equal(maxLeverage(2_500_000, 1_000), 10) // a 250x max_lev is still capped by a 10% IMR
  assert.equal(maxLeverage(2_500_000, 40), 250)
  assert.equal(maxLeverage(5_000, 20_000), 1)
})

test('rangeStats: high/low over every candle, labelled by the span covered', () => {
  const now = 100 * H
  const day = [
    { t: now - 24 * H, o: 5, h: 7, l: 4, c: 6 },
    { t: now - 12 * H, o: 6, h: 9, l: 5, c: 8 },
    { t: now - H, o: 8, h: 8, l: 3, c: 4 },
  ]
  assert.deepEqual(rangeStats(day, now), { high: 9, low: 3, label: '24H' })
  assert.equal(rangeStats([{ t: now - 23.5 * H, o: 1, h: 1, l: 1, c: 1 }], now)!.label, '24H')
  assert.equal(rangeStats([{ t: now - 5.6 * H, o: 1, h: 1, l: 1, c: 1 }], now)!.label, '6H')
  assert.equal(rangeStats([{ t: now - 60_000, o: 1, h: 1, l: 1, c: 1 }], now)!.label, '1H')
})

test('rangeStats: nothing fetched yet -> null', () => {
  assert.equal(rangeStats(undefined, 0), null)
  assert.equal(rangeStats([], 0), null)
})

test('formatCompactUsd', () => {
  assert.equal(formatCompactUsd(950_000_000n), '$950')
  assert.equal(formatCompactUsd(10_000_000_000n), '$10.0K')
  assert.equal(formatCompactUsd(12_345_000_000n), '$12.3K')
  assert.equal(formatCompactUsd(4_560_000_000_000n), '$4.56M')
})
