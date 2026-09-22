// app/src/features/history/HistoryScreen.tsx
//
// Task 9: closed-trade history. Two data sources feed one list:
//
//   1. `DisclosureQueue` (permissioned — owner/session/crank; read here over
//      the session's own TEE connection, same as `useTradeSession`'s trade
//      accounts, so no extra MWA prompt) — records queued between
//      `close_position` and `write_disclosure` firing on a future 5-min
//      `commit_aggregate` cycle. All fields (side/size/entry/exit/pnl/
//      closed_slot) are already known at close time; only the disclosure
//      itself is delayed (spec §2.4.1).
//   2. `Disclosure` accounts on L1 (public, base layer) — the record after
//      `write_disclosure` runs. `Disclosure.owner` is always
//      `Pubkey::default()` by design (the record discloses the trade, not
//      the trader — spec §2.3).
//
// Task 8b (ruling 9): matching "this app's history" to a revealed `Disclosure`
// now happens by `commitmentHash(args, salt)`, NOT by `nonce` — `nonce` is
// `UserAccount.nonce`, a per-user counter, so two different traders can each
// produce a `Disclosure.nonce` of, say, 1; nonce-only matching (the pre-8b
// version of this file) could therefore show another trader's row. The hash
// is computed here from the still-pending `ClosedRecord` (only available
// while it sits in this owner's own permissioned `DisclosureQueue`, which
// carries the `salt` a revealed `Disclosure` account does not), persisted in
// `expo-secure-store` under `dexxer.hashes.<owner>` (renamed from the old
// `dexxer.nonces.<owner>` — nonce-keyed entries are not migrated; harmless on
// a devnet-only cache that repopulates from the live `DisclosureQueue`), and
// then used to fetch each `Disclosure` directly by its hash-seeded PDA
// (`pdas.disclosure(hash)`) rather than scanning+filtering every `Disclosure`
// on L1.
//
// A record is in exactly one of the two sources at a time: `due_reveals`
// (commit.rs) pops it out of the ring the same cycle `write_disclosure`
// creates the `Disclosure` account, so there's no overlap/double-count to
// reconcile.
import { useEffect, useState } from 'react'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { PublicKey } from '@solana/web3.js'
import type { Connection } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import { AppPage } from '@/components/app-page'
import {
  commitmentHash,
  decodeDisclosure,
  decodeDisclosureQueue,
  type DecodedClosedRecord,
  type DecodedDisclosure,
} from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'
import { baseConn } from '@/src/lib/solana'
import { useLiveAccount } from '@/src/lib/live'
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

/** Merge `hashes` (lowercase hex) into the persisted set for `owner`, writing back only if it actually grew. Returns the merged set. */
async function rememberHashes(owner: PublicKey, hashes: string[]): Promise<string[]> {
  const existing = await loadKnownHashes(owner)
  const set = new Set(existing)
  let changed = false
  for (const h of hashes) {
    if (!set.has(h)) {
      set.add(h)
      changed = true
    }
  }
  const merged = Array.from(set)
  if (changed) {
    await SecureStore.setItemAsync(hashStoreKey(owner), JSON.stringify(merged))
  }
  return merged
}

/** Current slot on `conn`, polled every 2s — used only to render the pending-disclosure countdown. */
function useSlot(conn: Connection | null): bigint | null {
  const [slot, setSlot] = useState<bigint | null>(null)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setSlot(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!conn) return
    let cancelled = false
    async function tick() {
      try {
        const s = await conn!.getSlot('confirmed')
        if (!cancelled) setSlot(BigInt(s))
      } catch {
        // transient — next tick retries
      }
    }
    void tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [conn])
  return slot
}

function fmtUsd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(4)
}
function fmtSol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

interface Row {
  key: string
  side: string
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  closedSlot: bigint
  status: string
}

/** `commitmentHash(args, salt)` for a pending `ClosedRecord`, hex-encoded — see file header (Task 8b). */
function recordHash(r: DecodedClosedRecord): string {
  const { salt, commitmentWritten: _commitmentWritten, ...args } = r
  return Buffer.from(commitmentHash(args, salt)).toString('hex')
}

