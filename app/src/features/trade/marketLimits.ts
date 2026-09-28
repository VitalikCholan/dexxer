// app/src/features/trade/marketLimits.ts
//
// `Market.min_size` for the ticket's Close tab — `decrease_position` rejects
// a partial close that leaves less than it (`PositionTooSmall`). Kept out of
// `codecs.ts` on purpose: that file changes together with the
// Position/UserAccount layout upgrade (A.2/A.3), `Market` does not.
//
// A fixed offset, as in `codecs.ts`, not Anchor's `BorshAccountsCoder`: its
// `decode` works under Node but threw "undefined is not a function" in the
// RN runtime on-device. `test/marketLimits.test.ts` encodes a `Market` with
// that coder from the IDL and checks this offset reads it back.
import { decodeMarket, type DecodedMarket } from '@/src/lib/codecs'

// discriminator(8) version(1) symbol(8) feed(32) max_lev(4) imr(4) mmr(4)
// open_fee(2) close_fee(2) liq_fee(2) oi_cap(8) max_position(8) -> min_size
const MIN_SIZE_OFFSET = 8 + 1 + 8 + 32 + 4 + 4 + 4 + 2 + 2 + 2 + 8 + 8

export type TicketMarket = DecodedMarket & {
  /** Smallest partial-close remainder, raw 1e9. */
  minSize: bigint
}

/** `decodeMarket` plus `min_size` — one live subscription for the Trade screen. */
export function decodeTicketMarket(data: Buffer): TicketMarket {
  return { ...decodeMarket(data), minSize: data.readBigUInt64LE(MIN_SIZE_OFFSET) }
}
