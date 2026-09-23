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
// the app.
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

const WS_URL = `${RELAYER_URL.replace(/^http/, 'ws')}/ws`

// --- REST response shapes (services/relayer/src/indexer/http.ts) ---

export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
}
interface PricesResponse {
  tf: string
  candles: Candle[]
}
interface MarkResponse {
  price: string | null
  slot: number | null
  ts: number | null
  stale: boolean
}
interface PoolSnapshotJson {
  slot: number
  ts: number
  capital_total: string
  protocol_liquidity: string
  locked_total: string
  fees_accrued: string
  insurance: string
  bad_debt_total: string
}
interface DisclosureJson {
  pubkey: string
  side: string
  size: string
  entry: string
  exit: string
  pnl: string
  fees: string
  reason: string
  opened_slot: string
  closed_slot: string
  nonce: string
  ts: number
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

function toMark(j: MarkResponse): Mark {
  return { price: j.price !== null ? BigInt(j.price) : null, slot: j.slot, ts: j.ts, stale: j.stale }
}
function toPoolSnapshot(j: PoolSnapshotJson): PoolSnapshot {
  return {
    slot: j.slot,
    ts: j.ts,
    capitalTotal: BigInt(j.capital_total),
    protocolLiquidity: BigInt(j.protocol_liquidity),
    lockedTotal: BigInt(j.locked_total),
    feesAccrued: BigInt(j.fees_accrued),
    insurance: BigInt(j.insurance),
    badDebtTotal: BigInt(j.bad_debt_total),
  }
}
function toDisclosure(j: DisclosureJson): Disclosure {
  return {
    pubkey: j.pubkey,
    side: j.side,
    size: BigInt(j.size),
    entry: BigInt(j.entry),
    exit: BigInt(j.exit),
    pnl: BigInt(j.pnl),
    fees: BigInt(j.fees),
    reason: j.reason,
    openedSlot: BigInt(j.opened_slot),
    closedSlot: BigInt(j.closed_slot),
    nonce: BigInt(j.nonce),
    ts: j.ts,
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${RELAYER_URL}${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return (await res.json()) as T
}

const QK = {
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
    queryFn: async () => toMark(await getJson<MarkResponse>('/mark')),
    staleTime: 5_000,
    refetchInterval: 5_000,
  })
}

/** Candle history for one timeframe (`GET /prices?tf=&limit=`) — no bigint fields, o/h/l/c are already plain numbers (relayer's own convention, see `indexer/http.ts`). */
export function useCandles(tf: '1m' | '5m' | '15m' = '1m', limit = 300): UseQueryResult<Candle[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.candles(tf),
    queryFn: async () => (await getJson<PricesResponse>(`/prices?tf=${tf}&limit=${limit}`)).candles,
    staleTime: 30_000,
  })
}

/** `Pool` snapshot history (`GET /pool/history?limit=`), `bigint`-converted, oldest-first (matches the relayer's own ordering). Patched by the WS `pool` frame. */
export function usePoolHistory(limit = 100): UseQueryResult<PoolSnapshot[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.poolHistory,
    queryFn: async () => (await getJson<PoolSnapshotJson[]>(`/pool/history?limit=${limit}`)).map(toPoolSnapshot),
    staleTime: 30_000,
  })
}

/** Revealed L1 `Disclosure` feed (`GET /disclosures?limit=`), newest-first, `bigint`-converted. Patched by the WS `disclosure` frame. Not owner-filtered — this is the public 13F feed, not "my history" (see HistoryScreen.tsx for the owner-matched view). */
export function useDisclosures(limit = 100): UseQueryResult<Disclosure[]> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.disclosures,
    queryFn: async () => (await getJson<DisclosureJson[]>(`/disclosures?limit=${limit}`)).map(toDisclosure),
    staleTime: 15_000,
  })
}

/** Latest `BalancesRoot` commit the indexer has observed (`GET /root/latest`) — `null` before the first one lands. */
export function useRootLatest(): UseQueryResult<RootLatest | null> {
  useIndexerWs()
  return useQuery({
    queryKey: QK.rootLatest,
    queryFn: () => getJson<RootLatest | null>('/root/latest'),
    staleTime: 30_000,
  })
}

