// app/src/lib/status.ts
//
// Task 9: disclosure status derivation + slot-time formatting, so
// HistoryScreen doesn't hand-roll the 13F lifecycle's state machine inline.
//
// Lifecycle of one closed trade (programs/dexxer_core/src/instructions/
// {trade,commit}.rs, state/{position,disclosure}.rs — verified against
// current Rust source, 23-Sep-2026, per CLAUDE.md; rewritten for week-5
// Task 1's queue-first model, which retired the old `Position.closed` /
// `mark_committed` hop this comment used to describe):
//
//   1. `close_position` (trade.rs)'s `finalize_close` pushes a brand-new
//      `ClosedRecord` straight into `DisclosureQueue.records` — no
//      intermediate stop on `Position` — with `commitment_written = false`,
//      and resets `Position` to `Empty` in the SAME instruction.
//      `Position.closed: Option<ClosedRecord>` still exists in the struct
//      but is always `None` from this app's point of view; it is no longer
//      a data source (`codecs.ts`'s `DecodedPosition` doesn't decode it).
//      -> 'pending_commitment'
//   2. `commit_aggregate`'s `process_disclosure_queue_candidate` /
//      `pending_commitments` (commit.rs), once this owner's `DisclosureQueue`
//      is submitted in `remaining_accounts`: emits the `write_commitment`
//      post-commit action (creates the L1 `Commitment` PDA) and flips
//      `rec.commitment_written = true` directly on the record, in place,
//      inside the same queue this file's callers already read. There is no
//      separate `mark_committed` step any more — the record never moves
//      accounts again until it is revealed.
//      -> 'committed' (or 'reveals_in' once `reveal_after_slot` is known and
//         still in the future)
//   3. `commit_aggregate`'s `due_reveals`, once `reveal_after_slot <= slot`:
//      emits `write_disclosure` (creates the anonymized L1 `Disclosure`) and
//      pops the record out of `DisclosureQueue.records`.
//      -> record disappears from the queue; HistoryScreen matches it to an
//         L1 `Disclosure` by `commitmentHash` (Task 8b) and renders it
//         'revealed' unconditionally — this file is never consulted for
//         those rows.
//
// So `disclosureStatus` below only ever needs to resolve the first two
// states off `DisclosureQueue.records` (History's only live/pending
// source — see `useHistoryRows.ts`) — 'revealed' is reachable through this
// function too (a queue record whose `reveal_after_slot` has already passed
// but the next `commit_aggregate` cycle hasn't popped it yet — optimistic,
// since the bytes back it: `due_reveals` is a certainty once due, not a
// possibility).

export type DisclosureStatus = 'pending_commitment' | 'committed' | 'reveals_in' | 'revealed'

/**
 * ~0.4s/slot on devnet base (CLAUDE.md: devnet-observed slot cadence, same
 * order of magnitude Check8.tsx's ER-slot comment uses for the much faster
 * ER). Display-only — never used for an on-chain decision.
 */
export const DEVNET_SLOT_MS = 400

export interface DisclosureStatusRecord {
  /**
   * `ClosedRecord.commitment_written` — `false` the instant `close_position`
   * pushes a fresh record into `DisclosureQueue.records` (queue-first model,
   * week-5 Task 1), flipped to `true` in place by `commit_aggregate`'s
   * `pending_commitments` once it writes that record's L1 `Commitment` PDA.
   */
  commitmentWritten: boolean
  /** `ClosedRecord.reveal_after_slot`. */
  revealAfterSlot: bigint
}

/**
 * Classify a still-pending `DisclosureQueue.records` entry against the
 * current slot.
 *
 * `hasCommitmentOnL1` defaults to `record.commitmentWritten` — the flag this
 * app already observes locally (flipped by `commit_aggregate` in the same ER
 * tx that writes the L1 `Commitment` PDA). Exposed separately so a future
 * caller could override it with an actual L1 `Commitment`-PDA existence
 * check — that flip is crank-asserted by design (spec risk #20), not
 * independently verified on-chain, so the two *can* diverge if the crank
 * ever lies; not wired up here.
 *
 * `slot: null` (the queue's slot hasn't loaded yet) intentionally caps the
 * result at 'committed' rather than guessing 'reveals_in'/'revealed'.
 */
export function disclosureStatus(
  record: DisclosureStatusRecord,
  slot: bigint | null,
  hasCommitmentOnL1: boolean = record.commitmentWritten,
): DisclosureStatus {
  if (!hasCommitmentOnL1) return 'pending_commitment'
  if (slot === null) return 'committed'
  return record.revealAfterSlot > slot ? 'reveals_in' : 'revealed'
}

/** `n` slots at `DEVNET_SLOT_MS`/slot, formatted `Xm Ys` (or just `Ys` under a minute) — display only, clamps negative input to `0s`. */
export function formatSlotsAsTime(n: bigint): string {
  if (n <= 0n) return '0s'
  const totalSec = (n * BigInt(DEVNET_SLOT_MS)) / 1000n
  const mins = totalSec / 60n
  const secs = totalSec % 60n
  return mins > 0n ? `${mins}m ${secs}s` : `${secs}s`
}

