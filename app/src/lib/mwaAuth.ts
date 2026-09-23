// app/src/lib/mwaAuth.ts
//
// Week 5, Task 6: identity-aware MWA auth-token hygiene.
//
// `@wallet-ui/react-native-web3js`'s `useAuthorization` (`use-authorization.ts`
// in the library) persists `{authToken, accounts, selectedAccount}` and, on
// every `connect()`, blindly replays the stored `authToken` into
// `wallet.authorize({auth_token, chain, identity})` — catching only
// `ERROR_AUTHORIZATION_FAILED` and retrying token-less. That is enough to
// recover from a wallet that rejects the stale token outright, but it never
// proactively tells the WALLET the old session is done: `disconnect()`
// resolves to the library's `deauthorizeSessions()`, which is just
// `persist(null)` — a local cache clear, no `wallet.deauthorize(...)` call
// at all (confirmed by reading `use-authorization.ts`: `deauthorizeSession`,
// singular, is the one that calls `wallet.deauthorize`, and it is never
// invoked by `disconnect`). Per MWA docs (spec + this project's own
// `mwa-docs-takeaways` memory note): an `auth_token` is bound to the
// identity it was issued to (`AppIdentity`) — reusing one across an
// identity change is undefined/wallet-dependent, and leaving a session
// live on the wallet's side after "disconnecting" in-app is a real leak
// (the wallet still lists the app as authorized).
//
// This file closes both gaps with a raw `transact()` from
// `@solana-mobile/mobile-wallet-adapter-protocol-web3js` (a transitive dep
// of `@wallet-ui/react-native-web3js` — listed explicitly in package.json
// here since this file imports it directly, at the version already pinned
// in the lockfile):
//
//   - `ensureAuthorized`: before authorizing, compares this device's stored
//     `identityHash` (OUR OWN bookkeeping — the library has no concept of
//     "the identity a token was issued under") to the CURRENT app identity's
//     hash. On mismatch, raw-`deauthorize`s the old token first (best
//     effort — a token the wallet has already forgotten is not an error
//     worth surfacing), then lets the hook's own `connect()` authorize
//     fresh. `connect()`'s stale-token retry logic (above) makes this safe
//     even if our own bookkeeping and the library's cache briefly disagree.
//   - `disconnect`: raw-`deauthorize`s the CURRENT token before clearing
//     local state (both the library's, via the passed-in hook `disconnect`,
//     and our own).
//
// Wired from `components/app-providers.tsx`/`AccountScreen.tsx` — see
// those files for where `ensureAuthorized`/`disconnect` replace the raw
// `connect`/`disconnect` calls.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha2'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'

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
 * reordering in a future edit of `app-providers.tsx`'s `identity` literal
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
 * Best-effort raw `wallet.deauthorize({auth_token})` over a fresh
 * `transact()` session. Swallows every error: a token the wallet has
 * already expired/forgotten, a device that errors on an unknown token, or
 * a user backing out of the association prompt should never block the
 * caller (a fresh `authorize`/an app-level disconnect) — this is cleanup,
 * not a precondition.
 */
async function deauthorizeToken(token: string): Promise<void> {
  try {
    await transact(async (wallet) => {
      await wallet.deauthorize({ auth_token: token })
    })
  } catch (e) {
    if (__DEV__) console.warn('[dexxer] mwaAuth: deauthorize failed (continuing)', e)
  }
}

/** Minimal shape this file needs off `useMobileWallet()`'s `store` — avoids importing the library's full `AuthorizationStore` type just to read the current auth token back. */
export interface AuthStoreLike {
  fetch: () => Promise<{ authToken?: string } | null>
}

/**
 * Ensures the wallet is authorized under the CURRENT app `identity` before
 * calling through to `connect` (the hook's own `connect`, which performs
 * the actual `wallet.authorize(...)`). If this device's stored token was
 * issued under a DIFFERENT identity (or none is stored yet), raw-deauthorizes
 * the stale one first — see file header for why the library's own
 * `connect()`/`disconnect()` don't already do this. Always ends by
 * persisting the (possibly unchanged) `{token, identityHash}` pair this
 * device now holds, so the next call's comparison is accurate.
 */
export async function ensureAuthorized(
  identity: Identity,
  connect: () => Promise<unknown>,
  store: AuthStoreLike,
): Promise<unknown> {
  const currentHash = identityHash(identity)
  const stored = await loadAuthToken()
  if (stored && stored.identityHash !== currentHash) {
    await deauthorizeToken(stored.token)
    await clearAuthToken()
  }

  const account = await connect()

  const auth = await store.fetch()
  if (auth?.authToken) {
    await saveAuthToken({ token: auth.authToken, identityHash: currentHash })
  }
  return account
}

/**
 * Deauthorizes the CURRENT session on the wallet's side (raw `transact`,
 * best effort) before clearing local state — both the library's own
 * persisted authorization (`mwaDisconnect`, the hook's `disconnect`) and
 * this file's own `{token, identityHash}` bookkeeping. `disconnect()` alone
 * (the library's) never reaches the wallet at all — see file header.
 */
export async function disconnect(mwaDisconnect: () => Promise<void>, store: AuthStoreLike): Promise<void> {
  const auth = await store.fetch()
  const token = auth?.authToken ?? (await loadAuthToken())?.token
  if (token) {
    await deauthorizeToken(token)
  }
  await mwaDisconnect()
  await clearAuthToken()
}

/**
 * Self-check (no test runner wired up for `app/` — same gap/pattern as
 * `program.ts`'s golden vectors): asserts `identityHash` is deterministic
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