// --- shared WS connection ---

type WsFrame =
  | { type: 'mark'; price: string | null; ts: number; stale: boolean }
  | ({ type: 'pool' } & PoolSnapshotJson)
  | ({ type: 'disclosure' } & DisclosureJson)

type ConnState = 'connecting' | 'open' | 'closed'

const listeners = new Set<(s: ConnState) => void>()
let connState: ConnState = 'closed'
let socket: WebSocket | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let queryClientRef: QueryClient | null = null
let refCount = 0

const MAX_BACKOFF_MS = 15_000

function setConnState(s: ConnState) {
  connState = s
  for (const l of listeners) l(s)
}

function handleFrame(frame: WsFrame) {
  const qc = queryClientRef
  if (!qc) return
  if (frame.type === 'mark') {
    qc.setQueryData<Mark>(QK.mark, (prev) => ({
      price: frame.price !== null ? BigInt(frame.price) : null,
      // The `mark` WS frame carries no slot (see accounts.ts's broadcast
      // call) — keep whatever the last REST fetch/poll observed rather than
      // clobbering it with null on every push.
      slot: prev?.slot ?? null,
      ts: frame.ts,
      stale: frame.stale,
    }))
  } else if (frame.type === 'pool') {
    const next = toPoolSnapshot(frame)
    qc.setQueryData<PoolSnapshot[]>(QK.poolHistory, (prev) => [...(prev ?? []).filter((p) => p.slot !== next.slot), next])
  } else if (frame.type === 'disclosure') {
    const next = toDisclosure(frame)
    qc.setQueryData<Disclosure[]>(QK.disclosures, (prev) => {
      const list = prev ?? []
      if (list.some((d) => d.pubkey === next.pubkey)) return list
      return [next, ...list]
    })
  }
}

function connectWs() {
  if (socket || connState === 'connecting' || typeof WebSocket === 'undefined') return
  setConnState('connecting')
  let ws: WebSocket
  try {
    ws = new WebSocket(WS_URL)
  } catch {
    setConnState('closed')
    scheduleReconnect()
    return
  }
  socket = ws
  ws.onopen = () => {
    reconnectAttempt = 0
    setConnState('open')
  }
  ws.onmessage = (ev) => {
    try {
      handleFrame(JSON.parse(String(ev.data)) as WsFrame)
    } catch {
      // malformed/unknown frame — ignore, the next one retries
    }
  }
  ws.onerror = () => {
    // RN's WebSocket fires `close` right after `error` — reconnect is scheduled there.
  }
  ws.onclose = () => {
    socket = null
    setConnState('closed')
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer || refCount === 0) return
  const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_BACKOFF_MS)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (refCount > 0) connectWs()
  }, delay)
}

/**
 * Ensures the shared WS is connected while at least one consumer is
 * mounted, and returns its live connection state. Deliberately does NOT
 * tear the socket down at `refCount === 0` — cheap to hold open across a
 * screen swap within the same tab bar, and avoids a reconnect storm from
 * quick mount/unmount churn; it just stops scheduling reconnects once
 * nothing needs it (`scheduleReconnect`'s `refCount === 0` guard).
 */
function useIndexerWs(): ConnState {
  const qc = useQueryClient()
  const [state, setState] = useState<ConnState>(connState)
  useEffect(() => {
    queryClientRef = qc
    refCount += 1
    connectWs()
    const listener = (s: ConnState) => setState(s)
    listeners.add(listener)
    // Catch a `connState` transition that happened between this hook's
    // initial `useState(connState)` render and the listener above actually
    // being attached (e.g. another consumer's `connectWs()` already
    // resolved) — same "reconcile with an external system on mount"
    // justification `live.ts`/`useTradeSession.ts` already use elsewhere in
    // this app for this exact lint rule.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setState(connState)
    return () => {
      listeners.delete(listener)
      refCount = Math.max(0, refCount - 1)
    }
  }, [qc])
  return state
}

/** `true` once the shared indexer WS is connected — mount anywhere (e.g. a small dot near History/Trade) to show live-vs-polling state. */
export function useIndexerConnected(): boolean {
  return useIndexerWs() === 'open'
}
