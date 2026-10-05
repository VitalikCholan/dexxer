import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { parseMarkets, resolveSymbol } from '../src/lib/markets'
import { IndexerShapeError } from '../src/lib/indexerCodec'

const row = (symbol: string) => ({
  symbol,
  market: PublicKey.unique().toBase58(),
  feed: PublicKey.unique().toBase58(),
  params: {
    maxLevBps: 100_000,
    imrBps: 1_000,
    mmrBps: 500,
    openFeeBps: 6,
    closeFeeBps: 6,
    liqFeeBps: 100,
    oiCap: '0',
    maxPosition: '100000000000',
    minSize: '10000000',
    maxStalenessSecs: '15',
    pausedOpen: false,
  },
})

test('parseMarkets: u64 strings become bigint, pubkeys parse, SOL is sorted first', () => {
  const out = parseMarkets([row('BTC'), row('SOL')])
  assert.deepEqual(
    out.map((m) => m.symbol),
    ['SOL', 'BTC'],
  )
  assert.equal(out[1].params.minSize, 10_000_000n)
  assert.equal(out[1].params.oiCap, 0n)
  assert.ok(out[0].market instanceof PublicKey)
})

test('parseMarkets rejects a missing params field by name and a non-array body', () => {
  const bad = row('ETH') as { params: Record<string, unknown> }
  delete bad.params.minSize
  assert.throws(
    () => parseMarkets([bad]),
    (e: unknown) => e instanceof IndexerShapeError && /minSize/.test(e.message),
  )
  assert.throws(() => parseMarkets({}), IndexerShapeError)
})

test('resolveSymbol: stored symbol kept until the registry loads; unknown or malformed falls back to SOL', () => {
  const ms = parseMarkets([row('SOL'), row('BTC')])
  assert.equal(resolveSymbol('BTC', undefined), 'BTC', 'registry not loaded yet: keep the stored choice')
  assert.equal(resolveSymbol('BTC', ms), 'BTC')
  assert.equal(resolveSymbol('DOGE', ms), 'SOL', 'delisted / unknown')
  assert.equal(resolveSymbol(null, undefined), 'SOL')
  assert.equal(resolveSymbol('btc', undefined), 'SOL', 'not a valid symbol seed')
})

test('parseMarkets rejects a market key that is not a public key', () => {
  assert.throws(
    () => parseMarkets([{ ...row('BTC'), market: 'not-a-key' }]),
    (e: unknown) => e instanceof IndexerShapeError && /market/.test(e.message),
  )
})

test('parseMarkets: name is optional — a string, null, or absent (old relayer) → null', () => {
  const out = parseMarkets([{ ...row('SOL'), name: 'Solana' }, { ...row('BTC'), name: null }, row('ETH')])
  assert.deepEqual(
    out.map((m) => [m.symbol, m.name]),
    [
      ['SOL', 'Solana'],
      ['BTC', null],
      ['ETH', null],
    ],
  )
})

test('parseMarkets: a non-string name is a shape error', () => {
  assert.throws(() => parseMarkets([{ ...row('SOL'), name: 42 }]), IndexerShapeError)
})
