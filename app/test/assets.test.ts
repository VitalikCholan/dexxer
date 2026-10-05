// test/assets.test.ts — `lib/assets.ts` parses the relayer's `/assets/:symbol`,
// `assetFormat.ts` renders it. The fixture mirrors services/relayer/src/assets/service.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAsset } from '../src/lib/assets'
import { IndexerShapeError } from '../src/lib/indexerCodec'
import {
  compact,
  formatCompactUsd,
  formatDate,
  formatPercent,
  formatPrice,
  formatSupply,
  truncateText,
  updatedAgo,
} from '../src/features/trade/assetFormat'

const BODY = {
  symbol: 'SOL',
  name: 'Solana',
  ticker: 'SOL',
  launchDate: '2020-03-16',
  overview: 'o',
  utility: 'u',
  ecosystem: 'e',
  links: {
    website: 'https://solana.com/',
    whitepaper: null,
    explorer: 'https://explorer.solana.com/',
    github: 'https://github.com/anza-xyz/agave',
  },
  market: {
    rank: 5,
    marketCap: 80e9,
    fullyDilutedMarketCap: 90e9,
    volume24h: 3e9,
    dominance: 2,
    circulatingSupply: 500e6,
    maxSupply: null,
    totalSupply: 600e6,
    circulatingRate: 83.33,
    ath: { price: 293.31, date: '2021-11-06T21:54:35.825Z' },
    atl: { price: 0.5, date: '2020-05-11T19:35:23.449Z' },
  },
  source: 'CoinGecko',
  updatedAt: 1_700_000_000_000,
  stale: false,
}

test('parseAsset reads the full response', () => {
  const a = parseAsset(BODY)
  assert.equal(a.name, 'Solana')
  assert.equal(a.links.whitepaper, null)
  assert.equal(a.links.website, 'https://solana.com/')
  assert.equal(a.market?.rank, 5)
  assert.equal(a.market?.maxSupply, null)
  assert.deepEqual(a.market?.ath, { price: 293.31, date: '2021-11-06T21:54:35.825Z' })
  assert.equal(a.updatedAt, 1_700_000_000_000)
  assert.equal(a.stale, false)
})

test('parseAsset: market null (upstream down) still yields the text', () => {
  const a = parseAsset({ ...BODY, market: null, updatedAt: null })
  assert.equal(a.market, null)
  assert.equal(a.updatedAt, null)
  assert.equal(a.overview, 'o')
})

test('parseAsset: a market with gaps keeps the rest', () => {
  const a = parseAsset({ ...BODY, market: { ...BODY.market, ath: null, volume24h: null } })
  assert.equal(a.market?.ath, null)
  assert.equal(a.market?.volume24h, null)
  assert.equal(a.market?.marketCap, 80e9)
})

test('parseAsset rejects non-https links and bad shapes, naming the field', () => {
  const bad = (patch: Record<string, unknown>) => () => parseAsset({ ...BODY, ...patch })
  assert.throws(
    bad({ links: { ...BODY.links, website: 'http://x.io' } }),
    (e) => e instanceof IndexerShapeError && /links\.website/.test(e.message),
  )
  assert.throws(bad({ links: { ...BODY.links, github: 'javascript:alert(1)' } }), IndexerShapeError)
  assert.throws(bad({ name: 5 }), /name/)
  assert.throws(bad({ market: { ...BODY.market, rank: 'one' } }), /rank/)
  assert.throws(bad({ market: { ...BODY.market, ath: { price: null, date: 'x' } } }), /price/)
  assert.throws(() => parseAsset(null), IndexerShapeError)
})

test('compact: units, rounding carry, negatives', () => {
  assert.equal(compact(80.12e9), '80.12B')
  assert.equal(compact(1_234_567), '1.23M')
  assert.equal(compact(999_999), '1M', 'rounding carries into the next unit')
  assert.equal(compact(1_000), '1K')
  assert.equal(compact(12.345), '12.35')
  assert.equal(compact(0), '0')
  assert.equal(compact(-2.5e6), '-2.5M')
  assert.equal(compact(3.2e12), '3.2T')
})

test('money, supply, percent', () => {
  assert.equal(formatCompactUsd(80e9), '$80B')
  assert.equal(formatCompactUsd(null), '—')
  assert.equal(formatSupply(500e6, 'SOL'), '500M SOL')
  assert.equal(formatSupply(null, 'SOL'), '—')
  assert.equal(formatPercent(2), '2.00%')
  assert.equal(formatPercent(0.004), '<0.01%')
  assert.equal(formatPercent(0), '0.00%')
  assert.equal(formatPercent(null), '—')
})

test('formatPrice scales precision with magnitude and groups thousands', () => {
  assert.equal(formatPrice(293.31), '$293.31')
  assert.equal(formatPrice(64230.126), '$64,230.13')
  assert.equal(formatPrice(0.5123), '$0.5123')
  assert.equal(formatPrice(0.004), '$0.004000')
})

test('formatDate is UTC and locale-independent; junk is a dash', () => {
  assert.equal(formatDate('2021-11-06T21:54:35.825Z'), 'Nov 6, 2021')
  assert.equal(formatDate('2020-03-16'), 'Mar 16, 2020')
  assert.equal(formatDate('2021-12-31T23:59:59Z'), 'Dec 31, 2021')
  assert.equal(formatDate('nope'), '—')
})

test('updatedAgo', () => {
  const now = 10_000_000_000
  assert.equal(updatedAgo(null, now), null)
  assert.equal(updatedAgo(now - 10_000, now), 'Updated just now')
  assert.equal(updatedAgo(now - 3 * 60_000, now), 'Updated 3 min ago')
  assert.equal(updatedAgo(now - 2 * 3_600_000, now), 'Updated 2 h ago')
  assert.equal(updatedAgo(now + 5_000, now), 'Updated just now', 'clock skew never goes negative')
})

test('truncateText cuts at a word boundary and only when needed', () => {
  assert.deepEqual(truncateText('short', 20), { text: 'short', truncated: false })
  const t = truncateText('the quick brown fox jumps over the lazy dog', 20)
  assert.equal(t.truncated, true)
  assert.equal(t.text, 'the quick brown fox…')
  const noSpace = truncateText('x'.repeat(50), 20)
  assert.equal(noSpace.text, `${'x'.repeat(20)}…`)
})