function pendingRow(r: DecodedClosedRecord, slot: bigint | null): Row {
  const status =
    slot === null
      ? 'checking…'
      : r.revealAfterSlot > slot
        ? `reveals in ${(r.revealAfterSlot - slot).toString()} slots`
        : 'revealed ✓'
  return {
    key: `pending-${r.nonce}`,
    side: r.side,
    size: r.size,
    entry: r.entry,
    exit: r.exit,
    pnl: r.pnl,
    closedSlot: r.closedSlot,
    status,
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
    status: 'revealed ✓',
  }
}

export function HistoryScreen() {
  const { owner, conn, loading, error: sessionError } = useTradeSession()
  const dqPubkey = owner ? pdas.disclosureQueue(owner) : null
  const dq = useLiveAccount(conn, dqPubkey, decodeDisclosureQueue)
  const slot = useSlot(conn)

  const [revealed, setRevealed] = useState<{ pubkey: PublicKey; disclosure: DecodedDisclosure }[]>([])
  const [revealedError, setRevealedError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Persist commitmentHash(args, salt) for every record seen in the live
  // DisclosureQueue — see file header (Task 8b: hash, not nonce). Keyed off
  // the joined hash string (not the decoded object, which is a fresh
  // reference every 1s poll) so this only re-runs when the actual set of
  // pending records changes. `salt` lives only on the pending `ClosedRecord`
  // (a revealed `Disclosure` account carries no salt), so this is the only
  // point where the hash can be computed.
  const dqHashKey = dq.value ? dq.value.records.map(recordHash).join(',') : ''
  useEffect(() => {
    if (!owner || !dqHashKey) return
    const hashes = dqHashKey.split(',')
    void rememberHashes(owner, hashes)
    // `owner` is covered by `owner?.toBase58()`; `dqHashKey` (a plain
    // string) is the actual dependency check, not the `dq.value` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58(), dqHashKey])

  async function refreshRevealed() {
    if (!owner) return
    try {
      const known = await loadKnownHashes(owner)
      if (known.length === 0) {
        setRevealed([])
        setRevealedError(null)
        return
      }
      // Direct PDA lookup by hash (Task 8b), not a getProgramAccounts scan+
      // filter: `pdas.disclosure(hash)` is deterministic, so every known hash
      // maps to exactly one address regardless of what other traders' rows
      // exist on L1.
      const pubkeys = known.map((h) => pdas.disclosure(h))
      const infos = await baseConn.getMultipleAccountsInfo(pubkeys, 'confirmed')
      const found: { pubkey: PublicKey; disclosure: DecodedDisclosure }[] = []
      infos.forEach((info, i) => {
        if (info) found.push({ pubkey: pubkeys[i], disclosure: decodeDisclosure(info.data) })
      })
      setRevealed(found)
      setRevealedError(null)
    } catch (e) {
      setRevealedError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!owner) return
    let cancelled = false
    async function tick() {
      if (cancelled) return
      await refreshRevealed()
    }
    void tick()
    const id = setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58()])

  const rows: Row[] = [
    ...(dq.value?.records.map((r) => pendingRow(r, slot)) ?? []),
    ...revealed.map(({ pubkey, disclosure }) => revealedRow(pubkey, disclosure)),
  ].sort((a, b) => Number(b.closedSlot - a.closedSlot))

  const onRefresh = async () => {
    setRefreshing(true)
    await refreshRevealed()
    setRefreshing(false)
  }

  return (
    <AppPage>
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingVertical: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Text style={{ fontSize: 20, fontWeight: '700' }}>History</Text>

        {sessionError || dq.error || revealedError ? (
          <Text selectable style={{ color: '#ef4444' }}>
            {sessionError ?? dq.error ?? revealedError}
          </Text>
        ) : null}

        {loading ? (
          <Text style={{ opacity: 0.6 }}>Loading session…</Text>
        ) : !owner ? (
          <Text style={{ opacity: 0.6 }}>Not connected — connect on the Onboard tab.</Text>
        ) : rows.length === 0 ? (
          <Text style={{ opacity: 0.6 }}>No closed trades yet.</Text>
        ) : (
          <View style={{ gap: 12 }}>
            {rows.map((r) => (
              <View key={r.key} style={{ gap: 4, borderBottomWidth: 1, borderColor: '#33333322', paddingBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
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
                <Text style={{ opacity: 0.6, fontSize: 12 }}>{r.status}</Text>
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
