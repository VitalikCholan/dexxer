// app/src/features/history/historyArchiveStore.ts
//
// AsyncStorage side of the History archive — `dexxer.history.<owner>`. Holds only
// this device's own owner's records. Split from `historyArchive.ts` so the pure
// merge loads in Node tests without the native module.
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { PublicKey } from '@solana/web3.js'
import type { ArchivedRecord } from './historyArchive'

const keyOf = (owner: PublicKey) => `dexxer.history.${owner.toBase58()}`

/** A missing or corrupt value is an empty archive. */
export async function loadArchive(owner: PublicKey): Promise<ArchivedRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(owner))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as ArchivedRecord[]) : []
  } catch {
    return []
  }
}

export async function saveArchive(owner: PublicKey, rows: ArchivedRecord[]): Promise<void> {
  await AsyncStorage.setItem(keyOf(owner), JSON.stringify(rows))
}
