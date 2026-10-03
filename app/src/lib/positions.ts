// app/src/lib/positions.ts
//
// Manual decoder of the zero-copy `Positions` account (spec §2.9.1): a trader's
// positions on every market (16 slots, the market is a FIELD of the slot) and
// the private 16-record history ring. Offsets are the ones
// `offsets_match_the_off_chain_decoders` (programs/dexxer_core/src/state/
// positions.rs) and tests/er/lib/positions.ts pin; Anchor's coder cannot read a
// bytemuck account, and on Hermes it is broken anyway (codecs.ts header).
import { PublicKey } from '@solana/web3.js'

export const MAX_SLOTS = 16
export const HISTORY_LEN = 16
const DISC = 8
const RECORD = 96
const SLOTS_AT = DISC + 32
const HISTORY_AT = DISC + 1568
const HEAD_AT = DISC + 3104
const ORDERS_AT = DISC + 3176
export const ORDER_SLOTS = 8
const ORDER_RECORD = 88
// 3176 B of slots + history, then the conditional-order slots appended at the end (state/order.rs).
export const POSITIONS_SIZE = ORDERS_AT + ORDER_SLOTS * ORDER_RECORD
/** `Positions`' Anchor discriminator — pinned against the IDL by test/positions.test.ts. */
export const POSITIONS_DISC = Uint8Array.from([197, 153, 71, 203, 133, 176, 119, 182])

export const SIDES = ['Long', 'Short'] as const
export type SideName = (typeof SIDES)[number]
export const HISTORY_REASONS = ['User', 'Liquidated', 'Decrease'] as const
export type HistoryReason = (typeof HISTORY_REASONS)[number]

export interface PositionSlot {
  index: number
  market: PublicKey
  size: bigint
  entry: bigint
  margin: bigint
  liqPrice: bigint
  openedSlot: bigint
  oiNotional: bigint
  lastLiqSample: bigint
  side: SideName
  liqTicks: number
}
export interface HistoryRecord {
  market: PublicKey
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  openedSlot: bigint
  closedSlot: bigint
  side: SideName
  reason: HistoryReason
}
/** `OrderKind` discriminants (`OrderKind::as_u8`); 0 is an empty slot. */
export const ORDER_KINDS = ['None', 'Limit', 'Stop', 'TakeProfit', 'StopLoss', 'TrailingStop'] as const
export type OrderKindName = (typeof ORDER_KINDS)[number]
/** Anchor enum argument for each non-empty kind — what `placeOrder` hands to the IDL coder. */
export const ORDER_KIND_ARG: Record<Exclude<OrderKindName, 'None'>, Record<string, object>> = {
  Limit: { limit: {} },
  Stop: { stop: {} },
  TakeProfit: { takeProfit: {} },
  StopLoss: { stopLoss: {} },
  TrailingStop: { trailingStop: {} },
}
export interface DecodedOrder {
  /** Slot index in `Positions.orders` — what `cancel_order` takes. */
  slot: number
  market: PublicKey
  kind: Exclude<OrderKindName, 'None'>
  side: SideName
  trigger: bigint
  size: bigint
  margin: bigint
  trailBps: number
  extreme: bigint
  tp: bigint
  sl: bigint
}
export interface DecodedPositions {
  owner: PublicKey
  /** Open slots only, in slot-index order. */
  slots: PositionSlot[]
  /** Oldest record first. */
  history: HistoryRecord[]
  /** Pending conditional orders of every market, empty slots omitted. */
  orders: DecodedOrder[]
  version: number
  bump: number
}

const side = (b: number): SideName => (b === 1 ? 'Short' : 'Long')
const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32))

export function decodePositions(data: Buffer): DecodedPositions {
  if (data.length !== POSITIONS_SIZE) throw new Error(`Positions: length ${data.length}, expected ${POSITIONS_SIZE}`)
  for (let i = 0; i < DISC; i++) if (data[i] !== POSITIONS_DISC[i]) throw new Error('Positions: discriminator mismatch')

  const slots: PositionSlot[] = []
  for (let i = 0; i < MAX_SLOTS; i++) {
    const at = SLOTS_AT + i * RECORD
    if (data.readUInt8(at + 88) !== 1) continue
    slots.push({
      index: i,
      market: key(data, at),
      size: data.readBigUInt64LE(at + 32),
      entry: data.readBigUInt64LE(at + 40),
      margin: data.readBigUInt64LE(at + 48),
      liqPrice: data.readBigUInt64LE(at + 56),
      openedSlot: data.readBigUInt64LE(at + 64),
      oiNotional: data.readBigUInt64LE(at + 72),
      lastLiqSample: data.readBigUInt64LE(at + 80),
      side: side(data.readUInt8(at + 89)),
      liqTicks: data.readUInt8(at + 90),
    })
  }

  const head = data.readUInt8(HEAD_AT) % HISTORY_LEN
  const len = Math.min(data.readUInt8(HEAD_AT + 1), HISTORY_LEN)
  const history: HistoryRecord[] = []
  for (let k = 0; k < len; k++) {
    const at = HISTORY_AT + ((head - len + k + HISTORY_LEN) % HISTORY_LEN) * RECORD
    history.push({
      market: key(data, at),
      size: data.readBigUInt64LE(at + 32),
      entry: data.readBigUInt64LE(at + 40),
      exit: data.readBigUInt64LE(at + 48),
      pnl: data.readBigInt64LE(at + 56),
      fees: data.readBigUInt64LE(at + 64),
      openedSlot: data.readBigUInt64LE(at + 72),
      closedSlot: data.readBigUInt64LE(at + 80),
      side: side(data.readUInt8(at + 88)),
      reason: HISTORY_REASONS[data.readUInt8(at + 89)] ?? 'User',
    })
  }
  const orders: DecodedOrder[] = []
  for (let i = 0; i < ORDER_SLOTS; i++) {
    const at = ORDERS_AT + i * ORDER_RECORD
    const kind = ORDER_KINDS[data.readUInt8(at + 80)]
    if (!kind || kind === 'None') continue
    orders.push({
      slot: i,
      market: key(data, at),
      kind,
      side: side(data.readUInt8(at + 81)),
      trigger: data.readBigUInt64LE(at + 32),
      size: data.readBigUInt64LE(at + 40),
      margin: data.readBigUInt64LE(at + 48),
      extreme: data.readBigUInt64LE(at + 56),
      tp: data.readBigUInt64LE(at + 64),
      sl: data.readBigUInt64LE(at + 72),
      trailBps: data.readUInt16LE(at + 82),
    })
  }
  return {
    owner: key(data, DISC),
    slots,
    history,
    orders,
    version: data.readUInt8(DISC + 3106),
    bump: data.readUInt8(DISC + 3107),
  }
}

/** Pending orders on one market (the account holds every market's). */
export function ordersFor(p: DecodedPositions | null, market: PublicKey): DecodedOrder[] {
  return p?.orders.filter((o) => o.market.equals(market)) ?? []
}

export function slotFor(p: DecodedPositions | null, market: PublicKey): PositionSlot | null {
  return p?.slots.find((s) => s.market.equals(market)) ?? null
}

/** Identity of one closed trade across reads and devices — the ring has no ids; these fields never repeat for one owner. */
export function historyKey(r: HistoryRecord): string {
  return `${r.market.toBase58()}:${r.openedSlot}:${r.closedSlot}:${r.size}:${r.reason}`
}
