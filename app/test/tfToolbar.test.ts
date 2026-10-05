// test/tfToolbar.test.ts — the chart toolbar's pinned timeframes (`src/features/chart/tfToolbar.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PINNED_TFS,
  MAX_PINNED_TFS,
  chartTypeGlyph,
  parsePinnedTfs,
  togglePinnedTf,
  tfRow,
} from '../src/features/chart/tfToolbar'

test('defaults: five pinned timeframes, within the cap', () => {
  assert.deepEqual(DEFAULT_PINNED_TFS, ['1m', '15m', '1h', '4h', '24h'])
  assert.equal(MAX_PINNED_TFS, 5)
})

test('parsePinnedTfs: drops unknown and repeated, keeps the canonical order, caps at five', () => {
  assert.deepEqual(parsePinnedTfs(['4h', '1m', 'nope', 4, '4h']), ['1m', '4h'])
  assert.deepEqual(parsePinnedTfs(['1M', '1W', '5D', '2D', '24h', '12h', '1s']), ['1s', '12h', '24h', '2D', '5D'])
  assert.deepEqual(parsePinnedTfs([]), [])
  assert.deepEqual(parsePinnedTfs('1m'), DEFAULT_PINNED_TFS)
  assert.deepEqual(parsePinnedTfs(undefined), DEFAULT_PINNED_TFS)
})

test('togglePinnedTf: pins in timeframe order, unpins, never exceeds the cap', () => {
  assert.deepEqual(togglePinnedTf(['1m', '1h'], '5m'), ['1m', '5m', '1h'])
  assert.deepEqual(togglePinnedTf(['1m', '1h'], '1m'), ['1h'])
  const full = [...DEFAULT_PINNED_TFS]
  assert.deepEqual(togglePinnedTf(full, '2D'), full, 'a sixth pin is refused')
  assert.deepEqual(togglePinnedTf(full, '4h'), ['1m', '15m', '1h', '24h'], 'unpinning works when full')
})

test('tfRow: a pinned current timeframe is a pill and More stays neutral', () => {
  assert.deepEqual(tfRow(DEFAULT_PINNED_TFS, '1h'), {
    pills: DEFAULT_PINNED_TFS,
    more: { label: 'More', active: false },
  })
})

test('tfRow: an unpinned current timeframe takes the More button, so the choice is always visible', () => {
  assert.deepEqual(tfRow(DEFAULT_PINNED_TFS, '2D'), { pills: DEFAULT_PINNED_TFS, more: { label: '2D', active: true } })
  assert.deepEqual(tfRow([], '1m'), { pills: [], more: { label: '1m', active: true } })
})

test('chartTypeGlyph: every chart type maps to one of three glyphs', () => {
  assert.equal(chartTypeGlyph('candles'), 'candles')
  assert.equal(chartTypeGlyph('heikinAshi'), 'candles')
  assert.equal(chartTypeGlyph('bars'), 'candles')
  assert.equal(chartTypeGlyph('line'), 'line')
  assert.equal(chartTypeGlyph('step'), 'line')
  assert.equal(chartTypeGlyph('area'), 'area')
  assert.equal(chartTypeGlyph('baseline'), 'area')
})
