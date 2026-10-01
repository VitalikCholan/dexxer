// app/src/features/history/historyRows.ts
//
// Pure History view data: archive records -> display rows. No hooks, no I/O.
import type { HistoryReason, SideName } from '@/src/lib/positions'
import type { ArchivedRecord } from './historyArchive'

export interface Row {
  key: string
  symbol: string
  side: SideName
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  closedSlot: bigint
  reason: HistoryReason
  seenAt: number
}

/** Order of `archive` is kept (`mergeArchive` already sorts newest first). */
export function historyRowsFrom(archive: ArchivedRecord[], symbolOf: (market: string) => string): Row[] {
  return archive.map((r) => ({
    key: r.key,
    symbol: symbolOf(r.market),
    side: r.side,
    size: BigInt(r.size),
    entry: BigInt(r.entry),
    exit: BigInt(r.exit),
    pnl: BigInt(r.pnl),
    fees: BigInt(r.fees),
    closedSlot: BigInt(r.closedSlot),
    reason: r.reason,
    seenAt: r.seenAt,
  }))
}

export function reasonLabel(r: HistoryReason): string {
  return r === 'Liquidated' ? 'Liquidated' : r === 'Decrease' ? 'Partial close' : 'Closed'
}
