// app/src/features/trade/ticketMath.ts
//
// Pure math behind the Trade ticket (week 6: extracted from
// `TradeTicket.tsx` so it runs under `npm test` without React Native).
// Leverage convention: a plain integer 1..10× (`LeverageSlider`'s step), a
// UI convenience — `open_position` only ever sees an explicit margin.
import * as math from '@/src/lib/math'
import { formatUsd2 } from '@/src/lib/status'
import { solSize } from '@/src/lib/trade'
import type { SideName } from '@/src/lib/codecs'

export function safeLiq(side: SideName, entry: bigint, size: bigint, margin: bigint, mmrBps: bigint): bigint | null {
  try {
    return math.liqPrice(side, entry, size, margin, mmrBps)
  } catch {
    return null
  }
}

export interface DerivedTicket {
  /** Margin required at the current (size, leverage), 2-decimal USD string — `'0.00'` while size/mark aren't ready yet. */
  marginUsd: string
  /** `true` iff the derived margin exceeds `available` — `false` (never blocking) while `available` is still `null`/loading. */
  insufficient: boolean
}

/**
 * Pure margin math for the ticket's Margin field, extracted so it can run
 * through `test/ticketMath.test.ts` (and the `__DEV__` self-check below).
 *
 * Bug this fixes (observed live, smoke test 23.09.2026): Size 2 SOL,
 * leverage 2×, Available 100 dUSDC — derived margin ≈$116.71 > 100, but the
 * Margin field showed a malformed `00.00` and "Open Long" stayed enabled.
 * Two separate defects: (1) the old render-time sync only recomputed Margin
 * when the LEVERAGE slider moved (`leverage !== prevLeverage`) — typing a
 * new Size at the already-selected default leverage left the field's text
 * state stale/unsynced from the real required margin, and a `ntl === null`
 * mid-keystroke (Size field momentarily empty/`0`) could set the text to a
 * bare `'0.00'` that then collided with the leftover characters RN's
 * Android decimal-pad `TextInput` was still composing, rendering the two
 * concatenated (`'0'` + `'0.00'` → `'00.00'`); (2) nothing ever compared
 * the margin against `freeMarginUsd`, so Open never blocked on
 * undercollateralization. `deriveTicket` is now the single source of truth
 * for both — one pure computation, always 2-decimal formatted, called
 * fresh every render (see the render-time sync below), so there is no
 * stale text to concatenate with.
 */
export function deriveTicket(args: {
  sizeSol: number
  leverage: number
  markUsd: bigint | null
  available: bigint | null
}): DerivedTicket {
  const { sizeSol, leverage, markUsd, available } = args
  const sizeBig = sizeSol > 0 ? solSize(sizeSol) : 0n
  if (markUsd === null || sizeBig === 0n) {
    return { marginUsd: '0.00', insufficient: false }
  }
  const ntl = math.notional(sizeBig, markUsd)
  const marginBig = math.marginForLeverage(ntl, leverage)
  return {
    marginUsd: formatUsd2(marginBig),
    insufficient: available !== null && marginBig > available,
  }
}

/**
 * Self-check, `lib/status.ts`'s style: asserts `deriveTicket` against the
 * live-observed repro (Size 2 SOL / 2× / mark $116.71 / available $100 →
 * insufficient, NOT `00.00`) plus the not-ready and sufficient-margin
 * branches. Throws on mismatch; called once from `__DEV__` startup logging
 * below.
 */
