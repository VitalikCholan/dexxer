// app/src/lib/math.ts
//
// Task 10: client-side port of programs/dexxer_core/src/math.rs's pure
// formulas — bigint arithmetic, same rounding (always in the pool's favor,
// CLAUDE.md), feeding the Trade ticket's live preview (Entry ≈, Liq. price,
// Fee, Slippage limit) and the Positions screen's Increase/Decrease sheets.
// Every function mirrors its Rust namesake byte-for-byte (verified against
// current Rust source, 23-Sep-2026, per CLAUDE.md's "verify, don't guess").
//
// Leverage convention (this file's own addition, math.rs has no leverage
// concept — the program only ever takes an explicit `margin: u64`): a plain
// integer 1..10×, matching `ui/LeverageSlider`'s step (NOT a bps value).
// `marginForLeverage` is this app's convenience mapping from
// (notional, leverage) -> margin, equivalent to
// `required_margin(notional, 10_000 / leverage)` for leverage values that
// divide 10_000 evenly (1, 2, 4, 5, 10 — not 3/6/7/8/9, where this rounds up
// slightly more aggressively than that exact bps form would; still pool-
// favoring, so never under-collateralizes).
import type { SideName } from './codecs'

export const PRICE_SCALE = 1_000_000n
export const SIZE_SCALE = 1_000_000_000n
export const BPS = 10_000n

function divCeil(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('math: division by zero')
  return (a + (b - 1n)) / b
}

/** `size * price / SIZE_SCALE`, rounded up (math.rs::notional). */
export function notional(size: bigint, price: bigint): bigint {
  return divCeil(size * price, SIZE_SCALE)
}

/** `notional * bps / BPS`, rounded up (math.rs::fee). */
export function fee(ntl: bigint, bps: bigint): bigint {
  return divCeil(ntl * bps, BPS)
}

/** `fee(notional, imr_bps)` (math.rs::required_margin — same formula). */
export function requiredMargin(ntl: bigint, imrBps: bigint): bigint {
  return fee(ntl, imrBps)
}

/**
 * Liquidation price (math.rs::liq_price). Throws if `margin > notional`
 * (leverage below 1x has no liquidation price) or on the Short-side
 * subtraction underflow Rust's `checked_sub` would also reject — callers
 * (`TradeTicket.tsx`) treat a throw as "no preview yet", not an error.
 */
export function liqPrice(side: SideName, entry: bigint, size: bigint, margin: bigint, mmrBps: bigint): bigint {
  const n = notional(size, entry)
  if (n === 0n) throw new Error('math: liqPrice division by zero')
  if (margin > n) throw new Error('math: liqPrice margin > notional (leverage below 1x)')
  const mBps = margin * BPS
  const mmrN = mmrBps * n
  const base = BPS * n
  let num: bigint
  if (side === 'Long') {
    num = base - mBps + mmrN
  } else {
    const sum = base + mBps
    if (mmrN > sum) throw new Error('math: liqPrice short-side underflow')
    num = sum - mmrN
  }
  const raw = entry * num
  return side === 'Long' ? divCeil(raw, base) : raw / base
}

/** `ceil(notional / leverage)` — see file header for the leverage convention. */
export function marginForLeverage(ntl: bigint, leverage: number): bigint {
  if (leverage <= 0) throw new Error('math: leverage must be positive')
  return divCeil(ntl, BigInt(leverage))
}

/**
 * Slippage limit for opening/increasing — same direction as
 * `open_position`/`increase_position`'s require (`trade.rs`): Long buys, so
 * the limit is an UPPER bound (mark × 1.01); Short sells, a LOWER bound
 * (mark × 0.99).
 */
export function openSlippageLimit(side: SideName, markUsd: bigint): bigint {
  return side === 'Long' ? (markUsd * 101n) / 100n : (markUsd * 99n) / 100n
}

/**
 * Slippage limit for closing/decreasing — the OPPOSITE direction of
 * open/increase (`close_position`/`decrease_position`'s require): Long
 * sells, so the limit is a LOWER bound (mark × 0.99); Short buys back, an
 * UPPER bound (mark × 1.01).
 */
export function closeSlippageLimit(side: SideName, markUsd: bigint): bigint {
  return side === 'Long' ? (markUsd * 99n) / 100n : (markUsd * 101n) / 100n
}

// --- __DEV__ self-check: vectors copied verbatim from math.rs's #[cfg(test)] mod ---

export function assertMathSelfCheck(): void {
  const P = 150_000_000n // $150.000000
  const S = 10_000_000_000n // 10 SOL
  const cases: [bigint, bigint][] = [
    [notional(S, P), 1_500_000_000n], // notional_10_sol_at_150
    // 1.000000001 SOL @ $1.00 -> raw 1_000_000_001_000_000 / 1e9 = 1_000_000.001,
    // which must round UP to 1_000_001 (truncation gives 1_000_000). No other
    // vector here divides unevenly, so without this one a `notional` that
    // silently switched to floor passed every check (found by breaking it on
    // purpose under `npm test`). `math.rs` has no counterpart yet — see
    // `notional_10_sol_at_150`'s own "divides evenly" note there.
    [notional(1_000_000_001n, 1_000_000n), 1_000_001n],
    [fee(1_000_001n, 6n), 601n], // fee_rounds_up
    [requiredMargin(1_500_000_000n, 1000n), 150_000_000n], // required_margin_10x
    [liqPrice('Long', P, S, 150_000_000n, 500n), 142_500_000n], // liq_price_long_10x_mmr5
    [liqPrice('Short', P, S, 150_000_000n, 500n), 157_500_000n], // liq_price_short_10x_mmr5
  ]
  for (const [got, expected] of cases) {
    if (got !== expected) {
      throw new Error(`assertMathSelfCheck: mismatch — got ${got}, expected ${expected}`)
    }
  }
}

if (__DEV__) {
  try {
    assertMathSelfCheck()
    console.log('[dexxer] assertMathSelfCheck: math.ts OK (matches math.rs vectors)')
  } catch (e) {
    console.error('[dexxer] assertMathSelfCheck FAILED', e)
  }
}
