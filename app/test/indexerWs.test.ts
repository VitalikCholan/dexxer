// test/indexerWs.test.ts — `IndexerWs` (`src/lib/indexer.ts`): the shared
// relayer websocket as a class with injected socket factory + timers, so
// reconnect policy, cache patching and the history cap run under node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backoffMs,
  IndexerWs,
  MAX_BACKOFF_MS,
  POOL_HISTORY_MAX,
  QK,
  WS_URL,
  type Mark,
  type PoolSnapshot,
} from '../src/lib/indexer'

type Handler = ((ev: { data: unknown }) => void) | null
class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: Handler = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  pushRaw(data: string) {
    this.onmessage?.({ data })
  }
  drop() {
    this.onclose?.()
  }
}
/** Minimal react-query cache: applies updaters, records the data per key. */
function fakeCache() {
  const data = new Map<string, unknown>()
  return {
    data,
    setQueryData: <T>(key: readonly unknown[], updater: (prev: T | undefined) => T) => {
      const k = JSON.stringify(key)
      data.set(k, updater(data.get(k) as T | undefined))
    },
  }
}
function harness() {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const ws = new IndexerWs('ws://relayer/ws', {
    connect: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimeout: () => {},
  })
  const cache = fakeCache()
  ws.attach(cache as never)
  return { ws, sockets, timers, cache }
}
const pool = (slot: number) => ({
  type: 'pool',
  slot,
  ts: slot,
  capital_total: '1',
  protocol_liquidity: '1',
  locked_total: '0',
  fees_accrued: '0',
  insurance: '0',
  bad_debt_total: '0',
})

test('backoffMs doubles from 1 s and caps at MAX_BACKOFF_MS', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(backoffMs), [1000, 2000, 4000, 8000, MAX_BACKOFF_MS, MAX_BACKOFF_MS])
})

test('a pool frame patches the poolHistory cache, newest last, capped at POOL_HISTORY_MAX', () => {
  const h = harness()
  h.ws.retain()
  h.sockets[0].open()
  for (let i = 1; i <= POOL_HISTORY_MAX + 5; i++) h.sockets[0].push(pool(i))
  const hist = h.cache.data.get(JSON.stringify(QK.poolHistory)) as PoolSnapshot[]
  assert.equal(hist.length, POOL_HISTORY_MAX)
  assert.equal(hist[hist.length - 1].slot, POOL_HISTORY_MAX + 5)
  assert.equal(hist[0].slot, 6, 'oldest entries are dropped first')
})

test('the shared socket subscribes to every market', () => {
  assert.ok(WS_URL.endsWith('/ws?markets=*'), WS_URL)
})

test("a mark frame patches only its own market's mark cache, keeping the last REST slot", () => {
  const h = harness()
  h.ws.retain()
  h.sockets[0].open()
  const solMark: Mark = { price: 150_000_000n, slot: 9, ts: 1, stale: false, market: 'SOL' }
  h.cache.data.set(JSON.stringify(QK.mark('SOL')), solMark)
  h.cache.data.set(JSON.stringify(QK.mark('BTC')), { price: 1n, slot: 4, ts: 1, stale: false, market: 'BTC' })
  h.sockets[0].push({ type: 'mark', market: 'BTC', price: '65000000000', ts: 2, stale: false })
  assert.deepEqual(h.cache.data.get(JSON.stringify(QK.mark('BTC'))), {
    price: 65_000_000_000n,
    slot: 4,
    ts: 2,
    stale: false,
    market: 'BTC',
  })
  assert.equal(h.cache.data.get(JSON.stringify(QK.mark('SOL'))), solMark, 'SOL cache untouched')
})

test('frames this build does not know are ignored; malformed known frames and non-JSON are counted, never thrown', () => {
  const h = harness()
  h.ws.retain()
  h.sockets[0].open()
  assert.doesNotThrow(() => h.sockets[0].push({ type: 'heartbeat' }))
  assert.doesNotThrow(() => h.sockets[0].push({ type: 'pool', slot: 'x' }))
  assert.doesNotThrow(() => h.sockets[0].pushRaw('{not json'))
  assert.equal(h.ws.shapeErrors, 2)
})

test('reconnect: scheduled with backoff while retained; released to zero -> no reconnect', () => {
  const h = harness()
  h.ws.retain()
  h.sockets[0].open()
  h.sockets[0].drop()
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, 1000)
  h.timers[0].fn()
  assert.equal(h.sockets.length, 2, 'the timer opened a new socket')
  h.sockets[1].drop() // never opened -> attempt 1
  assert.equal(h.timers[1].ms, 2000)
  h.ws.release()
  h.timers[1].fn()
  assert.equal(h.sockets.length, 2, 'nothing retains the socket any more — no reconnect')
})

test('a successful open resets the backoff', () => {
  const h = harness()
  h.ws.retain()
  h.sockets[0].drop()
  h.timers[0].fn()
  h.sockets[1].open()
  h.sockets[1].drop()
  assert.equal(h.timers[1].ms, 1000)
})
