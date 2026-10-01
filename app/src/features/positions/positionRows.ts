// app/src/features/positions/positionRows.ts
//
// Pure: one row per OPEN slot of `Positions`, in slot-index order. A market is
// never listed without a slot, and a slot is never hidden because the relayer
// registry does not know its market (it shows a shortened key and `market: null`).
import { type DecodedPositions, type PositionSlot } from '@/src/lib/positions'
import { type PublicKey } from '@solana/web3.js'
import { type MarketInfo } from '@/src/lib/markets'
import { type DecodedMarket } from '@/src/lib/codecs'
import { pdas } from '@/src/lib/pdas'

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

/** The decoded public `Market` really is the account at `slotMarket` (its symbol seeds the PDA) — guards a stale live value right after the active card changes. */
export function marketMatches(slotMarket: PublicKey, decoded: DecodedMarket | null): decoded is DecodedMarket {
  if (!decoded) return false
  try {
    return pdas.marketFor(decoded.symbol).equals(slotMarket)
  } catch {
    return false
  }
}

/** Registry symbol, else the live Market's own symbol once loaded, else the shortened key. */
export function displaySymbol(row: PositionRow, live: DecodedMarket | null): string {
  if (row.market) return row.market.symbol
  return marketMatches(row.slot.market, live) && live.symbol ? live.symbol : row.symbol
}

/** What the trade instructions need — straight from the slot's own Market account, registry not involved. */
export function controlTarget(row: PositionRow, live: DecodedMarket | null): { market: PublicKey; feed: PublicKey } | null {
  return marketMatches(row.slot.market, live) ? { market: row.slot.market, feed: live.feed } : null
}
