// app/src/features/history/hashStore.ts
//
// This device's memory of which 13F commitment hashes are ITS trades
// (`commitmentHash(args, salt)` of every record it has seen in its
// `DisclosureQueue`). Persisted because once `write_disclosure` pops a
// record out of the queue, the hash is the only link from this device to
// its public `Disclosure` PDA — never prune it. Split out of
// useHistoryRows.ts (week 6), with an in-memory copy per owner so the 5 s
// revealed-lookup poll no longer re-reads SecureStore every time.
import { PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'

const memory = new Map<string, Set<string>>()

function hashStoreKey(owner: PublicKey): string {
  return `dexxer.hashes.${owner.toBase58()}`
}

export async function loadKnownHashes(owner: PublicKey): Promise<string[]> {
  const key = hashStoreKey(owner)
  const cached = memory.get(key)
  if (cached) return Array.from(cached)
  const raw = await SecureStore.getItemAsync(key)
  let list: string[] = []
  if (raw) {
    try {
      list = JSON.parse(raw) as string[]
    } catch {
      list = []
    }
  }
  memory.set(key, new Set(list))
  return list
}

/** Merge `hashes` (lowercase hex) into the persisted set for `owner`, writing back only if it actually grew. */
export async function rememberHashes(owner: PublicKey, hashes: string[]): Promise<void> {
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
    memory.set(hashStoreKey(owner), set)
    await SecureStore.setItemAsync(hashStoreKey(owner), JSON.stringify(Array.from(set)))
  }
}
