// app/src/lib/indexer.ts
//
// Task 9: client for the relayer's Task-5 public-data indexer
// (`services/relayer/src/indexer/{http,store,accounts}.ts`). REST hooks are
// plain react-query `useQuery`s against `RELAYER_URL`; JSON shapes below
// mirror the relayer's response bodies field-for-field, including its
// snake_case column names and "bigint as decimal string" convention
// (`indexer/http.ts`'s header comment: never `Number(...)`-coerced there,
// since e.g. `capital_total` could exceed 2^53 as USDC volume grows) — this
// file is the one place those strings become real `bigint`s for the rest of
// the app — via `indexerCodec.ts` (week 6): every REST body and WS frame is
// validated against the relayer's shape and rejected BY FIELD NAME, so a
// backend rename fails loudly instead of as `BigInt(undefined)` in a hook.
//
// One shared WS connection (module-level singleton, RN's global
// `WebSocket` — not the `ws` package the relayer itself uses) patches the
// matching query-cache entries on `mark`/`pool`/`disclosure` frames, so a
// screen using these hooks gets push updates between REST refetches without
// opening its own socket. Reconnects with exponential backoff (1s, 2s, 4s,
// ... capped at `MAX_BACKOFF_MS`); `useIndexerConnected()` exposes the
// connection state for a small "live vs polling" indicator.
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { RELAYER_URL } from './solana'
import { IndexerShapeError, parseCandles, parseDisclosure, parseMark, parsePoolSnapshot, parseRootLatest, parseWsFrame } from './indexerCodec'

const WS_URL = `${RELAYER_URL.replace(/^http/, 'ws')}/ws`

/** `GET /prices` candle — o/h/l/c are plain numbers (relayer convention). */
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
}
export interface RootLatest {
  root_slot: number
  filled: number
  leavesHex: string[]
}

// --- converted (bigint) views handed to callers ---

export interface Mark {
  price: bigint | null
  slot: number | null
  ts: number | null
  stale: boolean
}
export interface PoolSnapshot {
  slot: number
  ts: number
  capitalTotal: bigint
  protocolLiquidity: bigint
  lockedTotal: bigint
  feesAccrued: bigint
  insurance: bigint
  badDebtTotal: bigint
}
export interface Disclosure {
  pubkey: string
  side: string
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  reason: string
  openedSlot: bigint
  closedSlot: bigint
  nonce: bigint
  ts: number
}

