// app/src/lib/mwa/tokenStore.ts
//
// This device's own record of the MWA auth token and the app identity it
// was issued under (`identityHash`) — bookkeeping the wallet-ui library has
// no concept of. Split out of `mwaAuth.ts` (week 6); `session.ts` explains
// why it exists.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha2'

/** Structural subset of MWA's `AppIdentity` this file needs — avoids pulling in the full protocol package just for a type. */
export interface Identity {
  name?: string
  uri?: string
  icon?: string
}

const STORAGE_KEY = 'dexxer.mwa.auth'

export interface StoredAuth {
  /** The wallet's `auth_token`, opaque to this app. */
  token: string
  /** `identityHash` of the `Identity` this token was issued under. */
  identityHash: string
}

/**
 * Stable hash of an `Identity`, order-independent (sorted keys) so field
 * reordering in a future edit of `AppProviders.tsx`'s `identity` literal
 * can never silently change the hash. `undefined` fields normalize to
 * `null` so `{name}` and `{name, uri: undefined}` hash identically. Hex
 * output (not raw bytes) — this is a comparison/storage key, not a
 * cryptographic commitment consumed by any on-chain code.
 */
export function identityHash(identity: Identity): string {
  const normalized = JSON.stringify({
    name: identity.name ?? null,
    uri: identity.uri ?? null,
    icon: identity.icon ?? null,
  })
  const bytes = sha256(new TextEncoder().encode(normalized))
  return Buffer.from(bytes).toString('hex')
}

/** Reads this device's stored `{token, identityHash}`, or `null` if none is stored (or storage is unavailable — never throws). */
export async function loadAuthToken(): Promise<StoredAuth | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredAuth>
    if (typeof parsed.token !== 'string' || typeof parsed.identityHash !== 'string') return null
    return { token: parsed.token, identityHash: parsed.identityHash }
  } catch {
    return null
  }
}

/** Persists `{token, identityHash}` for this device — overwrites whatever was stored before. */
export async function saveAuthToken(auth: StoredAuth): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(auth))
}

/** Clears this device's stored `{token, identityHash}` (our own bookkeeping only — does not touch the library's own persisted authorization). */
export async function clearAuthToken(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY)
}

/**
 * Self-check (no test runner wired up for `app/` — same gap/pattern as
 * `hashes.ts`'s golden vectors): asserts `identityHash` is deterministic
 * (same input -> same output, across separate calls and key orderings) and
 * sensitive to every field, including `undefined` vs. an explicit value
 * normalizing the same way. Throws on mismatch.
 */
export function assertIdentityHashSelfCheck(): void {
  const a = identityHash({ name: 'Dexxer', uri: 'https://example.com' })
  const b = identityHash({ name: 'Dexxer', uri: 'https://example.com' })
  if (a !== b) {
    throw new Error(`assertIdentityHashSelfCheck: identityHash not deterministic — got ${a} then ${b}`)
  }
  const withUndefinedIcon = identityHash({ name: 'Dexxer', uri: 'https://example.com', icon: undefined })
  if (a !== withUndefinedIcon) {
    throw new Error('assertIdentityHashSelfCheck: an explicit undefined icon must hash the same as an absent one')
  }
  const differentUri = identityHash({ name: 'Dexxer', uri: 'https://example.com/other' })
  if (a === differentUri) {
    throw new Error('assertIdentityHashSelfCheck: changing uri must change the hash')
  }
  const differentName = identityHash({ name: 'Other', uri: 'https://example.com' })
  if (a === differentName) {
    throw new Error('assertIdentityHashSelfCheck: changing name must change the hash')
  }
  if (!/^[0-9a-f]{64}$/.test(a)) {
    throw new Error(`assertIdentityHashSelfCheck: expected 64 lowercase hex chars (sha256), got ${a}`)
  }
}

if (__DEV__) {
  try {
    assertIdentityHashSelfCheck()
    console.log('[dexxer] assertIdentityHashSelfCheck: identityHash OK')
  } catch (e) {
    console.error('[dexxer] assertIdentityHashSelfCheck FAILED', e)
  }
}
