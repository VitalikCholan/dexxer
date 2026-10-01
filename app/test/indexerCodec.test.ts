// test/indexerCodec.test.ts — the app-side contract for the relayer's
// indexer responses (`src/lib/indexerCodec.ts`). Shapes come from
// services/relayer/src/indexer/{http,store,accounts}.ts: snake_case
// columns, u64/i64 as decimal STRINGS (never Number-coerced there), `ts`
// as a number. The relayer types them as Record<string, unknown>, so this
// is the only place the contract is written down — a backend rename must
// fail HERE, by field name, not as a silent BigInt(undefined) deep in a hook.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IndexerShapeError,
  parseCandles,
  parseMark,
  parsePoolSnapshot,
  parseRootLatest,
  parseWsFrame,
} from '../src/lib/indexerCodec'

const POOL = {
  slot: 123,
  ts: 1_700_000_000_000,
  capital_total: '100000000000',
  protocol_liquidity: '90000000000',
  locked_total: '5000000000',
  fees_accrued: '12',
  insurance: '0',
  bad_debt_total: '0',
}

test('parseMark: decimal-string price -> bigint; a null price is a valid "no mark yet"', () => {
  assert.deepEqual(parseMark({ price: '151234567', slot: 5, ts: 1, publishTime: 1, stale: false, market: 'SOL' }), {
    price: 151_234_567n,
    slot: 5,
    ts: 1,
    stale: false,
    market: 'SOL',
  })
  assert.equal(
    parseMark({ price: null, slot: null, ts: null, publishTime: null, stale: true, market: 'SOL' }).price,
    null,
  )
})
test('parseMark rejects a non-numeric price, a missing stale flag and a missing market, naming the field', () => {
  assert.throws(
    () => parseMark({ price: '1.5e9', slot: 1, ts: 1, stale: false, market: 'SOL' }),
    (e: unknown) => e instanceof IndexerShapeError && /price/.test(e.message),
  )
  assert.throws(
    () => parseMark({ price: '1', slot: 1, ts: 1, market: 'SOL' }),
    (e: unknown) => e instanceof IndexerShapeError && /stale/.test(e.message),
  )
  assert.throws(
    () => parseMark({ price: '1', slot: 1, ts: 1, stale: false }),
    (e: unknown) => e instanceof IndexerShapeError && /market/.test(e.message),
  )
})

test('parsePoolSnapshot converts every u64 column to bigint', () => {
  const p = parsePoolSnapshot(POOL)
  assert.equal(p.capitalTotal, 100_000_000_000n)
  assert.equal(p.badDebtTotal, 0n)
  assert.equal(p.slot, 123)
})
test('parsePoolSnapshot fails by name when the backend renames a column', () => {
  const { capital_total: _dropped, ...renamed } = { ...POOL, capitalTotal: POOL.capital_total }
  assert.throws(
    () => parsePoolSnapshot(renamed),
    (e: unknown) => e instanceof IndexerShapeError && /capital_total/.test(e.message),
  )
})

test('parseCandles: o/h/l/c are plain numbers (relayer convention); a non-array is rejected', () => {
  assert.deepEqual(parseCandles({ tf: '1m', candles: [{ t: 1, o: 1.5, h: 2, l: 1, c: 1.75 }] }), [
    { t: 1, o: 1.5, h: 2, l: 1, c: 1.75 },
  ])
  assert.throws(() => parseCandles({ tf: '1m', candles: {} }), IndexerShapeError)
})

test('parseRootLatest: null before the first commit; leavesHex must be strings', () => {
  assert.equal(parseRootLatest(null), null)
  assert.deepEqual(parseRootLatest({ root_slot: 9, filled: 2, leavesHex: ['aa', 'bb'] }), {
    root_slot: 9,
    filled: 2,
    leavesHex: ['aa', 'bb'],
  })
  assert.throws(() => parseRootLatest({ root_slot: 9, filled: 2, leavesHex: [1] }), IndexerShapeError)
})

test('parseWsFrame: known frames are validated like their REST twins; an unknown type is ignored (null), not an error', () => {
  const mark = parseWsFrame({ type: 'mark', market: 'BTC', price: '7', ts: 1, stale: false })
  assert.deepEqual(mark, { type: 'mark', market: 'BTC', price: 7n, ts: 1, stale: false })
  assert.throws(() => parseWsFrame({ type: 'mark', price: '7', ts: 1, stale: false }), IndexerShapeError)
  const pool = parseWsFrame({ type: 'pool', ...POOL })
  assert.equal(pool?.type, 'pool')
  // Disclosure is gone with position slots: an old relayer's frame is just an unknown type.
  assert.equal(parseWsFrame({ type: 'disclosure', pubkey: 'x', side: 'Long' }), null)
  assert.equal(parseWsFrame({ type: 'heartbeat' }), null)
  assert.throws(() => parseWsFrame({ type: 'pool', slot: 1 }), IndexerShapeError)
  assert.throws(() => parseWsFrame('not an object'), IndexerShapeError)
})
