import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { positionRows } from '../src/features/positions/positionRows'
import type { DecodedPositions, PositionSlot } from '../src/lib/positions'
import type { MarketInfo } from '../src/lib/markets'

const k = () => Keypair.generate().publicKey
const slot = (index: number, market = k()): PositionSlot =>
  ({ index, market, size: 1n, entry: 1n, margin: 1n, liqPrice: 1n, openedSlot: 1n, oiNotional: 1n, lastLiqSample: 0n, side: 'Long', liqTicks: 0 })
const mi = (symbol: string, market = k()): MarketInfo =>
  ({ symbol, market, feed: k(), params: { maxLevBps: 1, imrBps: 1, mmrBps: 1, openFeeBps: 1, closeFeeBps: 1, liqFeeBps: 1, oiCap: 0n, maxPosition: 1n, minSize: 1n, maxStalenessSecs: 1n, pausedOpen: false } })

test('positionRows: every open slot in index order, symbol from the registry, unknown market still listed', () => {
  const btc = mi('BTC')
  const stray = k()
  const p: DecodedPositions = { owner: k(), slots: [slot(2, stray), slot(5, btc.market)], history: [], version: 1, bump: 1 }
  const rows = positionRows(p, [mi('SOL'), btc])
  assert.deepEqual(rows.map((r) => r.slot.index), [2, 5])
  assert.equal(rows[1].symbol, 'BTC')
  assert.equal(rows[1].market?.symbol, 'BTC')
  assert.equal(rows[0].market, null)
  assert.match(rows[0].symbol, /…$/)
  assert.deepEqual(positionRows(null, [btc]), [])
})

test('positionRows: a registry market without a slot never appears', () => {
  const p: DecodedPositions = { owner: k(), slots: [], history: [], version: 1, bump: 1 }
  assert.deepEqual(positionRows(p, [mi('SOL'), mi('BTC')]), [])
})
