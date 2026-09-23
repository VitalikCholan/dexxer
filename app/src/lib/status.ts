// app/src/lib/status.ts
//
// Task 9: disclosure status derivation + slot-time formatting, so
// HistoryScreen doesn't hand-roll the 13F lifecycle's state machine inline.
//
// Lifecycle of one closed trade (programs/dexxer_core/src/instructions/
// {commit,disclosure}.rs, state/{position,disclosure}.rs — verified against
// current Rust source, 23-Sep-2026, per CLAUDE.md):
//
//   1. `close_position` (trade.rs): `Position.state = Closed`,
//      `Position.closed = Some(rec)`, `rec.commitment_written = false`.
//      -> 'committing'
//   2. `commit_aggregate`'s `process_position_candidate` (commit.rs), once
//      this `Position` is submitted in `remaining_accounts`: emits the
//      `write_commitment` post-commit action (creates the L1 `Commitment`
//      PDA) and flips `rec.commitment_written = true` on the SAME live
//      `Position` account this file's callers read.
//      -> 'committed'
//   3. `mark_committed` (disclosure.rs) — crank-only, crank-asserted (spec
//      risk #20: the ER can't read L1, so it trusts the crank-fallback
//      service's observation that the `Commitment` PDA exists on L1):
//      requires `rec.commitment_written`, pushes `rec` into
//      `DisclosureQueue.records`, resets `Position` to `Empty` (`closed =
//      None`). From this point on the record lives ONLY in
//      `DisclosureQueue.records`, with its own `reveal_after_slot`.
//   4. `commit_aggregate`'s `process_disclosure_queue_candidate` /
//      `due_reveals`, once `reveal_after_slot <= slot`: emits
//      `write_disclosure` (creates the anonymized L1 `Disclosure`) and pops
//      the record out of `DisclosureQueue.records`.
//      -> record disappears from both live sources; HistoryScreen matches
//         it to an L1 `Disclosure` by `commitmentHash` (Task 8b) and renders
//         it 'revealed' unconditionally — this file is never consulted for
//         those rows.
//
// So `disclosureStatus` below only ever needs to resolve the FIRST THREE
// states from the two live sources HistoryScreen already reads
// (`Position.closed` via `useLiveAccount`, `DisclosureQueue.records`) —
// 'revealed' is reachable through this function too (a `DisclosureQueue`
// record whose `reveal_after_slot` has already passed but the next
// `commit_aggregate` cycle hasn't popped it yet — optimistic, since the
// bytes back it: `due_reveals` is a certainty once due, not a possibility).

export type DisclosureStatus = 'committing' | 'committed' | 'reveals_in' | 'revealed'

/**
 * ~0.4s/slot on devnet base (CLAUDE.md: devnet-observed slot cadence, same
 * order of magnitude Check8.tsx's ER-slot comment uses for the much faster
 * ER). Display-only — never used for an on-chain decision.
 */
export const DEVNET_SLOT_MS = 400

export interface DisclosureStatusRecord {
  /**
   * `ClosedRecord.commitment_written`. Always `true` for a record read from
   * `DisclosureQueue.records` — it only ever enters the queue via
   * `mark_committed`, which asserts this itself (`require!(rec.
   * commitment_written, ...)`, disclosure.rs).
   */
  commitmentWritten: boolean
  /** `ClosedRecord.reveal_after_slot`. */
  revealAfterSlot: bigint
}

/**
 * Classify a still-pending record (`Position.closed` or one entry of
 * `DisclosureQueue.records`) against the current slot.
 *
 * `hasCommitmentOnL1` defaults to `record.commitmentWritten` — the flag this
 * app already observes locally (flipped by `commit_aggregate` in the same ER
 * tx that also flips it on the live `Position`/`DisclosureQueue` account
 * this file's callers read). Exposed separately so a future caller could
 * override it with an actual L1 `Commitment`-PDA existence check —
 * `mark_committed` is crank-asserted by design (spec risk #20), not verified
 * on-chain, so the two *can* diverge if the crank ever lies; not wired up in
 * Task 9.
 *
 * Passing `slot: null` (e.g. a `Position.closed` row, where reaching
 * 'reveals_in'/'revealed' would be premature — see file header, step 3 has
 * to run first regardless of `reveal_after_slot`) intentionally caps the
 * result at 'committed'.
 */
export function disclosureStatus(
  record: DisclosureStatusRecord,
  slot: bigint | null,
  hasCommitmentOnL1: boolean = record.commitmentWritten,
): DisclosureStatus {
  if (!hasCommitmentOnL1) return 'committing'
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
export function formatSessionLeft(expirySec: number, nowSec: number): string {
  if (expirySec === 0) return 'No session'
  if (expirySec <= nowSec) return 'Session expired'
  const secsLeft = expirySec - nowSec
  const hoursLeft = Math.floor(secsLeft / 3600)
  if (hoursLeft >= 1) return `Session active · ${hoursLeft}h left`
  const minsLeft = Math.ceil(secsLeft / 60)
  return `Session active · ${minsLeft}m left`
}

/**
 * Self-check (no test runner is wired up for this `app/` package — same gap
 * `program.ts`'s `assertLeafGolden`/`assertCommitmentGolden` work around,
 * same pattern followed here): asserts the four `disclosureStatus` branches,
 * `formatSlotsAsTime`'s edges, and `formatSessionLeft`'s branches match this
 * file's doc comments. Throws on mismatch; called once from `__DEV__`
 * startup logging below.
 */
export function assertDisclosureStatusSelfCheck(): void {
  const notWritten = { commitmentWritten: false, revealAfterSlot: 100n }
  const written = { commitmentWritten: true, revealAfterSlot: 100n }
  const cases: [ReturnType<typeof disclosureStatus>, ReturnType<typeof disclosureStatus>][] = [
    [disclosureStatus(notWritten, null), 'committing'],
    [disclosureStatus(notWritten, 200n), 'committing'], // commitment_written gates even with slot past due
    [disclosureStatus(written, null), 'committed'], // Position.closed row: slot capped at null -> never past 'committed'
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
}

if (__DEV__) {
  try {
    assertDisclosureStatusSelfCheck()
    console.log('[dexxer] assertDisclosureStatusSelfCheck: disclosureStatus/formatSlotsAsTime OK')
  } catch (e) {
    console.error('[dexxer] assertDisclosureStatusSelfCheck FAILED', e)
  }
}
