// test/chartData.test.ts — the chart's pure data (`src/features/chart/chartData.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHART_TYPES, ema, heikinAshi, isChartType, seriesFor, withLiveMark } from '../src/features/chart/chartData'

const M = 60_000
const c = (t: number, o: number, h: number, l: number, cl: number) => ({ t, o, h, l, c: cl })

test('12 distinct chart types', () => {
  assert.equal(CHART_TYPES.length, 12)
  assert.equal(new Set(CHART_TYPES.map((t) => t.id)).size, 12)
  assert.ok(isChartType('heikinAshi'))
  assert.ok(!isChartType('volume'))
})

test('withLiveMark: same bucket updates close and stretches high/low', () => {
  const candles = [c(10 * M, 100e6, 101e6, 99e6, 100e6)]
  assert.deepEqual(withLiveMark(candles, 103_000_000n, '1m', 10 * M + 30_000), [c(10 * M, 100e6, 103e6, 99e6, 103e6)])
  assert.deepEqual(withLiveMark(candles, 98_000_000n, '1m', 10 * M + 30_000), [c(10 * M, 100e6, 101e6, 98e6, 98e6)])
})

test('withLiveMark: a later bucket opens a new candle at the last close', () => {
  const candles = [c(10 * M, 100e6, 101e6, 99e6, 100e6)]
  const out = withLiveMark(candles, 102_000_000n, '1m', 12 * M + 5)
  assert.equal(out.length, 2)
  assert.deepEqual(out[1], c(12 * M, 100e6, 102e6, 100e6, 102e6))
})

test('withLiveMark: no mark, no candles, or a stale clock leave the candles alone', () => {
  const candles = [c(10 * M, 1, 1, 1, 1)]
  assert.deepEqual(withLiveMark(candles, null, '1m', 20 * M), candles)
  assert.deepEqual(withLiveMark([], 5n, '1m', 20 * M), [])
  assert.deepEqual(withLiveMark(candles, 5n, '1m', 9 * M), candles)
})

test('seriesFor: dollars, UTC seconds, and the family per type', () => {
  const candles = [c(60_000, 100e6, 110e6, 90e6, 105e6)]
  assert.deepEqual(seriesFor('candles', candles), {
    kind: 'ohlc',
    data: [{ time: 60, open: 100, high: 110, low: 90, close: 105 }],
  })
  assert.deepEqual(seriesFor('line', candles), { kind: 'value', data: [{ time: 60, value: 105 }] })
  assert.deepEqual(seriesFor('columns', candles).kind, 'value')
  assert.deepEqual(seriesFor('hlcArea', candles), { kind: 'hlc', data: [{ time: 60, high: 110, low: 90, close: 105 }] })
  assert.deepEqual(seriesFor('highLow', candles), {
    kind: 'ohlc',
    data: [{ time: 60, open: 90, high: 110, low: 90, close: 110 }],
  })
})

test('heikinAshi: first bar from its own open/close, then chained', () => {
  const ha = heikinAshi([
    { time: 1, open: 10, high: 14, low: 8, close: 12 },
    { time: 2, open: 12, high: 16, low: 11, close: 15 },
  ])
  assert.deepEqual(ha[0], { time: 1, open: 11, close: 11, high: 14, low: 8 })
  assert.equal(ha[1].open, 11) // (11 + 11) / 2
  assert.equal(ha[1].close, 13.5) // (12 + 16 + 11 + 15) / 4
  assert.equal(ha[1].high, 16)
  assert.equal(ha[1].low, 11)
})

test('ema: seeded with the first close, k = 2 / (period + 1)', () => {
  const e = ema(
    [
      { time: 1, close: 10 },
      { time: 2, close: 20 },
      { time: 3, close: 20 },
    ],
    3,
  )
  assert.deepEqual(
    e.map((p) => p.value),
    [10, 15, 17.5],
  )
})