export function assertDeriveTicketSelfCheck(): void {
  const MARK = 116_710_000n // $116.71 (the smoke-test mark for both this bug and PositionCard's)
  const cases: [DerivedTicket, DerivedTicket][] = [
    // not ready: no mark yet -> '0.00', never blocking
    [
      deriveTicket({ sizeSol: 2, leverage: 2, markUsd: null, available: 100_000_000n }),
      { marginUsd: '0.00', insufficient: false },
    ],
    // not ready: no size yet -> '0.00', never blocking
    [
      deriveTicket({ sizeSol: 0, leverage: 2, markUsd: MARK, available: 100_000_000n }),
      { marginUsd: '0.00', insufficient: false },
    ],
    // the observed repro: 2 SOL @ 2x @ $116.71 -> $116.71 margin, > $100 available
    [
      deriveTicket({ sizeSol: 2, leverage: 2, markUsd: MARK, available: 100_000_000n }),
      { marginUsd: '116.71', insufficient: true },
    ],
    // same size/mark at 5x -> $46.68 margin, <= $50 available -> not insufficient
    [
      deriveTicket({ sizeSol: 2, leverage: 5, markUsd: MARK, available: 50_000_000n }),
      { marginUsd: '46.68', insufficient: false },
    ],
    // available unknown (still loading) -> never blocks, regardless of margin size
    [
      deriveTicket({ sizeSol: 2, leverage: 2, markUsd: MARK, available: null }),
      { marginUsd: '116.71', insufficient: false },
    ],
  ]
  for (const [got, expected] of cases) {
    if (got.marginUsd !== expected.marginUsd || got.insufficient !== expected.insufficient) {
      throw new Error(
        `assertDeriveTicketSelfCheck: mismatch — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      )
    }
  }
}

if (__DEV__) {
  try {
    assertDeriveTicketSelfCheck()
    console.log('[dexxer] assertDeriveTicketSelfCheck: deriveTicket OK')
  } catch (e) {
    console.error('[dexxer] assertDeriveTicketSelfCheck FAILED', e)
  }
}

/**
 * MAX button: margin = everything available, then the smallest integer
 * leverage (1..`maxLev`, the market's cap, `LeverageSlider`'s step) whose derived margin does not
 * exceed it. Ceil (not "nearest") so `deriveTicket`'s pool-favouring
 * round-up lands at-or-under `available`, not over it. Pure bigint — the
 * component used to do this through `Number(...)`.
 */
export function impliedLeverage(ntl: bigint, available: bigint, maxLev = 10): number {
  const cap = BigInt(Math.max(1, Math.floor(maxLev)))
  if (available <= 0n) return 1
  const q = (ntl + available - 1n) / available
  return Number(q < 1n ? 1n : q > cap ? cap : q)
}

/**
 * The slider's range is the MARKET's, not a constant: HYPE/ZEC allow 5×
 * while SOL/BTC/ETH allow 10× (`max_lev_bps`/`imr_bps`). A leverage picked
 * on one market is clamped when the user switches to a tighter one — the
 * program would otherwise reject the open with `InsufficientMargin` (6010),
 * which is exactly what the plan-4 smoke hit on HYPE at 7×.
 */
export function clampLeverage(value: number, maxLev: number): number {
  const cap = Math.max(1, Math.floor(maxLev))
  return Math.min(cap, Math.max(1, Math.round(value)))
}

// --- Close tab and Add margin (C.4) ---

export type CloseBlock = 'no_size' | 'exceeds' | 'remainder_below_min' | null

/** `decrease_position`'s requires: `0 < close ≤ size`, and a partial close must leave at least `min_size`. */
export function closeBlock(closeSize: bigint, posSize: bigint, minSize: bigint | null): CloseBlock {
  if (closeSize <= 0n) return 'no_size'
  if (closeSize > posSize) return 'exceeds'
  if (closeSize < posSize && minSize !== null && posSize - closeSize < minSize) return 'remainder_below_min'
  return null
}

/**
 * What closing `closeSize` at `mark` realizes: PnL (`math.rs::decrease_pnl`
 * is `upnl` on the closed part, truncated toward zero), the close fee, and
 * the margin released pro rata, floored — the remainder keeps the rounding
 * (`trade.rs::decrease_position`).
 */
export function closePreview(
  side: SideName,
  closeSize: bigint,
  posSize: bigint,
  entry: bigint,
  margin: bigint,
  mark: bigint,
  closeFeeBps: bigint,
): { pnl: bigint; fee: bigint; released: bigint } {
  const diff = side === 'Long' ? mark - entry : entry - mark
  return {
    pnl: (closeSize * diff) / math.SIZE_SCALE,
    fee: math.fee(math.notional(closeSize, mark), closeFeeBps),
    released: posSize > 0n ? (margin * closeSize) / posSize : 0n,
  }
}

/** `add_margin` recomputes liq at the same entry/size with the bigger margin (`trade.rs`). Null = no liq price (below 1×). */
export function liqAfterAddMargin(
  side: SideName,
  entry: bigint,
  size: bigint,
  margin: bigint,
  add: bigint,
  mmrBps: bigint,
): bigint | null {
  return safeLiq(side, entry, size, margin + add, mmrBps)
}
