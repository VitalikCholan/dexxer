// app/src/features/history/useHistoryRows.ts
//
// Week 5, Task 6: split out of HistoryScreen.tsx (which had grown past what
// belongs in a render component) — every data concern History needs: the
// live `DisclosureQueue` subscription, the current-slot poll, the persisted
// commitment-hash store, the L1 `Disclosure` lookup, and the merge/dedupe
// that turns those into one row list. HistoryScreen.tsx is now render-only.
//
// TWO data sources feed one list (down from three — see below):
//
//   1. `DisclosureQueue` (permissioned; read over the session's own TEE
//      connection via `useLiveAccount`, push-first). `close_position`
//      (week-5 Task 1's queue-first model) pushes a brand-new `ClosedRecord`
//      straight in here, `commitment_written = false` — this is what makes
//      a closed trade show up in History immediately, with no wait for the
//      next commit cycle. `commit_aggregate` later flips
//      `commitment_written` to `true` IN PLACE (no more `mark_committed`
//      hop through `Position.closed` — that source is gone, see
//      `program.ts`'s `DecodedPosition`/`status.ts`'s file header).
//   2. `Disclosure` accounts on L1 (public, base layer) — the record after
//      `write_disclosure` runs and pops it out of the queue.
//      `Disclosure.owner` is always `Pubkey::default()` by design (the
//      record discloses the trade, not the trader — spec §2.3).
//
// Task 8b (ruling 9): matching "this app's history" to a revealed
// `Disclosure` happens by `commitmentHash(args, salt)`, NOT by `nonce` —
// `nonce` is `UserAccount.nonce`, a per-user counter, so two different
// traders can each produce a `Disclosure.nonce` of, say, 1. The hash is
// computed from the still-pending `DisclosureQueue` entry (which carries
// `salt`; a revealed `Disclosure` account does not), persisted in
// `expo-secure-store` under `dexxer.hashes.<owner>`, and then used to fetch
// each `Disclosure` directly by its hash-seeded PDA (`pdas.disclosure(hash)`)
// rather than scanning the indexer's/L1's full `Disclosure` set.
//
// Fix round 1 (code review, 23.09.2026, pre-dates the queue-first rewrite):
// the two sources here are read through independently-paced subscriptions
// (the queue's TEE push, `revealed`'s 5s base-layer poll), so on the client
// they can transiently disagree about which stage a given trade is in (the
// queue subscription hasn't yet delivered `write_disclosure`'s pop while
// `revealed` already found the new `Disclosure`). Concatenating the two
// lists would then render the SAME trade twice. `mergeHistoryRows` below
// dedupes by the commitment hash, building one `Map<hashHex, Row>` in
// ascending precedence `queue` < `revealed`, so a later (higher-stage)
// insert overwrites an earlier (lower-stage) one at the same key.
//
// The old fixed `setInterval` pollers (2s for slot, 5s for the
// revealed-disclosure re-fetch) are react-query `useQuery`s — same
// underlying reads (direct `conn.getSlot`/`baseConn.getMultipleAccountsInfo`
// by known hash, NOT `indexer.ts`'s `useDisclosures()`: that feed is
// Postgres-backed, paginated, and only live when the relayer's
// `INDEXER_ENABLED=true` — an exact-pubkey L1 lookup stays the correctness-
// bearing path for "did MY trade get revealed", independent of the indexer
// being up), just no longer hand-rolled.
import { useEffect, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  commitmentHash,
  decodeDisclosure,
  decodeDisclosureQueue,
  type DecodedClosedRecord,
  type DecodedDisclosure,
  type DecodedDisclosureQueue,
} from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'
import { baseConn } from '@/src/lib/solana'
import { useLiveAccount, type LiveAccount } from '@/src/lib/live'
import { disclosureStatus, formatSlotsAsTime, type DisclosureStatus } from '@/src/lib/status'
import type { Tone } from '@/src/ui/styles'

function hashStoreKey(owner: PublicKey): string {
  return `dexxer.hashes.${owner.toBase58()}`
}

async function loadKnownHashes(owner: PublicKey): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(hashStoreKey(owner))
  if (!raw) return []
  try {
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}

