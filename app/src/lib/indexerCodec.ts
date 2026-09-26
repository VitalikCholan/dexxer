// app/src/lib/indexerCodec.ts
//
// The app-side contract for `services/relayer`'s indexer (week 6). The
// relayer types its responses as `Record<string, unknown>` and its WS frames
// as `{ type; [k]: unknown }`, so nothing on either side checked that the
// bytes on the wire match what `indexer.ts` assumed — a renamed column would
// have surfaced as `BigInt(undefined)` inside a react-query hook (REST) or
// been swallowed by the WS handler's `catch {}` (push). Every parser here
// validates the shape and converts the relayer's "u64/i64 as decimal string"
// convention to `bigint`, throwing `IndexerShapeError` that NAMES the field.
// Shapes: services/relayer/src/indexer/{http,store,accounts}.ts.
import type { Candle, Disclosure, Mark, PoolSnapshot, RootLatest } from './indexer'

export class IndexerShapeError extends Error {
  constructor(
    readonly where: string,
    message: string,
  ) {
    super(`${where}: ${message}`)
    this.name = 'IndexerShapeError'
  }
}

const DECIMAL = /^-?\d+$/

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new IndexerShapeError(where, 'expected an object')
  return v as Record<string, unknown>
}
function num(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new IndexerShapeError(where, `${k}: expected a number, got ${describe(v)}`)
  return v
}
function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k]
  if (typeof v !== 'string') throw new IndexerShapeError(where, `${k}: expected a string, got ${describe(v)}`)
  return v
}
function bool(o: Record<string, unknown>, k: string, where: string): boolean {
  const v = o[k]
  if (typeof v !== 'boolean') throw new IndexerShapeError(where, `${k}: expected a boolean, got ${describe(v)}`)
  return v
}
/** A u64/i64 the relayer serialised as a decimal string (`store.ts`: never `Number(...)`-coerced, values can exceed 2^53). */
function big(o: Record<string, unknown>, k: string, where: string): bigint {
  const v = o[k]
  if (typeof v !== 'string' || !DECIMAL.test(v))
    throw new IndexerShapeError(where, `${k}: expected a decimal string, got ${describe(v)}`)
  return BigInt(v)
}
function describe(v: unknown): string {
  return v === undefined ? 'undefined' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
}

/** `GET /mark` (and the `mark` WS frame, which carries no `slot`). */
export function parseMark(v: unknown): Mark {
  const o = obj(v, 'mark')
  const price = o.price === null ? null : big(o, 'price', 'mark')
  const slot = o.slot === null || o.slot === undefined ? null : num(o, 'slot', 'mark')
  const ts = o.ts === null ? null : num(o, 'ts', 'mark')
  return { price, slot, ts, stale: bool(o, 'stale', 'mark') }
}

/** One row of `GET /pool/history` / `GET /pool/latest`, and the `pool` WS frame. */
export function parsePoolSnapshot(v: unknown): PoolSnapshot {
  const o = obj(v, 'pool')
  return {
    slot: num(o, 'slot', 'pool'),
    ts: num(o, 'ts', 'pool'),
    capitalTotal: big(o, 'capital_total', 'pool'),
    protocolLiquidity: big(o, 'protocol_liquidity', 'pool'),
    lockedTotal: big(o, 'locked_total', 'pool'),
    feesAccrued: big(o, 'fees_accrued', 'pool'),
    insurance: big(o, 'insurance', 'pool'),
    badDebtTotal: big(o, 'bad_debt_total', 'pool'),
  }
}

/** One row of `GET /disclosures`, and the `disclosure` WS frame. */
export function parseDisclosure(v: unknown): Disclosure {
  const o = obj(v, 'disclosure')
  return {
    pubkey: str(o, 'pubkey', 'disclosure'),
    side: str(o, 'side', 'disclosure'),
    size: big(o, 'size', 'disclosure'),
    entry: big(o, 'entry', 'disclosure'),
    exit: big(o, 'exit', 'disclosure'),
    pnl: big(o, 'pnl', 'disclosure'),
    fees: big(o, 'fees', 'disclosure'),
    reason: str(o, 'reason', 'disclosure'),
    openedSlot: big(o, 'opened_slot', 'disclosure'),
    closedSlot: big(o, 'closed_slot', 'disclosure'),
    nonce: big(o, 'nonce', 'disclosure'),
    ts: num(o, 'ts', 'disclosure'),
  }
}

/** `GET /prices` — `{ tf, candles }`; o/h/l/c are plain numbers by the relayer's own convention. */
export function parseCandles(v: unknown): Candle[] {
  const o = obj(v, 'prices')
  if (!Array.isArray(o.candles))
    throw new IndexerShapeError('prices', `candles: expected an array, got ${describe(o.candles)}`)
  return o.candles.map((c, i) => {
    const w = `prices.candles[${i}]`
    const r = obj(c, w)
    return { t: num(r, 't', w), o: num(r, 'o', w), h: num(r, 'h', w), l: num(r, 'l', w), c: num(r, 'c', w) }
  })
}

/** `GET /root/latest` — `null` before the first `BalancesRoot` commit lands. */
export function parseRootLatest(v: unknown): RootLatest | null {
  if (v === null) return null
  const o = obj(v, 'root')
  if (!Array.isArray(o.leavesHex) || !o.leavesHex.every((h) => typeof h === 'string')) {
    throw new IndexerShapeError('root', 'leavesHex: expected an array of hex strings')
  }
  return {
    root_slot: num(o, 'root_slot', 'root'),
    filled: num(o, 'filled', 'root'),
    leavesHex: o.leavesHex as string[],
  }
}

export type WsFrame =
  | { type: 'mark'; price: bigint | null; ts: number; stale: boolean }
  | ({ type: 'pool' } & PoolSnapshot)
  | ({ type: 'disclosure' } & Disclosure)

/**
 * One `/ws` frame. A `type` this build does not know is ignored (`null`) so
 * the relayer can add frames without breaking older clients; a KNOWN type
 * with the wrong shape throws — that is the contract breach worth seeing.
 */
export function parseWsFrame(v: unknown): WsFrame | null {
  const o = obj(v, 'ws')
  switch (o.type) {
    case 'mark': {
      const m = parseMark({ ...o, slot: null })
      return { type: 'mark', price: m.price, ts: num(o, 'ts', 'ws.mark'), stale: m.stale }
    }
    case 'pool':
      return { type: 'pool', ...parsePoolSnapshot(o) }
    case 'disclosure':
      return { type: 'disclosure', ...parseDisclosure(o) }
    default:
      return null
  }
}
