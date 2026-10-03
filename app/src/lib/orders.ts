// app/src/lib/orders.ts
//
// Pure helpers for conditional orders (`programs/dexxer_core/src/state/order.rs`):
// the same trigger directions as the program, so the UI can refuse a price the
// chain would reject (or that would fire on the very next tick), and labels
// for the order list. Prices are raw 1e6 bigints, like everywhere in `lib/`.
import { type DecodedOrder, type OrderKindName, type SideName } from './positions'
import { formatUsd2 } from './status'

export const MIN_TRAIL_BPS = 10
export const MAX_TRAIL_BPS = 5_000

export type ExitKind = 'TakeProfit' | 'StopLoss' | 'TrailingStop'
export type EntryKind = 'Limit' | 'Stop'

/** Does `mark` satisfy this trigger? Mirrors `order::is_triggered`. */
export function isTriggered(kind: OrderKindName, side: SideName, trigger: bigint, mark: bigint): boolean {
  switch (kind) {
    case 'Limit':
      return side === 'Long' ? mark <= trigger : mark >= trigger
    case 'Stop':
      return side === 'Long' ? mark >= trigger : mark <= trigger
    case 'TakeProfit':
      return side === 'Long' ? mark >= trigger : mark <= trigger
    case 'StopLoss':
    case 'TrailingStop':
      return side === 'Long' ? mark <= trigger : mark >= trigger
    default:
      return false
  }
}

/** Where a trailing stop currently sits (`order::trailing_stop_price`: long floors, short ceils). */
export function trailingStopPrice(side: SideName, extreme: bigint, trailBps: number): bigint {
  const t = BigInt(trailBps)
  return side === 'Long' ? (extreme * (10_000n - t)) / 10_000n : (extreme * (10_000n + t) + 9_999n) / 10_000n
}

/**
 * `null` when a TP/SL at `trigger` is acceptable on an open `side` position,
 * otherwise a short reason. A TP/SL already past the mark would fire on the next
 * tick, which the program refuses (`InvalidOrder`).
 */
export function validateExit(
  kind: 'TakeProfit' | 'StopLoss',
  side: SideName,
  trigger: bigint,
  mark: bigint | null,
): string | null {
  if (trigger <= 0n) return 'Enter a price'
  if (mark !== null && isTriggered(kind, side, trigger, mark)) {
    const above = (kind === 'TakeProfit') === (side === 'Long')
    return `Must be ${above ? 'above' : 'below'} the current price`
  }
  return null
}

/**
 * Same check for the TP/SL attached to a new entry order, which hang off the
 * entry trigger (or, for a market order, the current mark) rather than the mark.
 */
export function validateAttached(side: SideName, entry: bigint, tp: bigint, sl: bigint): string | null {
  if (side === 'Long') {
    if (tp !== 0n && tp <= entry) return 'Take profit must be above the entry price'
    if (sl !== 0n && sl >= entry) return 'Stop loss must be below the entry price'
  } else {
    if (tp !== 0n && tp >= entry) return 'Take profit must be below the entry price'
    if (sl !== 0n && sl <= entry) return 'Stop loss must be above the entry price'
  }
  return null
}

export function validateTrail(bps: number): string | null {
  if (!Number.isInteger(bps) || bps < MIN_TRAIL_BPS || bps > MAX_TRAIL_BPS) {
    return `Trail must be between ${MIN_TRAIL_BPS / 100}% and ${MAX_TRAIL_BPS / 100}%`
  }
  return null
}

const KIND_LABEL: Record<Exclude<OrderKindName, 'None'>, string> = {
  Limit: 'Limit',
  Stop: 'Stop',
  TakeProfit: 'Take profit',
  StopLoss: 'Stop loss',
  TrailingStop: 'Trailing stop',
}

export function kindLabel(kind: Exclude<OrderKindName, 'None'>): string {
  return KIND_LABEL[kind]
}

/** One-line description for the order list. */
export function describeOrder(o: DecodedOrder): { title: string; detail: string } {
  if (o.kind === 'TrailingStop') {
    const pct = (o.trailBps / 100).toFixed(2).replace(/\.?0+$/, '')
    const stop = trailingStopPrice(o.side, o.extreme, o.trailBps)
    return {
      title: `${kindLabel(o.kind)} ${pct}%`,
      detail: `stops at $${formatUsd2(stop)} · best $${formatUsd2(o.extreme)}`,
    }
  }
  if (o.kind === 'TakeProfit' || o.kind === 'StopLoss') {
    return { title: kindLabel(o.kind), detail: `at $${formatUsd2(o.trigger)}` }
  }
  const sol = (Number(o.size) / 1e9).toFixed(4)
  const exits = [o.tp ? `TP $${formatUsd2(o.tp)}` : '', o.sl ? `SL $${formatUsd2(o.sl)}` : '']
    .filter(Boolean)
    .join(' · ')
  return {
    title: `${kindLabel(o.kind)} ${o.side === 'Long' ? 'buy' : 'sell'} ${sol} SOL`,
    detail: `at $${formatUsd2(o.trigger)}${exits ? ` · ${exits}` : ''}`,
  }
}
