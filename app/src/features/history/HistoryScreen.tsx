// app/src/features/history/HistoryScreen.tsx
//
// Task 9: closed-trade history. THREE data sources feed one list:
//
//   1. `Position` (permissioned — owner/session/crank; read here over the
//      session's own TEE connection via `useLiveAccount`, push-first per
//      Task 9). While `state === 'Closed'`, `Position.closed` IS the
//      just-closed trade, before it has even reached `DisclosureQueue` —
//      this is what makes a closed position show up in History
//      immediately, not after the next 5-min commit cycle.
//   2. `DisclosureQueue` (permissioned) — records `mark_committed` has
//      already moved out of `Position.closed` and into the ring, waiting
//      for `reveal_after_slot`.
//   3. `Disclosure` accounts on L1 (public, base layer) — the record after
//      `write_disclosure` runs. `Disclosure.owner` is always
//      `Pubkey::default()` by design (the record discloses the trade, not
//      the trader — spec §2.3).
//
// Task 8b (ruling 9): matching "this app's history" to a revealed
// `Disclosure` happens by `commitmentHash(args, salt)`, NOT by `nonce` —
// `nonce` is `UserAccount.nonce`, a per-user counter, so two different
// traders can each produce a `Disclosure.nonce` of, say, 1. The hash is
// computed from the still-pending record (`Position.closed` or a
// `DisclosureQueue` entry — either carries `salt`; a revealed `Disclosure`
// account does not), persisted in `expo-secure-store` under
// `dexxer.hashes.<owner>`, and then used to fetch each `Disclosure` directly
// by its hash-seeded PDA (`pdas.disclosure(hash)`) rather than scanning the
// indexer's/L1's full `Disclosure` set.
//
// Fix round 1 (code review, 23.09.2026): the three sources are mutually
// exclusive ONLY at the program-state level (a single atomic mutation moves
// a record from one to the next) — they are read here through THREE
// independent, differently-paced subscriptions (`position`'s TEE push,
// `dq`'s TEE push, `revealed`'s 5s base-layer poll), so on the client they
// can transiently disagree about which stage a given trade is in (e.g. the
// `position` subscription hasn't yet delivered `mark_committed`'s effect
// while `dq` already has, or `dq` hasn't delivered `write_disclosure`'s pop
// while `revealed` already found the new `Disclosure`). Concatenating the
// three lists would then render the SAME trade twice. `mergeHistoryRows`
// below dedupes by the commitment hash — the same `commitmentHash(args,
// salt)` this file already computes for the persisted-hash store — building
// one `Map<hashHex, Row>` in ascending precedence `position` < `queue` <
// `revealed`, so a later (higher-stage) insert overwrites an earlier
// (lower-stage) one at the same key. `ClosedRecord` is written atomically by
// `close_position` (trade.rs) with every field — including `salt` — already
// populated the instant `Position.closed` becomes `Some`, so the hash is
// always derivable from a `Position`-sourced record too; no `(owner,
// nonce)` fallback key is needed (unlike a hypothetical partially-populated
// record, which cannot occur here).
//
// Task 9: the old fixed `setInterval` pollers (2s for slot, 5s for the
// revealed-disclosure re-fetch) are now react-query `useQuery`s — same
// underlying reads (direct `conn.getSlot`/`baseConn.getMultipleAccountsInfo`
// by known hash, NOT `indexer.ts`'s `useDisclosures()`: that feed is
// Postgres-backed, paginated, and only live when the relayer's
// `INDEXER_ENABLED=true` — an exact-pubkey L1 lookup stays the correctness-
// bearing path for "did MY trade get revealed", independent of the indexer
// being up), just no longer hand-rolled.
import { useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import { useQuery } from '@tanstack/react-query'
import { AppPage } from '@/components/app-page'
import {
  commitmentHash,
  decodeDisclosure,
  decodeDisclosureQueue,
  decodePosition,
  type DecodedClosedRecord,
  type DecodedDisclosure,
} from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'
import { baseConn } from '@/src/lib/solana'
import { useLiveAccount } from '@/src/lib/live'
import { disclosureStatus, formatSlotsAsTime, type DisclosureStatus } from '@/src/lib/status'
import { useTheme } from '@/src/theme'
import { useTextStyle, type Tone } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row as UiRow } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Address } from '@/src/ui/Address'
import { EmptyState } from '@/src/ui/EmptyState'
import { Skeleton } from '@/src/ui/Skeleton'
import { useTradeSession } from '../trade/useTradeSession'

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

function fmtUsd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(4)
}
function fmtSol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

/** `commitmentHash(args, salt)` for a still-pending record (`Position.closed` or a `DisclosureQueue` entry), hex-encoded — see file header (Task 8b). */
function recordHash(r: DecodedClosedRecord): string {
  const { salt, commitmentWritten: _commitmentWritten, ...args } = r
  return Buffer.from(commitmentHash(args, salt)).toString('hex')
}