/** Fetch + validate: `parse` is one of `indexerCodec.ts`'s parsers, so a shape mismatch throws `IndexerShapeError` here (surfacing as the query's `error`), never later. */
async function getJson<T>(path: string, parse: (body: unknown) => T): Promise<T> {
  const res = await fetch(`${RELAYER_URL}${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return parse(await res.json())
}

export const QK = {
  mark: ['indexer', 'mark'] as const,
  candles: (tf: string) => ['indexer', 'candles', tf] as const,
  poolHistory: ['indexer', 'poolHistory'] as const,
  disclosures: ['indexer', 'disclosures'] as const,
  rootLatest: ['indexer', 'rootLatest'] as const,
}

/** Latest oracle mark, `bigint`-converted. REST refetches every 5s; the WS `mark` frame patches the cache in between (see `useIndexerWs` below). */
export function useMark(): UseQueryResult<Mark> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.mark,
    queryFn: () => getJson('/mark', parseMark),
    staleTime: 5_000,
    refetchInterval: 5_000,
  })
}

/** Candle history for one timeframe (`GET /prices?tf=&limit=`) — no bigint fields, o/h/l/c are already plain numbers (relayer's own convention, see `indexer/http.ts`). */
export function useCandles(tf: '1m' | '5m' | '15m' = '1m', limit = 300): UseQueryResult<Candle[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.candles(tf),
    queryFn: () => getJson(`/prices?tf=${tf}&limit=${limit}`, parseCandles),
    staleTime: 30_000,
  })
}

/** `Pool` snapshot history (`GET /pool/history?limit=`), `bigint`-converted, oldest-first (matches the relayer's own ordering). Patched by the WS `pool` frame. */
export function usePoolHistory(limit = 100): UseQueryResult<PoolSnapshot[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.poolHistory,
    queryFn: () => getJson(`/pool/history?limit=${limit}`, (b) => (Array.isArray(b) ? b.map(parsePoolSnapshot) : [])),
    staleTime: 30_000,
  })
}

/** Revealed L1 `Disclosure` feed (`GET /disclosures?limit=`), newest-first, `bigint`-converted. Patched by the WS `disclosure` frame. Not owner-filtered — this is the public 13F feed, not "my history" (see HistoryScreen.tsx for the owner-matched view). */
export function useDisclosures(limit = 100): UseQueryResult<Disclosure[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.disclosures,
    queryFn: () => getJson(`/disclosures?limit=${limit}`, (b) => (Array.isArray(b) ? b.map(parseDisclosure) : [])),
    staleTime: 15_000,
  })
}

/** Latest `BalancesRoot` commit the indexer has observed (`GET /root/latest`) — `null` before the first one lands. */
export function useRootLatest(): UseQueryResult<RootLatest | null> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.rootLatest,
    queryFn: () => getJson('/root/latest', parseRootLatest),
    staleTime: 30_000,
  })
}

// --- shared WS connection ---
//
// Week 6: a class with an injected socket factory and timers instead of
// module-level `let`s — `test/indexerWs.test.ts` drives reconnects, cache
// patches and the history cap without a network. One instance per app
// (`defaultIndexerWs`); the hooks below are thin wrappers over it.

type ConnState = 'connecting' | 'open' | 'closed'

export const MAX_BACKOFF_MS = 15_000
/** Upper bound on the `poolHistory` cache the WS keeps appending to — a long session must not grow it without limit. */
export const POOL_HISTORY_MAX = 200

/** Reconnect delay for the n-th consecutive failed attempt: 1 s, 2 s, 4 s, … capped. */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)
}

/** The subset of a `WebSocket` the client uses (RN's global one, or a fake). */
export interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  close(): void
}
export interface IndexerWsDeps {
  connect: (url: string) => SocketLike
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}
/** The one method of `QueryClient` the WS needs. */
export type CacheLike = Pick<QueryClient, 'setQueryData'>

export class IndexerWs {
  private state: ConnState = 'closed'
  private socket: SocketLike | null = null
  private attempt = 0
  private timer: unknown = null
  private cache: CacheLike | null = null
  private refCount = 0
  private readonly listeners = new Set<(s: ConnState) => void>()
  /** `/ws` frames the codec rejected (or non-JSON) since construction. */
  shapeErrors = 0

  constructor(
    private readonly url: string,
    private readonly deps: IndexerWsDeps,
  ) {}

  get connState(): ConnState {
    return this.state
  }
  attach(cache: CacheLike) {
    this.cache = cache
  }
  subscribe(l: (s: ConnState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  /**
   * Ensures the socket is connected while at least one consumer is mounted.
   * Deliberately does NOT tear the socket down at `refCount === 0` — cheap
   * to hold open across a screen swap, and avoids a reconnect storm from
   * quick mount/unmount churn; it just stops scheduling reconnects once
   * nothing needs it (`scheduleReconnect`'s guard).
   */
  retain() {
    this.refCount += 1
    this.connect()
  }
  release() {
    this.refCount = Math.max(0, this.refCount - 1)
  }

  private setState(s: ConnState) {
    this.state = s
    for (const l of this.listeners) l(s)
  }

  private connect() {
    if (this.socket || this.state === 'connecting') return
    this.setState('connecting')
    let ws: SocketLike
    try {
      ws = this.deps.connect(this.url)
    } catch {
      this.setState('closed')
      this.scheduleReconnect()
      return
    }
    this.socket = ws
    ws.onopen = () => {
      this.attempt = 0
      this.setState('open')
    }
    ws.onmessage = (ev) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(ev.data))
      } catch {
        this.shapeErrors += 1
        if (__DEV__) console.warn('[dexxer] indexer ws: frame is not JSON')
        return
      }
      this.handleFrame(raw) // shape errors are counted + warned inside; anything else propagates
    }
    ws.onerror = () => {
      // RN's WebSocket fires `close` right after `error` — reconnect is scheduled there.
    }
    ws.onclose = () => {
      this.socket = null
      this.setState('closed')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.timer || this.refCount === 0) return
    const delay = backoffMs(this.attempt)
    this.attempt += 1
    this.timer = this.deps.setTimeout(() => {
      this.timer = null
      if (this.refCount > 0) this.connect()
    }, delay)
  }

  /** Apply one parsed `/ws` frame to the query cache — the same shapes the REST hooks fill. */
  handleFrame(raw: unknown) {
    const qc = this.cache
    if (!qc) return
    let frame
    try {
      frame = parseWsFrame(raw)
    } catch (e) {
      if (e instanceof IndexerShapeError) {
        this.shapeErrors += 1
        if (__DEV__) console.warn('[dexxer] indexer ws: frame rejected —', e.message)
        return
      }
      throw e
    }
    if (frame === null) return // a frame type this build does not know
    if (frame.type === 'mark') {
      qc.setQueryData<Mark>(QK.mark, (prev) => ({
        price: frame.price,
        // The `mark` WS frame carries no slot (see accounts.ts's broadcast
        // call) — keep whatever the last REST fetch/poll observed rather than
        // clobbering it with null on every push.
        slot: prev?.slot ?? null,
        ts: frame.ts,
        stale: frame.stale,
      }))
    } else if (frame.type === 'pool') {
      const { type: _t, ...next } = frame
      qc.setQueryData<PoolSnapshot[]>(QK.poolHistory, (prev) =>
        [...(prev ?? []).filter((p) => p.slot !== next.slot), next].slice(-POOL_HISTORY_MAX),
      )
    } else if (frame.type === 'disclosure') {
      const { type: _t, ...next } = frame
      qc.setQueryData<Disclosure[]>(QK.disclosures, (prev) => {
        const list = prev ?? []
        if (list.some((d) => d.pubkey === next.pubkey)) return list
        return [next, ...list]
      })
    }
  }
}

/** The app's instance: RN's global `WebSocket` and timers. Created lazily so importing this module never opens a socket. */
let defaultWs: IndexerWs | null = null
function defaultIndexerWs(): IndexerWs {
  if (!defaultWs) {
    defaultWs = new IndexerWs(WS_URL, {
      connect: (url) => {
        if (typeof WebSocket === 'undefined') throw new Error('WebSocket unavailable')
        return new WebSocket(url) as unknown as SocketLike
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    })
  }
  return defaultWs
}

/** Ensures the shared WS is connected while at least one consumer is mounted, and returns its live connection state. */
function useIndexerWs(): ConnState {
  const qc = useQueryClient()
  const ws = defaultIndexerWs()
  const [state, setState] = useState<ConnState>(ws.connState)
  useEffect(() => {
    ws.attach(qc)
    ws.retain()
    const unsubscribe = ws.subscribe(setState)
    // Catch a state transition that happened between this hook's initial
    // `useState` render and the listener above actually being attached —
    // same "reconcile with an external system on mount" justification
    // `live.ts`/`useTradeSession.ts` use for this exact lint rule.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setState(ws.connState)
    return () => {
      unsubscribe()
      ws.release()
    }
  }, [qc, ws])
  return state
}

/** `true` once the shared indexer WS is connected — mount anywhere (e.g. a small dot near History/Trade) to show live-vs-polling state. */
export function useIndexerConnected(): boolean {
  return useIndexerWs() === 'open'
}