/** Merge `hashes` (lowercase hex) into the persisted set for `owner`, writing back only if it actually grew. */
async function rememberHashes(owner: PublicKey, hashes: string[]): Promise<void> {
  const existing = await loadKnownHashes(owner)
  const set = new Set(existing)
  let changed = false
  for (const h of hashes) {
    if (!set.has(h)) {
      set.add(h)
      changed = true
    }
  }
  if (changed) {
    await SecureStore.setItemAsync(hashStoreKey(owner), JSON.stringify(Array.from(set)))
  }
}

/** `commitmentHash(args, salt)` for a still-pending `DisclosureQueue` entry, hex-encoded — see file header (Task 8b). */
function recordHash(r: DecodedClosedRecord): string {
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
 * `program.ts`'s golden vectors and `status.ts`'s
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

export interface UseHistoryRows {
  rows: Row[]
  dq: LiveAccount<DecodedDisclosureQueue>
  revealedError: string | null
  refreshing: boolean
  onRefresh: () => Promise<void>
}

/**
 * All of History's data plumbing in one hook: the live `DisclosureQueue`
 * subscription, the current-slot poll (for the `reveals_in` countdown), the
 * persisted commitment-hash store, and the revealed-`Disclosure` lookup —
 * merged into one row list via `mergeHistoryRows`.
 */
export function useHistoryRows(owner: PublicKey | null, conn: Connection | null): UseHistoryRows {
  const dqPubkey = owner ? pdas.disclosureQueue(owner) : null
  const dq = useLiveAccount(conn, dqPubkey, decodeDisclosureQueue)

  const slotQuery = useQuery({
    queryKey: ['dexxer-history-slot', owner?.toBase58()],
    queryFn: async () => BigInt(await conn!.getSlot('confirmed')),
    enabled: !!conn,
    refetchInterval: 2000,
  })
  const slot = slotQuery.data ?? null

  // Persist commitmentHash(args, salt) for every record currently in the
  // queue — see file header (Task 8b: hash, not nonce). Keyed off a joined
  // string (not the decoded objects, which are fresh references on every
  // push/poll) so this only re-runs when the actual set of pending records
  // changes.
  const dqHashes = dq.value ? dq.value.records.map(recordHash) : []
  const hashKey = dqHashes.join(',')
  useEffect(() => {
    if (!owner || !hashKey) return
    void rememberHashes(owner, hashKey.split(','))
    // `owner` is covered by `owner?.toBase58()`; `hashKey` (a plain string)
    // is the actual dependency check, not `dq.value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58(), hashKey])

  // Direct PDA lookup by known hash (Task 8b), not a getProgramAccounts
  // scan+filter: `pdas.disclosure(hash)` is deterministic, so every known
  // hash maps to exactly one address regardless of what other traders'
  // rows exist on L1.
  const revealedQuery: UseQueryResult<RevealedEntry[]> = useQuery({
    queryKey: ['dexxer-history-revealed', owner?.toBase58()],
    queryFn: async () => {
      const known = await loadKnownHashes(owner!)
      if (known.length === 0) return []
      const pubkeys = known.map((h) => pdas.disclosure(h))
      const infos = await baseConn.getMultipleAccountsInfo(pubkeys, 'confirmed')
      const found: RevealedEntry[] = []
      infos.forEach((info, i) => {
        // `known[i]` (not re-derived) — the exact hash this pubkey was
        // looked up by, threaded through so `mergeHistoryRows` can key on it
        // (see `RevealedEntry`'s doc comment: a `DecodedDisclosure` alone
        // can't reproduce this hash, it lacks `salt`/`reveal_after_slot`).
        if (info) found.push({ hash: known[i], pubkey: pubkeys[i], disclosure: decodeDisclosure(info.data) })
      })
      return found
    },
    enabled: !!owner,
    refetchInterval: 5000,
  })
  const revealed = revealedQuery.data ?? []
  const revealedError = revealedQuery.error
    ? revealedQuery.error instanceof Error
      ? revealedQuery.error.message
      : String(revealedQuery.error)
    : null

  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = async () => {
    setRefreshing(true)
    await revealedQuery.refetch()
    setRefreshing(false)
  }

  const rows = mergeHistoryRows(dq.value?.records ?? [], revealed, slot)

  return { rows, dq, revealedError, refreshing, onRefresh }
}
