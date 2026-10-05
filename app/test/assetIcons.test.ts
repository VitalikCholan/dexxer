// app/test/assetIcons.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRAND_ICON_SYMBOLS, fallbackLetter, hasBrandIcon } from '../src/ui/assetIcons'

test('brand SVG for the listed assets; letter fallback for anything else', () => {
  for (const s of ['SOL', 'BTC', 'ETH', 'HYPE', 'ZEC']) assert.equal(hasBrandIcon(s), BRAND_ICON_SYMBOLS.includes(s), s)
  assert.equal(hasBrandIcon('SOL'), true)
  assert.equal(hasBrandIcon('NEW'), false)
  assert.equal(fallbackLetter('NEW'), 'N')
  assert.equal(fallbackLetter(''), '?')
})

test('every listed market ships its brand mark', () => {
  assert.deepEqual([...BRAND_ICON_SYMBOLS].sort(), ['BTC', 'ETH', 'HYPE', 'SOL', 'ZEC'])
})
