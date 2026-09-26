// app/src/features/history/useHistoryRows.ts
//
// Week 6: the hook only — pure row/merge logic is in `historyRows.ts`, the
// persisted hash set in `hashStore.ts`.
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
//      `codecs.ts`'s `DecodedPosition`/`status.ts`'s file header).
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { decodeDisclosure, decodeDisclosureQueue, type DecodedDisclosureQueue } from '@/src/lib/codecs'
import { pdas } from '@/src/lib/pdas'
import { baseConn } from '@/src/lib/solana'
import { useLiveAccount, type LiveAccount } from '@/src/lib/live'
import { loadKnownHashes, rememberHashes } from './hashStore'
import { chunk, MAX_ACCOUNTS_PER_RPC, mergeHistoryRows, recordHash, type RevealedEntry, type Row } from './historyRows'

/**
 * Revealed `Disclosure`s already found on L1, kept across refetches for the
 * lifetime of the hook. A `Disclosure` account is written once by
 * `write_disclosure` (`init`) and is never mutated or closed by any
 * instruction — so once one is found it never needs to be fetched again.
 * Without this cache every 5-second poll re-read EVERY remembered hash,
 * forever: a cost that grew with the device's whole trade history instead
 * of with the handful of trades still awaiting reveal. Keyed by owner so a
 * wallet switch starts from an empty map.
 */
interface RevealedCache {
  owner: string | null
  found: Map<string, RevealedEntry>
}

const NO_REVEALED: RevealedEntry[] = []

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
  // keccak once per queue change (`dq.value` is a fresh object only when the
  // bytes changed — `live.ts` byte-diffs), not once per render.
  const dqHashes = useMemo(() => (dq.value ? dq.value.records.map(recordHash) : []), [dq.value])
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
  const revealedCache = useRef<RevealedCache>({ owner: null, found: new Map() })
  const revealedQuery: UseQueryResult<RevealedEntry[]> = useQuery({
    queryKey: ['dexxer-history-revealed', owner?.toBase58()],
    queryFn: async () => {
      const ownerKey = owner!.toBase58()
      const cache = revealedCache.current
      if (cache.owner !== ownerKey) {
        cache.owner = ownerKey
        cache.found = new Map()
      }
      const known = await loadKnownHashes(owner!)
      // Only hashes not yet found on L1 are looked up — see `RevealedCache`.
      const pending = known.filter((h) => !cache.found.has(h))
      for (const hashes of chunk(pending, MAX_ACCOUNTS_PER_RPC)) {
        const pubkeys = hashes.map((h) => pdas.disclosure(h))
        const infos = await baseConn.getMultipleAccountsInfo(pubkeys, 'confirmed')
        infos.forEach((info, i) => {
          // `hashes[i]` (not re-derived) — the exact hash this pubkey was
          // looked up by, threaded through so `mergeHistoryRows` can key on it
          // (see `RevealedEntry`'s doc comment: a `DecodedDisclosure` alone
          // can't reproduce this hash, it lacks `salt`/`reveal_after_slot`).
          if (info)
            cache.found.set(hashes[i], { hash: hashes[i], pubkey: pubkeys[i], disclosure: decodeDisclosure(info.data) })
        })
      }
      // Emitted in `known` order (deterministic across refetches); `mergeHistoryRows` sorts by `closedSlot` anyway.
      return known.flatMap((h) => {
        const entry = cache.found.get(h)
        return entry ? [entry] : []
      })
    },
    enabled: !!owner,
    refetchInterval: 5000,
  })
  // Stable fallback: a fresh `[]` per render would invalidate the `rows` memo below every time.
  const revealed = revealedQuery.data ?? NO_REVEALED
  const revealedError = revealedQuery.error
    ? revealedQuery.error instanceof Error
      ? revealedQuery.error.message
      : String(revealedQuery.error)
    : null

  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await revealedQuery.refetch()
    } finally {
      // A pull-to-refresh that outlives the screen must not set state on an unmounted hook.
      if (mounted.current) setRefreshing(false)
    }
  }

  // Merge (another keccak pass per queue record) only when an input changed —
  // `slot` ticks every 2 s, the other two only on real data changes.
  const rows = useMemo(() => mergeHistoryRows(dq.value?.records ?? [], revealed, slot), [dq.value, revealed, slot])

  return { rows, dq, revealedError, refreshing, onRefresh }
}
