// test/chartData.test.ts — the chart's pure data (`src/features/chart/chartData.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHART_TYPES,
  MARK_TAIL_MAX,
  WHITESPACE_MAX_GAP,
  appendMark,
  ema,
  fillWhitespace,
  foldMarks,
  heikinAshi,
  isChartType,
  isWhitespace,
  seriesFor,
  tailForKey,
} from '../src/features/chart/chartData'

const M = 60_000
const c = (t: number, o: number, h: number, l: number, cl: number) => ({ t, o, h, l, c: cl })

test('12 distinct chart types', () => {
  assert.equal(CHART_TYPES.length, 12)
  assert.equal(new Set(CHART_TYPES.map((t) => t.id)).size, 12)
  assert.ok(isChartType('heikinAshi'))
  assert.ok(!isChartType('volume'))
})

test('foldMarks: marks in the last bucket update close and stretch high/low', () => {
  const candles = [c(10 * M, 100e6, 101e6, 99e6, 100e6)]
  assert.deepEqual(foldMarks(candles, [{ ts: 10 * M + 30_000, price: 103e6 }], '1m'), [
    c(10 * M, 100e6, 103e6, 99e6, 103e6),
  ])
  assert.deepEqual(foldMarks(candles, [{ ts: 10 * M + 30_000, price: 98e6 }], '1m'), [
    c(10 * M, 100e6, 101e6, 98e6, 98e6),
  ])
})

test('foldMarks: a later bucket opens a new candle at the last close; several marks fold in order', () => {
  const candles = [c(10 * M, 100e6, 101e6, 99e6, 100e6)]
  const out = foldMarks(
    candles,
    [
      { ts: 12 * M + 5, price: 102e6 },
      { ts: 12 * M + 9_000, price: 97e6 },
      { ts: 13 * M, price: 99e6 },
    ],
    '1m',
  )
  assert.equal(out.length, 3)
  assert.deepEqual(out[1], c(12 * M, 100e6, 102e6, 97e6, 97e6))
  assert.deepEqual(out[2], c(13 * M, 97e6, 99e6, 97e6, 99e6))
})

test('foldMarks: a mark older than the newest candle is ignored (the fetch already covers it); no candles → candles from marks', () => {
  const candles = [c(10 * M, 1, 1, 1, 1)]
  assert.deepEqual(foldMarks(candles, [{ ts: 9 * M, price: 5 }], '1m'), candles)
  assert.deepEqual(foldMarks(candles, [], '1m'), candles)
  assert.deepEqual(
    foldMarks(
      [],
      [
        { ts: 1_500, price: 7 },
        { ts: 2_500, price: 8 },
      ],
      '1s',
    ),
    [c(1_000, 7, 7, 7, 7), c(2_000, 7, 8, 7, 8)],
  )
})

test('foldMarks: 1W folds marks of the same week into one bucket starting Monday', () => {
  const monday = Date.UTC(2026, 9, 5)
  const out = foldMarks(
    [],
    [
      { ts: monday + 86_400_000, price: 10 },
      { ts: monday + 3 * 86_400_000, price: 12 },
    ],
    '1W',
  )
  assert.deepEqual(out, [c(monday, 10, 12, 10, 12)])
})

test('appendMark: dedups the same tick, drops null marks, caps the tail', () => {
  const t0 = appendMark([], { ts: 1, price: 5n, market: 'SOL' }, 'SOL')
  assert.deepEqual(t0, [{ ts: 1, price: 5 }])
  assert.equal(appendMark(t0, { ts: 1, price: 5n, market: 'SOL' }, 'SOL'), t0) // same reference, nothing appended
  assert.deepEqual(appendMark(t0, { ts: null, price: 6n, market: 'SOL' }, 'SOL'), t0)
  assert.deepEqual(appendMark(t0, undefined, 'SOL'), t0)
  const long = appendMark(
    Array.from({ length: 3 }, (_, i) => ({ ts: i, price: i })),
    { ts: 9, price: 9n, market: 'SOL' },
    'SOL',
    3,
  )
  assert.deepEqual(
    long.map((m) => m.ts),
    [1, 2, 9],
  )
  assert.equal(MARK_TAIL_MAX, 2000)
})

test('appendMark: a mark of another market is ignored', () => {
  const t0 = appendMark([], { ts: 1, price: 5n, market: 'SOL' }, 'SOL')
  assert.equal(appendMark(t0, { ts: 2, price: 9n, market: 'BTC' }, 'SOL'), t0)
})

test('tailForKey: switching market empties the tail at once and a BTC mark starts a new one', () => {
  const sol = { key: 'SOL|1', marks: appendMark([], { ts: 1, price: 5n, market: 'SOL' }, 'SOL') }
  assert.deepEqual(tailForKey(sol, 'SOL|1'), [{ ts: 1, price: 5 }])
  assert.deepEqual(tailForKey(sol, 'BTC|1'), [])
  assert.deepEqual(tailForKey(sol, 'SOL|2'), [])
  const btc = appendMark(tailForKey(sol, 'BTC|1'), { ts: 2, price: 70n, market: 'BTC' }, 'BTC')
  assert.deepEqual(btc, [{ ts: 2, price: 70 }])
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

test('fillWhitespace: inserts {time} items for missing steps; keeps real points; leaves gaps wider than maxGap alone', () => {
  const pts = [
    { time: 10, value: 1 },
    { time: 13, value: 2 },
    { time: 14, value: 3 },
    { time: 5000, value: 4 },
  ]
  const out = fillWhitespace(pts, 1, 1000)
  assert.deepEqual(out.slice(0, 5), [
    { time: 10, value: 1 },
    { time: 11 },
    { time: 12 },
    { time: 13, value: 2 },
    { time: 14, value: 3 },
  ])
  assert.deepEqual(out[5], { time: 5000, value: 4 }) // 4986-step gap > maxGap: no fill
  assert.equal(out.length, 6)
  assert.deepEqual(fillWhitespace([], 1), [])
  assert.deepEqual(fillWhitespace([{ time: 7, value: 1 }], 1), [{ time: 7, value: 1 }])
  assert.ok(isWhitespace({ time: 11 }))
  assert.ok(!isWhitespace({ time: 11, value: 0 }))
  assert.equal(WHITESPACE_MAX_GAP, 1000)
})

test('fillWhitespace: non-1 steps and ohlc points', () => {
  const out = fillWhitespace(
    [
      { time: 0, open: 1, high: 1, low: 1, close: 1 },
      { time: 120, open: 2, high: 2, low: 2, close: 2 },
    ],
    60,
  )
  assert.deepEqual(
    out.map((p) => p.time),
    [0, 60, 120],
  )
  assert.deepEqual(out[1], { time: 60 })
})
