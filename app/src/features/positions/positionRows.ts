// app/src/features/positions/positionRows.ts
//
// Pure: one row per OPEN slot of `Positions`, in slot-index order. A market is
// never listed without a slot, and a slot is never hidden because the relayer
// registry does not know its market (it shows a shortened key and `market: null`).
import { type DecodedPositions, type PositionSlot } from '@/src/lib/positions'
import { type MarketInfo } from '@/src/lib/markets'

export interface PositionRow {
  slot: PositionSlot
  symbol: string
  /** `null` when the registry does not know this slot's market. */
  market: MarketInfo | null
}

export function positionRows(p: DecodedPositions | null, markets: MarketInfo[]): PositionRow[] {
  if (!p) return []
  return p.slots.map((slot) => {
    const market = markets.find((m) => m.market.equals(slot.market)) ?? null
    return { slot, symbol: market ? market.symbol : slot.market.toBase58().slice(0, 4) + '…', market }
  })
}
