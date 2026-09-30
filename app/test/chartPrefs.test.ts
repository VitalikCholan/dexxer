// test/chartPrefs.test.ts — the chart's stored preferences parse tolerantly (`src/features/chart/useChartPrefs.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PREFS, parsePrefs } from '../src/features/chart/useChartPrefs'

test('parsePrefs: nothing stored or garbage -> defaults', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS)
  assert.deepEqual(parsePrefs('{not json'), DEFAULT_PREFS)
})

test('parsePrefs: keeps valid fields, drops unknown chart types', () => {
  const p = parsePrefs(
    JSON.stringify({ type: 'heikinAshi', favorites: ['line', 'volume', 'bars'], log: true, ema: 'yes' }),
  )
  assert.equal(p.type, 'heikinAshi')
  assert.deepEqual(p.favorites, ['line', 'bars'])
  assert.equal(p.log, true)
  assert.equal(p.ema, DEFAULT_PREFS.ema)
  assert.equal(p.positions, DEFAULT_PREFS.positions)
})

test('parsePrefs: an unknown stored type falls back to candles', () => {
  assert.equal(parsePrefs(JSON.stringify({ type: 'renko' })).type, 'candles')
})
