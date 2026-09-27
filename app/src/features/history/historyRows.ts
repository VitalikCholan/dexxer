// app/src/features/history/historyRows.ts
//
// Pure History data: the row shape, per-source row builders, the
// commitment-hash key and the two-source merge (`mergeHistoryRows`, see its
// doc for the dedupe rationale), plus the ≤100-keys-per-RPC `chunk`. No
// hooks, no I/O — `test/selfchecks.test.ts` runs the merge self-check. Split
// out of useHistoryRows.ts (week 6); that file is the hook.
import { PublicKey } from '@solana/web3.js'
import type { DecodedClosedRecord, DecodedDisclosure } from '@/src/lib/codecs'
import { commitmentHash } from '@/src/lib/hashes'
import { disclosureStatus, formatSlotsAsTime, type DisclosureStatus } from '@/src/lib/status'
import type { Tone } from '@/src/ui/styles'

/** `commitmentHash(args, salt)` for a still-pending `DisclosureQueue` entry, hex-encoded — see file header (Task 8b). */
export function recordHash(r: DecodedClosedRecord): string {
  const { salt, commitmentWritten: _commitmentWritten, ...args } = r
  return Buffer.from(commitmentHash(args, salt)).toString('hex')
}

const STATUS_LABEL: Record<DisclosureStatus, string> = {
  pending_commitment: 'Committing…',
  committed: 'Committed — awaiting crank',
  reveals_in: 'Reveals in',
  revealed: 'Revealed ✓',
}
const STATUS_TONE: Record<DisclosureStatus, Tone> = {
  pending_commitment: 'pending',
  committed: 'pending',
  reveals_in: 'warning',
  revealed: 'success',
}

/** `slot === null && status === 'committed'` specifically means "already past its first commit, just don't know the current slot yet" — 'Checking…' is more accurate than the generic 'committed' label (which implies still-awaiting-crank, already false by definition here). */
function rowStatusText(status: DisclosureStatus, revealAfterSlot: bigint, slot: bigint | null): string {
  if (status === 'committed' && slot === null) return 'Checking…'
  if (status === 'reveals_in' && slot !== null) return `Reveals in ${formatSlotsAsTime(revealAfterSlot - slot)}`
  return STATUS_LABEL[status]
}

export interface Row {
  key: string
  side: string
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  closedSlot: bigint
  status: DisclosureStatus
  statusText: string
  tone: Tone
  /** Revealed rows only — the public `Disclosure` account's own address, for an explorer link. */
  explorerPubkey?: string
}

/** `hash` (the commitment hash — see `mergeHistoryRows`) becomes the row's React `key` too, so a row stays visually stable across a status transition instead of remounting. */
function queuePendingRow(hash: string, r: DecodedClosedRecord, slot: bigint | null): Row {
  const status = disclosureStatus(r, slot)
  return {
    key: hash,
    side: r.side,
    size: r.size,
    entry: r.entry,
    exit: r.exit,
    pnl: r.pnl,
    closedSlot: r.closedSlot,
    status,
    statusText: rowStatusText(status, r.revealAfterSlot, slot),
    tone: STATUS_TONE[status],
  }
}

function revealedRow(hash: string, d: DecodedDisclosure, pubkey: PublicKey): Row {
  return {
    key: hash,
    side: d.side,
    size: d.size,
    entry: d.entry,
    exit: d.exit,
    pnl: d.pnl,
    closedSlot: d.closedSlot,
    status: 'revealed',
    statusText: STATUS_LABEL.revealed,
    tone: STATUS_TONE.revealed,
    explorerPubkey: pubkey.toBase58(),
  }
}

/** One revealed `Disclosure` plus the commitment hash it was fetched by — `DecodedDisclosure` itself carries no `salt`/`reveal_after_slot`, so the hash can't be recomputed from it; it has to be threaded through from the `pdas.disclosure(hash)` lookup that found it (see `useRevealedDisclosures` below). */
export interface RevealedEntry {
  hash: string
  pubkey: PublicKey
  disclosure: DecodedDisclosure
}