const STATUS_LABEL: Record<DisclosureStatus, string> = {
  committing: 'Committing…',
  committed: 'Committed — awaiting crank',
  reveals_in: 'Reveals in',
  revealed: 'Revealed ✓',
}
const STATUS_TONE: Record<DisclosureStatus, Tone> = {
  committing: 'pending',
  committed: 'pending',
  reveals_in: 'warning',
  revealed: 'success',
}

/** `slot === null && status === 'committed'` from a `DisclosureQueue` record specifically means "already past mark_committed, just don't know the current slot yet" — 'Checking…' is more accurate there than the generic 'committed' label (which implies still-awaiting-crank, already false by definition for a queued record). */
function rowStatusText(
  status: DisclosureStatus,
  revealAfterSlot: bigint,
  slot: bigint | null,
  source: 'position' | 'queue',
): string {
  if (status === 'committed' && source === 'queue' && slot === null) return 'Checking…'
  if (status === 'reveals_in' && slot !== null) return `Reveals in ${formatSlotsAsTime(revealAfterSlot - slot)}`
  return STATUS_LABEL[status]
}

interface Row {
  key: string
  side: string
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  closedSlot: bigint
  status: DisclosureStatus
  statusText: string
  /** Task 10: revealed rows only — the public `Disclosure` account's own address, for an explorer link. */
  explorerPubkey?: string
}

/** `hash` (the commitment hash — see `mergeHistoryRows`) becomes the row's React `key` too, so a row stays visually stable across a status transition instead of remounting. */
function positionPendingRow(hash: string, r: DecodedClosedRecord): Row {
  // `slot: null` intentionally caps this at 'committing'/'committed' — see
  // status.ts's doc comment: a Position-sourced record can never legitimately
  // be 'reveals_in'/'revealed' before mark_committed moves it to the queue.
  const status = disclosureStatus(r, null)
  return {
    key: hash,
    side: r.side,
    size: r.size,
    entry: r.entry,
    exit: r.exit,
    pnl: r.pnl,
    closedSlot: r.closedSlot,
    status,
    statusText: rowStatusText(status, r.revealAfterSlot, null, 'position'),
  }
}

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
    statusText: rowStatusText(status, r.revealAfterSlot, slot, 'queue'),
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
    explorerPubkey: pubkey.toBase58(),
  }
}

/** One revealed `Disclosure` plus the commitment hash it was fetched by — `DecodedDisclosure` itself carries no `salt`/`reveal_after_slot`, so the hash can't be recomputed from it; it has to be threaded through from the `pdas.disclosure(hash)` lookup that found it (see `revealedQuery` below). */
export interface RevealedEntry {
  hash: string
  pubkey: PublicKey
  disclosure: DecodedDisclosure
}

/**
 * Merge the three live sources into one row per commitment hash — see the
 * file header's "Fix round 1" note for why dedup is needed (three
 * independently-paced subscriptions can transiently disagree about a
 * trade's stage) and why precedence is `position` < `queue` < `revealed`
 * (later `Map.set` calls for the same key win, so a higher-stage source
 * always overwrites a lower-stage one). Exported (pure, no hooks) so
 * `assertHistoryMergeSelfCheck` below can exercise it directly.
 */
export function mergeHistoryRows(
  posRecord: DecodedClosedRecord | null,
  queueRecords: DecodedClosedRecord[],
  revealed: RevealedEntry[],
  slot: bigint | null,
): Row[] {
  const merged = new Map<string, Row>()
  if (posRecord) {
    const hash = recordHash(posRecord)
    merged.set(hash, positionPendingRow(hash, posRecord))
  }
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
 * Self-check (no test runner wired up for `app/` — same gap/pattern as
 * `program.ts`'s golden vectors and `status.ts`'s
 * `assertDisclosureStatusSelfCheck`): feeds ONE synthetic trade present in
 * all three sources at once (the exact failure mode Fix round 1 addresses)
 * and asserts `mergeHistoryRows` collapses it to a single row carrying the
 * highest-stage status (`revealed`), not three rows. Throws on mismatch.
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

  const rows = mergeHistoryRows(rec, [rec], [revealedEntry], 100n)
  if (rows.length !== 1) {
    throw new Error(
      `assertHistoryMergeSelfCheck: expected exactly 1 merged row for one trade in all 3 sources, got ${rows.length}`,
    )
  }
  if (rows[0].status !== 'revealed') {
    throw new Error(`assertHistoryMergeSelfCheck: expected highest-stage status 'revealed', got '${rows[0].status}'`)
  }
}

