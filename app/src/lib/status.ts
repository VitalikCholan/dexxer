// app/src/lib/status.ts
//
// Display helpers: USD formatting and the session badge text.

/**
 * ~0.4s/slot on devnet base (CLAUDE.md: devnet-observed slot cadence, same
 * order of magnitude Check8.tsx's ER-slot comment uses for the much faster
 * ER). Display-only — never used for an on-chain decision.
 */
export const DEVNET_SLOT_MS = 400

/**
 * A `u64`/`i64` USD amount at the program's 1e6 fixed point (`PRICE_SCALE`,
 * math.rs) formatted to 2 decimals — e.g. `116_730_000n` -> `'116.73'`.
 * Used by History (`HistoryScreen.tsx`) so entry/exit prices and PnL read the same
 * everywhere: elsewhere in the app (`TradeTicket`, `PositionCard`,
 * `AccountScreen`, `ReceiptSection`) local `usd`/`fmtUsd`
 * helpers already do this same 2-decimal rounding — History was the
 * outlier still at 4dp (observed live, smoke test 23.09.2026: History
 * showed `$116.7300` next to Positions' `$116.71`). Size stays 4dp
 * (`SIZE_SCALE`'s SOL amounts) — unrelated, unaffected by this helper, each
 * screen keeps its own local `fmtSol`/`sol`.
 */
export function formatUsd2(raw1e6: bigint): string {
  return (Number(raw1e6) / 1_000_000).toFixed(2)
}

/**
 * `UserAccount.sessionExpiry` (unix seconds) vs current wall-clock time,
 * formatted for the session badge (`AccountScreen.tsx`). Bug fixed here
 * (observed live, CLAUDE.md week-4 report): the old inline logic derived
 * `hoursLeft` first and only counted the session active when
 * `hoursLeft > 0`, so any remaining time under a full hour (e.g. 57m left)
 * floored to `0` and read as expired even though `expirySec > now`.
 *
 * `expirySec === 0` means the device has no session key yet (never set,
 * distinct from an elapsed one) — `formatSessionLeft` special-cases it to
 * 'No session' rather than 'Session expired'.
 */
export function formatSessionLeft(expirySec: number, nowSec: number, actionsLeft?: number): string {
  if (expirySec === 0) return 'No session'
  if (expirySec <= nowSec) return 'Session expired'
  // Week 6: the action budget is as hard a limit as the expiry (error 6021 past it).
  if (actionsLeft === 0) return 'Session used up'
  const actions = actionsLeft === undefined ? '' : ` · ${actionsLeft} action${actionsLeft === 1 ? '' : 's'}`
  const secsLeft = expirySec - nowSec
  const hoursLeft = Math.floor(secsLeft / 3600)
  if (hoursLeft >= 1) return `Session active · ${hoursLeft}h left${actions}`
  // floor + min 1 so 3599s reads "59m" (not "60m") and 30s still reads "1m"
  const minsLeft = Math.max(1, Math.floor(secsLeft / 60))
  return `Session active · ${minsLeft}m left${actions}`
}
