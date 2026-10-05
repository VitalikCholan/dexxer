// test/chartPrefs.test.ts — the chart's stored preferences parse tolerantly (`src/features/chart/useChartPrefs.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PREFS, parsePrefs } from '../src/features/chart/useChartPrefs'

test('parsePrefs: nothing stored or garbage -> defaults', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS)
  assert.deepEqual(parsePrefs('{not json'), DEFAULT_PREFS)
})

test('parsePrefs: keeps valid fields, drops the old favorites', () => {
  const p = parsePrefs(JSON.stringify({ type: 'heikinAshi', favorites: ['line'], log: true, ema: 'yes' }))
  assert.equal(p.type, 'heikinAshi')
  assert.ok(!('favorites' in p), 'the old starred chart types are dropped')
  assert.equal(p.log, true)
  assert.equal(p.ema, DEFAULT_PREFS.ema)
  assert.equal(p.positions, DEFAULT_PREFS.positions)
})

test('parsePrefs: an unknown stored type falls back to candles', () => {
  assert.equal(parsePrefs(JSON.stringify({ type: 'renko' })).type, 'candles')
})

test('parsePrefs: pinned timeframes default for old stored prefs and are cleaned when present', () => {
  assert.deepEqual(parsePrefs(JSON.stringify({ type: 'line' })).pinnedTfs, ['1m', '15m', '1h', '4h', '24h'])
  assert.deepEqual(parsePrefs(JSON.stringify({ pinnedTfs: ['1h', 'x', '1m'] })).pinnedTfs, ['1m', '1h'])
})
