// app/test/marketList.test.ts — rows, search, tabs, sort, slot usage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import {
  filterRows,
  formatChange,
  marketRows,
  parseSort,
  slotUsage,
  sortRows,
  type MarketRow,
} from '../src/features/markets/marketList'
import type { MarketInfo } from '../src/lib/markets'
import type { DecodedPositions } from '../src/lib/positions'

const market = (symbol: string, name: string | null, o: Partial<MarketInfo['params']> = {}): MarketInfo => ({
  symbol,
  name,
  market: PublicKey.unique(),
  feed: PublicKey.unique(),
  params: {
    maxLevBps: 100_000,
    imrBps: 1_000,
    mmrBps: 500,
    openFeeBps: 6,
    closeFeeBps: 6,
    liqFeeBps: 100,
    oiCap: 0n,
    maxPosition: 1n,
    minSize: 1n,
    maxStalenessSecs: 15n,
    pausedOpen: false,
    ...o,
  },
})
const SOL = market('SOL', 'Solana')
const BTC = market('BTC', 'Bitcoin', { pausedOpen: true })
const ETH = market('ETH', 'Ethereum', { maxLevBps: 50_000 })
const positions = { slots: [{ market: ETH.market }], orders: [{ market: BTC.market }] } as unknown as DecodedPositions

const rows = marketRows({
  markets: [SOL, BTC, ETH],
  tickers: [
    { symbol: 'SOL', price: 150_000_000n, change24h: -0.02, high24h: null, low24h: null },
    { symbol: 'BTC', price: 60_000_000_000n, change24h: 0.05, high24h: null, low24h: null },
    { symbol: 'ETH', price: null, change24h: null, high24h: null, low24h: null },
  ],
  marks: { SOL: 151_000_000n },
  positions,
  favorites: ['BTC'],
  selected: 'ETH',
})
const by = (s: string) => rows.find((r) => r.symbol === s) as MarketRow

test('marketRows: live WS mark wins over the ticker price; no data → null, never 0', () => {
  assert.equal(by('SOL').price, 151_000_000n)
  assert.equal(by('BTC').price, 60_000_000_000n)
  assert.equal(by('ETH').price, null)
  assert.equal(by('ETH').change24h, null)
})

test('marketRows: flags — paused, position, orders, favourite, selected, leverage', () => {
  assert.equal(by('BTC').paused, true)
  assert.equal(by('ETH').hasPosition, true)
  assert.equal(by('BTC').hasOrders, true)
  assert.equal(by('BTC').favorite, true)
  assert.equal(by('ETH').selected, true)
  assert.equal(by('SOL').maxLeverage, 10)
  assert.equal(by('ETH').maxLeverage, 5)
})

test('marketRows: an empty registry still yields the SOL fallback row', () => {
  const out = marketRows({ markets: [], tickers: [], marks: {}, positions: null, favorites: [], selected: 'SOL' })
  assert.deepEqual(
    out.map((r) => [r.symbol, r.name, r.selected]),
    [['SOL', 'Solana', true]],
  )
})

test('filterRows: case-insensitive on ticker or name, trims, never throws on regex characters', () => {
  assert.deepEqual(
    filterRows(rows, 'eth', 'all').map((r) => r.symbol),
    ['ETH'],
  )
  assert.deepEqual(
    filterRows(rows, '  Bitco ', 'all').map((r) => r.symbol),
    ['BTC'],
  )
  assert.equal(filterRows(rows, '', 'all').length, 3)
  assert.deepEqual(filterRows(rows, '(', 'all'), [])
  assert.deepEqual(filterRows(rows, '.', 'all'), [])
})

test('filterRows: tabs — favourites, positions (open slot or pending order)', () => {
  assert.deepEqual(
    filterRows(rows, '', 'favorites').map((r) => r.symbol),
    ['BTC'],
  )
  assert.deepEqual(
    filterRows(rows, '', 'positions')
      .map((r) => r.symbol)
      .sort(),
    ['BTC', 'ETH'],
  )
})

test('sortRows: A–Z keeps SOL first; 24h sorts put null last both ways', () => {
  assert.deepEqual(
    sortRows(rows, 'az').map((r) => r.symbol),
    ['SOL', 'BTC', 'ETH'],
  )
  assert.deepEqual(
    sortRows(rows, 'up').map((r) => r.symbol),
    ['BTC', 'SOL', 'ETH'],
  )
  assert.deepEqual(
    sortRows(rows, 'down').map((r) => r.symbol),
    ['SOL', 'BTC', 'ETH'],
  )
})

test('slotUsage: open slots out of 16; null without a Positions account', () => {
  assert.deepEqual(slotUsage(positions), { used: 1, max: 16 })
  assert.equal(slotUsage(null), null)
})

test('parseSort: stored value or the A–Z default', () => {
  assert.equal(parseSort('up'), 'up')
  assert.equal(parseSort('down'), 'down')
  assert.equal(parseSort(null), 'az')
  assert.equal(parseSort('garbage'), 'az')
})

test('formatChange: signed percent with two decimals; null → —', () => {
  assert.equal(formatChange(0.0083), '+0.83%')
  assert.equal(formatChange(-0.02), '−2.00%')
  assert.equal(formatChange(0), '+0.00%')
  assert.equal(formatChange(null), '—')
})