/**
 * Merge the two live sources into one row per commitment hash — see the
 * file header's "Fix round 1" note for why dedup is needed (independently-
 * paced subscriptions can transiently disagree about a trade's stage) and
 * why precedence is `queue` < `revealed` (a later `Map.set` call for the
 * same key wins, so the higher-stage source always overwrites the lower
 * one). Exported (pure, no hooks) so `assertHistoryMergeSelfCheck` below can
 * exercise it directly.
 */
export function mergeHistoryRows(
  queueRecords: DecodedClosedRecord[],
  revealed: RevealedEntry[],
  slot: bigint | null,
): Row[] {
  const merged = new Map<string, Row>()
  for (const r of queueRecords) {
    const hash = recordHash(r)
    merged.set(hash, queuePendingRow(hash, r, slot))
  }
  for (const { hash, disclosure, pubkey } of revealed) {
    merged.set(hash, revealedRow(hash, disclosure, pubkey))
  }
  return Array.from(merged.values()).sort((a, b) => Number(b.closedSlot - a.closedSlot))
}

/**
 * Self-check (no test runner is wired up for `app/` — same gap/pattern as
 * `hashes.ts`'s golden vectors and `status.ts`'s
 * `assertDisclosureStatusSelfCheck`): feeds ONE synthetic trade present in
 * both sources at once (the exact failure mode Fix round 1 addresses) and
 * asserts `mergeHistoryRows` collapses it to a single row carrying the
 * highest-stage status (`revealed`), not two rows. `RED` per the task-6
 * brief: unlike the old three-source version, this no longer accepts (or
 * needs) a `Position.closed` input at all — that source is gone. Throws on
 * mismatch.
 */
export function assertHistoryMergeSelfCheck(): void {
  const market = new PublicKey(new Uint8Array(32).fill(7))
  const rec: DecodedClosedRecord = {
    market,
    side: 'Long',
    size: 1_000_000_000n,
    entry: 150_000_000n,
    exit: 151_000_000n,
    pnl: 1_000_000n,
    fees: 100n,
    reason: 'User',
    openedSlot: 10n,
    closedSlot: 20n,
    salt: new Uint8Array(32).fill(9),
    nonce: 3n,
    revealAfterSlot: 25n,
    commitmentWritten: true,
  }
  const hash = recordHash(rec)
  const disclosure: DecodedDisclosure = {
    market,
    side: rec.side,
    size: rec.size,
    entry: rec.entry,
    exit: rec.exit,
    pnl: rec.pnl,
    fees: rec.fees,
    reason: rec.reason,
    openedSlot: rec.openedSlot,
    closedSlot: rec.closedSlot,
    nonce: rec.nonce,
  }
  const revealedEntry: RevealedEntry = { hash, pubkey: new PublicKey(new Uint8Array(32).fill(5)), disclosure }

  const rows = mergeHistoryRows([rec], [revealedEntry], 100n)
  if (rows.length !== 1) {
    throw new Error(
      `assertHistoryMergeSelfCheck: expected exactly 1 merged row for one trade in both sources, got ${rows.length}`,
    )
  }
  if (rows[0].status !== 'revealed') {
    throw new Error(`assertHistoryMergeSelfCheck: expected highest-stage status 'revealed', got '${rows[0].status}'`)
  }
}

if (__DEV__) {
  try {
    assertHistoryMergeSelfCheck()
    console.log('[dexxer] assertHistoryMergeSelfCheck: History merge dedupe OK (queue+revealed, no Position source)')
  } catch (e) {
    console.error('[dexxer] assertHistoryMergeSelfCheck FAILED', e)
  }
}

/**
 * Solana RPC's `getMultipleAccounts` accepts at most 100 keys per call, and
 * web3.js's `getMultipleAccountsInfo` is ONE un-chunked RPC request
 * (`getMultipleAccountsInfoAndContext` in `@solana/web3.js`'s `lib/index.cjs.js`)
 * — so a device that has remembered more than 100 commitment hashes would
 * have every revealed-`Disclosure` lookup below rejected outright, and every
 * revealed row would vanish from History. `chunk` keeps each request under
 * the cap.
 */
export const MAX_ACCOUNTS_PER_RPC = 100

/** Split `items` into consecutive slices of at most `size` (pure; exported for the test runner once `app/` has one). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk: size must be positive, got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
