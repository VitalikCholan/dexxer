// app/test/tickers.test.ts — GET /tickers shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTickers } from '../src/lib/tickers'
import { IndexerShapeError } from '../src/lib/indexerCodec'

test('parseTickers: decimal strings become bigint, null stays null', () => {
  const out = parseTickers([
    { symbol: 'ETH', price: '2725880000', change24h: 0.0083, high24h: '2739060000', low24h: '2691770000' },
    { symbol: 'NEW', price: null, change24h: null, high24h: null, low24h: null },
  ])
  assert.deepEqual(out, [
    { symbol: 'ETH', price: 2725880000n, change24h: 0.0083, high24h: 2739060000n, low24h: 2691770000n },
    { symbol: 'NEW', price: null, change24h: null, high24h: null, low24h: null },
  ])
})

test('parseTickers: wrong shapes throw IndexerShapeError naming the field', () => {
  assert.throws(() => parseTickers({}), IndexerShapeError)
  assert.throws(
    () => parseTickers([{ symbol: 'ETH', price: 12, change24h: null, high24h: null, low24h: null }]),
    /price/,
  )
  assert.throws(
    () => parseTickers([{ symbol: 'ETH', price: null, change24h: 'x', high24h: null, low24h: null }]),
    /change24h/,
  )
})
