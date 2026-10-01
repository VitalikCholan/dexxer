// app/src/features/history/historyArchive.ts
//
// Pure half of the on-device History archive (spec §2.9.4): every ring record
// this device has seen. The ring holds 16 and overwrites the oldest on the 17th
// close; the archive only ever grows, so depth is not limited to 16. Bigints are
// decimal strings (JSON). No AsyncStorage here — `historyArchiveStore.ts` does
// the I/O, so Node tests can load this file.
import { historyKey, type HistoryReason, type HistoryRecord, type SideName } from '@/src/lib/positions'

export interface ArchivedRecord {
  key: string
  market: string
  side: SideName
  size: string
  entry: string
  exit: string
  pnl: string
  fees: string
  openedSlot: string
  closedSlot: string
  reason: HistoryReason
  /** `Date.now()` when this device first saw the record (ER slots carry no unix time). */
  seenAt: number
}

export function toArchived(r: HistoryRecord, seenAt: number): ArchivedRecord {
  return {
    key: historyKey(r),
    market: r.market.toBase58(),
    side: r.side,
    size: r.size.toString(),
    entry: r.entry.toString(),
    exit: r.exit.toString(),
    pnl: r.pnl.toString(),
    fees: r.fees.toString(),
    openedSlot: r.openedSlot.toString(),
    closedSlot: r.closedSlot.toString(),
    reason: r.reason,
    seenAt,
  }
}

/** Adds ring records not yet archived (by `historyKey`), keeps every existing one, newest `closedSlot` first. */
export function mergeArchive(existing: ArchivedRecord[], ring: HistoryRecord[], now: number): ArchivedRecord[] {
  const seen = new Set(existing.map((r) => r.key))
  const added: ArchivedRecord[] = []
  for (const r of ring) {
    const key = historyKey(r)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(toArchived(r, now))
  }
  return [...existing, ...added].sort((a, b) => {
    const d = BigInt(b.closedSlot) - BigInt(a.closedSlot)
    return d > 0n ? 1 : d < 0n ? -1 : 0
  })
}
