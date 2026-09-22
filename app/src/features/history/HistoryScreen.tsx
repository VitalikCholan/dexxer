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
//      the trader — spec §2.3), so there is no owner filter on the
//      `getProgramAccounts` scan; matching to "this app's history" happens
//      by `nonce`, against the set of nonces this device has ever observed
//      in its own `DisclosureQueue` (persisted in `expo-secure-store` under
//      `dexxer.nonces.<owner>`, dedup'd, growing — never pruned, since a
//      revealed record leaves the queue for good and this is the only
//      remaining link back to it).
//
// A record is in exactly one of the two sources at a time: `due_reveals`
// (commit.rs) pops it out of the ring the same cycle `write_disclosure`
// creates the `Disclosure` account, so there's no overlap/double-count to
// reconcile.
import { useEffect, useState } from 'react'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { Connection, PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import { AppPage } from '@/components/app-page'
import {
  decodeDisclosureQueue,
  readAllDisclosures,
  type DecodedClosedRecord,
  type DecodedDisclosure,
} from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'
import { baseConn } from '@/src/lib/solana'
import { useLiveAccount } from '@/src/lib/live'
import { useTradeSession } from '../trade/useTradeSession'

function nonceStoreKey(owner: PublicKey): string {
  return `dexxer.nonces.${owner.toBase58()}`
}

async function loadKnownNonces(owner: PublicKey): Promise<bigint[]> {
  const raw = await SecureStore.getItemAsync(nonceStoreKey(owner))
  if (!raw) return []
  try {
    return (JSON.parse(raw) as string[]).map((s) => BigInt(s))
  } catch {
    return []
  }
}

/** Merge `nonces` into the persisted set for `owner`, writing back only if it actually grew. Returns the merged set. */
async function rememberNonces(owner: PublicKey, nonces: bigint[]): Promise<bigint[]> {
  const existing = await loadKnownNonces(owner)
  const set = new Set(existing.map(String))
  let changed = false
  for (const n of nonces) {
    const s = n.toString()
    if (!set.has(s)) {
      set.add(s)
      changed = true
    }
  }
  const merged = Array.from(set).map((s) => BigInt(s))
  if (changed) {
    await SecureStore.setItemAsync(nonceStoreKey(owner), JSON.stringify(merged.map(String)))
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

  // Persist any nonce seen in the live DisclosureQueue — see file header.
  // Keyed off the joined nonce string (not the decoded object, which is a
  // fresh reference every 1s poll) so this only re-runs when the actual
  // nonce set changes.
  const dqNonceKey = dq.value ? dq.value.records.map((r) => r.nonce.toString()).join(',') : ''
  useEffect(() => {
    if (!owner || !dqNonceKey) return
    const nonces = dqNonceKey.split(',').map((s) => BigInt(s))
    void rememberNonces(owner, nonces)
    // `owner` is covered by `owner?.toBase58()`; `dqNonceKey` (a plain
    // string) is the actual dependency check, not the `dq.value` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58(), dqNonceKey])

  async function refreshRevealed() {
    if (!owner) return
    try {
      const known = await loadKnownNonces(owner)
      if (known.length === 0) {
        setRevealed([])
        setRevealedError(null)
        return
      }
      const knownSet = new Set(known.map(String))
      const all = await readAllDisclosures(baseConn)
      setRevealed(all.filter(({ disclosure }) => knownSet.has(disclosure.nonce.toString())))
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