/**
 * A `u64`/`i64` USD amount at the program's 1e6 fixed point (`PRICE_SCALE`,
 * math.rs) formatted to 2 decimals — e.g. `116_730_000n` -> `'116.73'`.
 * Shared by History (`HistoryScreen.tsx`) and Ledger's disclosure feed
 * (`ledger/DisclosuresTab.tsx`) so entry/exit prices and PnL read the same
 * everywhere: elsewhere in the app (`TradeTicket`, `PositionCard`,
 * `AccountScreen`, `ReceiptSection`, `PositionScreen`) local `usd`/`fmtUsd`
 * helpers already do this same 2-decimal rounding — History/Ledger were the
 * two outliers still at 4dp (observed live, smoke test 23.09.2026: History
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

/**
 * Self-check (no test runner is wired up for this `app/` package — same gap
 * `hashes.ts`'s `assertLeafGolden`/`assertCommitmentGolden` work around,
 * same pattern followed here): asserts the four `disclosureStatus` branches,
 * `formatSlotsAsTime`'s edges, and `formatSessionLeft`'s branches match this
 * file's doc comments. Throws on mismatch; called once from `__DEV__`
 * startup logging below.
 */
export function assertDisclosureStatusSelfCheck(): void {
  const notWritten = { commitmentWritten: false, revealAfterSlot: 100n }
  const written = { commitmentWritten: true, revealAfterSlot: 100n }
  const cases: [ReturnType<typeof disclosureStatus>, ReturnType<typeof disclosureStatus>][] = [
    [disclosureStatus(notWritten, null), 'pending_commitment'],
    [disclosureStatus(notWritten, 200n), 'pending_commitment'], // commitment_written gates even with slot past due
    [disclosureStatus(written, null), 'committed'], // slot not loaded yet: capped at null -> never past 'committed'
    [disclosureStatus(written, 50n), 'reveals_in'], // 50 < revealAfterSlot(100)
    [disclosureStatus(written, 100n), 'revealed'], // due exactly at revealAfterSlot
    [disclosureStatus(written, 150n), 'revealed'],
  ]
  for (const [got, expected] of cases) {
    if (got !== expected) {
      throw new Error(`assertDisclosureStatusSelfCheck: disclosureStatus mismatch — got ${got}, expected ${expected}`)
    }
  }
  const timeCases: [string, string][] = [
    [formatSlotsAsTime(0n), '0s'],
    [formatSlotsAsTime(-5n), '0s'],
    [formatSlotsAsTime(1n), '0s'], // 1 slot * 400ms = 400ms, truncates to 0s
    [formatSlotsAsTime(5n), '2s'], // 5 * 400ms = 2000ms
    [formatSlotsAsTime(150n), '1m 0s'], // 150 * 400ms = 60000ms
    [formatSlotsAsTime(155n), '1m 2s'],
  ]
  for (const [got, expected] of timeCases) {
    if (got !== expected) {
      throw new Error(`assertDisclosureStatusSelfCheck: formatSlotsAsTime mismatch — got ${got}, expected ${expected}`)
    }
  }
  const sessionCases: [string, string][] = [
    [formatSessionLeft(0, 1000), 'No session'],
    [formatSessionLeft(1000, 1000), 'Session expired'], // expirySec === now
    [formatSessionLeft(900, 1000), 'Session expired'], // expirySec < now
    [formatSessionLeft(1000 + 30, 1000), 'Session active · 1m left'], // 30s left, ceils up from 0m
    [formatSessionLeft(1000 + 57 * 60, 1000), 'Session active · 57m left'], // the observed live bug: 57m left must NOT read expired
    [formatSessionLeft(1000 + 3599, 1000), 'Session active · 59m left'], // just under an hour stays in minutes
    [formatSessionLeft(1000 + 3600, 1000), 'Session active · 1h left'], // exactly an hour switches to hours
    [formatSessionLeft(1000 + 2 * 3600 + 100, 1000), 'Session active · 2h left'],
  ]
  for (const [got, expected] of sessionCases) {
    if (got !== expected) {
      throw new Error(`assertDisclosureStatusSelfCheck: formatSessionLeft mismatch — got ${got}, expected ${expected}`)
    }
  }
  const usdCases: [string, string][] = [
    [formatUsd2(116_730_000n), '116.73'], // the observed live mismatch — History used to show 116.7300
    [formatUsd2(-40_000n), '-0.04'], // PnL, negative
    [formatUsd2(0n), '0.00'],
  ]
  for (const [got, expected] of usdCases) {
    if (got !== expected) {
      throw new Error(`assertDisclosureStatusSelfCheck: formatUsd2 mismatch — got ${got}, expected ${expected}`)
    }
  }
}

if (__DEV__) {
  try {
    assertDisclosureStatusSelfCheck()
    console.log('[dexxer] assertDisclosureStatusSelfCheck: disclosureStatus/formatSlotsAsTime/formatUsd2 OK')
  } catch (e) {
    console.error('[dexxer] assertDisclosureStatusSelfCheck FAILED', e)
  }
}
