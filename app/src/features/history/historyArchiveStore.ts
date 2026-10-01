// app/src/features/history/historyArchiveStore.ts
//
// AsyncStorage side of the History archive — `dexxer.history.<owner>`. Holds only
// this device's own owner's records. Split from `historyArchive.ts` so the pure
// merge loads in Node tests without the native module.
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { PublicKey } from '@solana/web3.js'
import { parseArchive, type ArchivedRecord } from './historyArchive'

const keyOf = (owner: PublicKey) => `dexxer.history.${owner.toBase58()}`

/**
 * Only a missing or corrupt VALUE is an empty archive. A `getItem` rejection
 * propagates: a read failure must never be saved back as an empty archive.
 */
export async function loadArchive(owner: PublicKey): Promise<ArchivedRecord[]> {
  return parseArchive(await AsyncStorage.getItem(keyOf(owner)))
}

export async function saveArchive(owner: PublicKey, rows: ArchivedRecord[]): Promise<void> {
  await AsyncStorage.setItem(keyOf(owner), JSON.stringify(rows))
}