if (__DEV__) {
  try {
    assertHistoryMergeSelfCheck()
    console.log('[dexxer] assertHistoryMergeSelfCheck: History merge dedupe OK')
  } catch (e) {
    console.error('[dexxer] assertHistoryMergeSelfCheck FAILED', e)
  }
}

export function HistoryScreen() {
  const { owner, conn, loading, error: sessionError } = useTradeSession()
  const marketPda = pdas.market()
  const dqPubkey = owner ? pdas.disclosureQueue(owner) : null
  const positionPubkey = owner ? pdas.position(owner, marketPda) : null
  const dq = useLiveAccount(conn, dqPubkey, decodeDisclosureQueue)
  const position = useLiveAccount(conn, positionPubkey, decodePosition)

  // Current ER slot, only for the pending-disclosure countdown — react-query
  // instead of a hand-rolled `setInterval` (Task 9).
  const slotQuery = useQuery({
    queryKey: ['dexxer-history-slot', owner?.toBase58()],
    queryFn: async () => BigInt(await conn!.getSlot('confirmed')),
    enabled: !!conn,
    refetchInterval: 2000,
  })
  const slot = slotQuery.data ?? null

  const posRecord = position.value?.state === 'Closed' ? position.value.closed : null

  // Persist commitmentHash(args, salt) for every record seen in either live
  // source — see file header (Task 8b: hash, not nonce). Keyed off a joined
  // string (not the decoded objects, which are fresh references on every
  // push/poll) so this only re-runs when the actual set of pending records
  // changes.
  const dqHashes = dq.value ? dq.value.records.map(recordHash) : []
  const hashKey = (posRecord ? [...dqHashes, recordHash(posRecord)] : dqHashes).join(',')
  useEffect(() => {
    if (!owner || !hashKey) return
    void rememberHashes(owner, hashKey.split(','))
    // `owner` is covered by `owner?.toBase58()`; `hashKey` (a plain string)
    // is the actual dependency check, not `dq.value`/`position.value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58(), hashKey])

  // Direct PDA lookup by known hash (Task 8b), not a getProgramAccounts
  // scan+filter: `pdas.disclosure(hash)` is deterministic, so every known
  // hash maps to exactly one address regardless of what other traders'
  // rows exist on L1. React-query instead of a hand-rolled `setInterval`
  // (Task 9) — see file header for why this reads L1 directly rather than
  // `indexer.ts`'s `useDisclosures()`.
  const revealedQuery = useQuery({
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
  const [explainerOpen, setExplainerOpen] = useState(false)

  const rows: Row[] = mergeHistoryRows(posRecord, dq.value?.records ?? [], revealed, slot)

  const onRefresh = async () => {
    setRefreshing(true)
    await revealedQuery.refetch()
    setRefreshing(false)
  }

  const { colors, space } = useTheme()
  const heading = useTextStyle('title')
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')

  return (
    <AppPage>
      <ScrollView
        contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Text style={[heading, { color: colors.textPrimary }]}>History</Text>

        <Pressable onPress={() => setExplainerOpen((v) => !v)}>
          <Text style={[caption, { color: colors.textSecondary }]}>
            {explainerOpen ? '▾' : '▸'} Why do trades become public?
          </Text>
          {explainerOpen ? (
            <Text style={[caption, { color: colors.textTertiary, marginTop: 4 }]}>
              Your trades become public only after the delay — without your address.
            </Text>
          ) : null}
        </Pressable>

        {sessionError || dq.error || position.error || revealedError ? (
          <Text selectable style={{ color: colors.short }}>
            {sessionError ?? dq.error ?? position.error ?? revealedError}
          </Text>
        ) : null}

        {loading ? (
          <Skeleton lines={3} />
        ) : !owner ? (
          <EmptyState text="Not connected — connect your wallet to see your trade history." />
        ) : rows.length === 0 ? (
          <EmptyState text="No closed trades yet" />
        ) : (
          <View style={{ gap: space.md }}>
            {rows.map((r) => (
              <Card key={r.key}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={[body, { color: colors.textPrimary, fontWeight: '600' }]}>
                    {r.side} {fmtSol(r.size)} SOL
                  </Text>
                  <Badge tone={STATUS_TONE[r.status]}>{r.statusText}</Badge>
                </View>
                <UiRow label="Entry → Exit" value={`$${fmtUsd(r.entry)} → $${fmtUsd(r.exit)}`} mono />
                <UiRow
                  label="PnL"
                  value={`${r.pnl >= 0n ? '+' : ''}$${fmtUsd(r.pnl)}`}
                  tone={r.pnl >= 0n ? 'success' : 'danger'}
                />
                {r.explorerPubkey ? <Address pubkey={r.explorerPubkey} explorer /> : null}
              </Card>
            ))}
          </View>
        )}
      </ScrollView>
    </AppPage>
  )
}
