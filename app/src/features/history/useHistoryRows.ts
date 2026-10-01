// app/src/features/history/useHistoryRows.ts
//
// History = the private 16-record ring in `Positions` (read live over the
// session TEE connection) merged into an on-device archive that never drops a
// record seen once (spec §2.9.4). The archive is loaded per owner, merged on
// every ring change and saved back; rows are the archive, newest first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, PublicKey } from '@solana/web3.js'
import { useLiveAccount, type LiveAccount } from '@/src/lib/live'
import { decodePositions, type DecodedPositions } from '@/src/lib/positions'
import { SOL_FALLBACK, useMarkets } from '@/src/lib/markets'
import { mergeArchive, type ArchivedRecord } from './historyArchive'
import { loadArchive, saveArchive } from './historyArchiveStore'
import { historyRowsFrom, type Row } from './historyRows'

export interface UseHistoryRows {
  rows: Row[]
  live: LiveAccount<DecodedPositions>
  archiveError: string | null
  refreshing: boolean
  onRefresh: () => Promise<void>
}

const NO_ARCHIVE: ArchivedRecord[] = []
const shortKey = (market: string) => `${market.slice(0, 4)}…${market.slice(-4)}`
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useHistoryRows(
  owner: PublicKey | null,
  conn: Connection | null,
  positions: PublicKey | null,
): UseHistoryRows {
  const live = useLiveAccount(conn, positions, decodePositions)
  const markets = useMarkets()
  const ownerKey = owner?.toBase58() ?? null

  const [state, setState] = useState<{ owner: string | null; archive: ArchivedRecord[] }>({
    owner: null,
    archive: NO_ARCHIVE,
  })
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Load -> merge -> save runs are chained so two ring pushes never interleave on the stored copy.
  const chain = useRef<Promise<void>>(Promise.resolve())

  const ring = live.value?.history
  useEffect(() => {
    if (!owner || !ownerKey) return
    let cancelled = false
    chain.current = chain.current.then(async () => {
      let existing: ArchivedRecord[]
      try {
        existing = await loadArchive(owner)
      } catch (e) {
        // Unreadable storage: show the ring alone and never save over what we could not read.
        if (!cancelled) {
          setState({ owner: ownerKey, archive: mergeArchive([], ring ?? [], Date.now()) })
          setArchiveError(`History archive not read: ${message(e)}`)
        }
        return
      }
      const merged = mergeArchive(existing, ring ?? [], Date.now())
      // Show the merge even if saving fails: the ring records must not vanish from the screen.
      if (!cancelled) setState({ owner: ownerKey, archive: merged })
      if (merged.length === existing.length) {
        if (!cancelled) setArchiveError(null)
        return
      }
      try {
        await saveArchive(owner, merged)
        if (!cancelled) setArchiveError(null)
      } catch (e) {
        if (!cancelled) setArchiveError(`History archive not saved: ${message(e)}`)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ownerKey` identifies `owner`
  }, [ownerKey, ring])

  const symbols = markets.data
  const rows = useMemo(() => {
    const bySymbol = new Map((symbols ?? [SOL_FALLBACK]).map((m) => [m.market.toBase58(), m.symbol]))
    const archive = state.owner === ownerKey ? state.archive : NO_ARCHIVE
    return historyRowsFrom(archive, (k) => bySymbol.get(k) ?? shortKey(k))
  }, [state, ownerKey, symbols])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await markets.refetch()
    } finally {
      setRefreshing(false)
    }
  }, [markets])

  return { rows, live, archiveError, refreshing, onRefresh }
}
