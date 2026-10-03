// app/src/features/trade/marketLimits.ts
//
// `Market.min_size` for the ticket's Close tab — `decrease_position` rejects
// a partial close that leaves less than it (`PositionTooSmall`) — plus the
// rest of the public `Market` parameters the About card and the Trading
// rules tab show. Kept out of
// `codecs.ts` on purpose: that file changes together with the
// Position/UserAccount layout upgrade (A.2/A.3), `Market` does not.
//
// A fixed offset, as in `codecs.ts`, not Anchor's `BorshAccountsCoder`: its
// `decode` works under Node but threw "undefined is not a function" in the
// RN runtime on-device. `test/marketLimits.test.ts` encodes a `Market` with
// that coder from the IDL and checks this offset reads it back.
import { decodeMarket, type DecodedMarket } from '@/src/lib/codecs'

// discriminator(8) version(1) symbol(8) feed(32) max_lev(4) imr(4) mmr(4)
// open_fee(2) close_fee(2) -> liq_fee(2) oi_cap(8) max_position(8) min_size(8)
// max_staleness_secs(8) max_conf_bps(2) max_deviation_bps(2) mark(8)
// mark_slot(8) last_print(8) sample_seq(8) ema_alpha_bps(2) liq_hysteresis_ticks(1) max_stale_ticks(2)
// paused_open(1)
const LIQ_FEE_BPS_OFFSET = 8 + 1 + 8 + 32 + 4 + 4 + 4 + 2 + 2
const OI_CAP_OFFSET = LIQ_FEE_BPS_OFFSET + 2
const MAX_POSITION_OFFSET = OI_CAP_OFFSET + 8
const MIN_SIZE_OFFSET = MAX_POSITION_OFFSET + 8
const MAX_STALENESS_OFFSET = MIN_SIZE_OFFSET + 8
const MAX_CONF_BPS_OFFSET = MAX_STALENESS_OFFSET + 8
const MAX_DEVIATION_BPS_OFFSET = MAX_CONF_BPS_OFFSET + 2
const EMA_ALPHA_BPS_OFFSET = MAX_DEVIATION_BPS_OFFSET + 2 + 8 + 8 + 8 + 8
const LIQ_HYSTERESIS_OFFSET = EMA_ALPHA_BPS_OFFSET + 2
const PAUSED_OPEN_OFFSET = LIQ_HYSTERESIS_OFFSET + 1 + 2

export type TicketMarket = DecodedMarket & {
  /** Smallest open size and partial-close remainder, raw 1e9. */
  minSize: bigint
  /** Largest position notional, raw 1e6. */
  maxPosition: bigint
  /** Per-side open-interest cap, raw 1e6; 0 = 30% of pool capital (`risk::effective_oi_cap`). */
  oiCap: bigint
  liqFeeBps: number
  maxStalenessSecs: number
  /** 0 = confidence not checked (`oracle.rs`). */
  maxConfBps: number
  maxDeviationBps: number
  emaAlphaBps: number
  liqHysteresisTicks: number
  pausedOpen: boolean
}

/** `decodeMarket` plus the rest of the public parameters — one live subscription for the Trade screen. */
export function decodeTicketMarket(data: Buffer): TicketMarket {
  return {
    ...decodeMarket(data),
    minSize: data.readBigUInt64LE(MIN_SIZE_OFFSET),
    maxPosition: data.readBigUInt64LE(MAX_POSITION_OFFSET),
    oiCap: data.readBigUInt64LE(OI_CAP_OFFSET),
    liqFeeBps: data.readUInt16LE(LIQ_FEE_BPS_OFFSET),
    maxStalenessSecs: Number(data.readBigUInt64LE(MAX_STALENESS_OFFSET)),
    maxConfBps: data.readUInt16LE(MAX_CONF_BPS_OFFSET),
    maxDeviationBps: data.readUInt16LE(MAX_DEVIATION_BPS_OFFSET),
    emaAlphaBps: data.readUInt16LE(EMA_ALPHA_BPS_OFFSET),
    liqHysteresisTicks: data.readUInt8(LIQ_HYSTERESIS_OFFSET),
    pausedOpen: data.readUInt8(PAUSED_OPEN_OFFSET) !== 0,
  }
}
