// app/src/features/history/HistoryScreen.tsx
//
// Task 9: closed-trade history. THREE data sources feed one list, mutually
// exclusive at any point in time (see status.ts's file header for the full
// state machine) — no dedup logic is needed beyond concatenating them:
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
// Task 9: the old fixed `setInterval` pollers (2s for slot, 5s for the
// revealed-disclosure re-fetch) are now react-query `useQuery`s — same
// underlying reads (direct `conn.getSlot`/`baseConn.getMultipleAccountsInfo`
// by known hash, NOT `indexer.ts`'s `useDisclosures()`: that feed is
// Postgres-backed, paginated, and only live when the relayer's
// `INDEXER_ENABLED=true` — an exact-pubkey L1 lookup stays the correctness-
// bearing path for "did MY trade get revealed", independent of the indexer
// being up), just no longer hand-rolled.
import { useEffect, useState } from 'react'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
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
import { Badge } from '@/src/ui/Badge'
import { EmptyState } from '@/src/ui/EmptyState'
import { Skeleton } from '@/src/ui/Skeleton'
import type { Tone } from '@/src/ui/styles'
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
function rowStatusText(status: DisclosureStatus, revealAfterSlot: bigint, slot: bigint | null, source: 'position' | 'queue'): string {
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
}

function positionPendingRow(r: DecodedClosedRecord): Row {
  // `slot: null` intentionally caps this at 'committing'/'committed' — see
  // status.ts's doc comment: a Position-sourced record can never legitimately
  // be 'reveals_in'/'revealed' before mark_committed moves it to the queue.
  const status = disclosureStatus(r, null)
  return {
    key: 'position-pending',
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

function queuePendingRow(r: DecodedClosedRecord, slot: bigint | null): Row {
  const status = disclosureStatus(r, slot)
  return {
    key: `pending-${r.nonce}`,
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

function revealedRow(pubkey: PublicKey, d: DecodedDisclosure): Row {
  return {
    key: `revealed-${pubkey.toBase58()}`,
    side: d.side,
    size: d.size,
    entry: d.entry,
    exit: d.exit,
    pnl: d.pnl,
    closedSlot: d.closedSlot,
    status: 'revealed',
    statusText: STATUS_LABEL.revealed,
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
      const found: { pubkey: PublicKey; disclosure: DecodedDisclosure }[] = []
      infos.forEach((info, i) => {
        if (info) found.push({ pubkey: pubkeys[i], disclosure: decodeDisclosure(info.data) })
      })
      return found
    },
    enabled: !!owner,
    refetchInterval: 5000,
  })
  const revealed = revealedQuery.data ?? []
  const revealedError = revealedQuery.error ? (revealedQuery.error instanceof Error ? revealedQuery.error.message : String(revealedQuery.error)) : null

  const [refreshing, setRefreshing] = useState(false)

  const rows: Row[] = [
    ...(posRecord ? [positionPendingRow(posRecord)] : []),
    ...(dq.value?.records.map((r) => queuePendingRow(r, slot)) ?? []),
    ...revealed.map(({ pubkey, disclosure }) => revealedRow(pubkey, disclosure)),
  ].sort((a, b) => Number(b.closedSlot - a.closedSlot))

  const onRefresh = async () => {
    setRefreshing(true)
    await revealedQuery.refetch()
    setRefreshing(false)
  }

  return (
    <AppPage>
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingVertical: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Text style={{ fontSize: 20, fontWeight: '700' }}>History</Text>

        {sessionError || dq.error || position.error || revealedError ? (
          <Text selectable style={{ color: '#ef4444' }}>
            {sessionError ?? dq.error ?? position.error ?? revealedError}
          </Text>
        ) : null}

        {loading ? (
          <Skeleton lines={3} />
        ) : !owner ? (
          <EmptyState text="Not connected — connect on the Onboard tab." />
        ) : rows.length === 0 ? (
          <EmptyState text="No closed trades yet." />
        ) : (
          <View style={{ gap: 12 }}>
            {rows.map((r) => (
              <View key={r.key} style={{ gap: 4, borderBottomWidth: 1, borderColor: '#33333322', paddingBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontWeight: '600' }}>{r.side}</Text>
                  <Text style={{ opacity: 0.7 }}>slot {r.closedSlot.toString()}</Text>
                </View>
                <RowLine label="Size" value={`${fmtSol(r.size)} SOL`} />
                <RowLine label="Entry" value={`$${fmtUsd(r.entry)}`} />
                <RowLine label="Exit" value={`$${fmtUsd(r.exit)}`} />
                <RowLine
                  label="PnL"
                  value={`${r.pnl >= 0n ? '+' : ''}$${fmtUsd(r.pnl)}`}
                  valueColor={r.pnl >= 0n ? '#22c55e' : '#ef4444'}
                />
                <Badge tone={STATUS_TONE[r.status]}>{r.statusText}</Badge>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </AppPage>
  )
}

function RowLine({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ opacity: 0.7 }}>{label}</Text>
      <Text style={{ fontWeight: '600', color: valueColor }}>{value}</Text>
    </View>
  )
}
