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
// Wired at every real connect/disconnect entry point in the app — fix round
// 1 (week 5, Task 6 review) found the first pass had missed several, so this
// list is now the actual, grepped-clean set (`grep -rn "await connect()\|
// await disconnect()" app/{src,components}` outside this file returns
// nothing):
//   `ensureAuthorized(identity, connect, store)`:
//     - `useOnboarding.ts`'s `connectWallet` (the onboarding flow's Connect)
//     - `wallet-ui-button-connect.tsx`'s `WalletUiButtonConnect` (Account tab
//       header's disconnected fallback, Settings' "Connect your wallet")
//     - `spikes/Check8.tsx`/`Check10.tsx` (dev-only diagnostics, routed too
//       so they can't reintroduce the stale-token bug even though they
//       exercise an unrelated spike program)
//   `disconnect(mwaDisconnect, store)`:
//     - `wallet-ui-button-disconnect.tsx`'s `WalletUiButtonDisconnect`
//       (Settings' "Disconnect" button)
//     - `wallet-ui-dropdown.tsx`'s "Disconnect" dropdown item (Account tab
//       header, connected state)
//     - `auth-provider.tsx`'s `signOut` (currently unreferenced by any UI —
//       fixed anyway so it can't reintroduce the bug the moment it is)
// `AppIdentity` itself is `components/app-providers.tsx`'s exported
// `identity` object, read fresh from `useMobileWallet()` at each call site
// (never imported directly here — this file only hashes whatever `Identity`
// shape a caller hands it).
import { useCallback, useMemo } from 'react'
import type { Transaction } from '@solana/web3.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha2'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import {
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'

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

/** Minimal shape this file needs off `useMobileWallet()`'s `store` — avoids importing the library's full `AuthorizationStore` type just to read/clear the current auth token. `persist(null)` is the library's own `deauthorizeSessions()` body (a local cache clear, no on-wallet `deauthorize` call — see file header) and is what `withAuthRetry`'s `clearAuthorization` uses to drop wallet-ui's cached token alongside this file's own. */
export interface AuthStoreLike {
  fetch: () => Promise<{ authToken?: string } | null>
  /** Only ever called with `null` here (clear) — narrower than the library's real `(auth: WalletAuthorization | null) => Promise<void>`, which a wider `unknown` param would reject as incompatible. */
  persist: (auth: null) => Promise<void>
}

// --- Phantom reauthorize bug: retry-once-with-fresh-authorize -------------
//
// Week 5 live Phantom smoke test: after SIWS connect, the app's first
// `mwa.signTransactions([...])` call replays the stored `auth_token` via
// `wallet.authorize({auth_token, chain, identity})` (wallet-ui's
// `authorizeSession`, `index.native.mjs` ~line 200) — the JSON-RPC
// `reauthorize`. Phantom answers `code=-1 "authorization request failed"`
// and closes the session (the reference fakewallet never rejects a
// reauthorize, so week 4-5 never hit this).
//
// wallet-ui DOES have a retry for exactly this
// (`error instanceof SolanaMobileWalletAdapterProtocolError && error.code
// === ERROR_AUTHORIZATION_FAILED` -> re-`authorize` without the token), but
// it never fires on React Native. Upstream bug, not ours:
// `@solana-mobile/mobile-wallet-adapter-protocol`'s
// `lib/cjs/index.native.js` (~line 300) builds the wallet proxy as
// `try { return SolanaMobileWalletAdapter.invoke(method, params) } catch (e)
// { return handleError(e) }` — `invoke` returns a Promise and this is
// missing an `await`, so a rejection never reaches the local `catch`; it
// propagates as the RAW React Native native-module error instead
// (`e.code === 'JSON_RPC_ERROR'`, `e.userInfo.jsonRpcErrorCode === -1`,
// `e.message === 'authorization request failed'`). wallet-ui's `instanceof
// SolanaMobileWalletAdapterProtocolError` check fails against that raw
// shape, so its retry never runs, and the error propagates up to
// `transact`'s own outer `catch (e) { return handleError(e) }` — only THERE
// does it get converted to a `SolanaMobileWalletAdapterProtocolError(0, -1,
// msg)`, one level too late for wallet-ui's inner retry to see it.
//
// `isAuthorizationFailure`/`withAuthRetry` below recover on our side: catch
// either shape (raw RN error or the converted protocol error, plus a
// string-message fallback for anything that got wrapped again in between),
// clear BOTH this file's own token and wallet-ui's persisted one, and run
// the signing/messaging call exactly once more — the retry then has no
// stored token at all, so wallet-ui/Phantom does a fresh `authorize`
// (one prompt) instead of a `reauthorize`.

/**
 * True when `e` is some shape of "wallet rejected `reauthorize`"
 * (MWA protocol code -1, `ERROR_AUTHORIZATION_FAILED`) — see the section
 * header above for why this needs to match multiple shapes of the same
 * underlying error.
 */
export function isAuthorizationFailure(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { code?: unknown; message?: unknown; userInfo?: { jsonRpcErrorCode?: unknown } }
  if (err.code === -1) return true
  if (err.code === 'JSON_RPC_ERROR' && err.userInfo?.jsonRpcErrorCode === -1) return true
  if (
    e instanceof SolanaMobileWalletAdapterProtocolError &&
    e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED
  ) {
    return true
  }
  if (typeof err.message === 'string' && err.message.includes('authorization request failed')) return true
  return false
}

/**
 * Runs `run()`; on an {@link isAuthorizationFailure} error, clears the
 * stored authorization (`opts.clearAuthorization`) and runs it exactly once
 * more — the retried call then authorizes fresh instead of reauthorizing.
 * Any other error, or a second failure, propagates as-is (no infinite
 * retry).
 */
export async function withAuthRetry<T>(
  run: () => Promise<T>,
  opts: { clearAuthorization: () => Promise<void> },
): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (!isAuthorizationFailure(e)) throw e
    await opts.clearAuthorization()
    return await run()
  }
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
 *
 * `connect` itself runs through `withAuthRetry`: a stale token on connect
 * (the wallet rejects `reauthorize`, same -1 as the signing path — see
 * "Phantom reauthorize bug" above) self-heals the same way, instead of
 * surfacing as a connect failure.
 */
export async function ensureAuthorized<T>(
  identity: Identity,
  connect: () => Promise<T>,
  store: AuthStoreLike,
): Promise<T> {
  const currentHash = identityHash(identity)
  const stored = await loadAuthToken()
  if (stored && stored.identityHash !== currentHash) {
    await deauthorizeToken(stored.token)
    await clearAuthToken()
  }

  const account = await withAuthRetry(connect, {
    clearAuthorization: async () => {
      await clearAuthToken()
      await store.persist(null)
    },
  })

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
 * Drop-in replacement for `useMobileWallet()`'s raw `signTransactions`/
 * `signMessages` — both wrapped in {@link withAuthRetry} so a wallet's
 * `reauthorize` rejection (Phantom `-1`, see "Phantom reauthorize bug"
 * above) self-heals with one extra `authorize` prompt instead of surfacing
 * to the caller as `-1 authorization request failed`. Every real (non-spike)
 * signing/messaging call site should use this instead of destructuring
 * `signTransactions`/`signMessages` straight off `useMobileWallet()`.
 */
export function useMwaSigning() {
  const { signTransactions: rawSignTransactions, signMessages: rawSignMessages, store } = useMobileWallet()

  const clearAuthorization = useCallback(async () => {
    await clearAuthToken()
    await store.persist(null)
  }, [store])

  const signTransactions = useCallback(
    <K extends Transaction | Transaction[]>(tx: K): Promise<K> =>
      withAuthRetry(() => rawSignTransactions(tx), { clearAuthorization }),
    [rawSignTransactions, clearAuthorization],
  )

  const signMessages = useCallback(
    <K extends Uint8Array | Uint8Array[]>(message: K): Promise<K> =>
      withAuthRetry(() => rawSignMessages(message), { clearAuthorization }),
    [rawSignMessages, clearAuthorization],
  )

  return useMemo(() => ({ signTransactions, signMessages }), [signTransactions, signMessages])
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

/**
 * Self-check for {@link isAuthorizationFailure}: the three error shapes the
 * "Phantom reauthorize bug" section above documents must all read as an
 * authorization failure, and an unrelated error must not. Throws on
 * mismatch.
 */
export function assertIsAuthorizationFailureSelfCheck(): void {
  const rawJsonRpc = {
    code: 'JSON_RPC_ERROR',
    userInfo: { jsonRpcErrorCode: -1 },
    message: 'authorization request failed',
  }
  if (!isAuthorizationFailure(rawJsonRpc)) {
    throw new Error('assertIsAuthorizationFailureSelfCheck: raw RN JSON_RPC_ERROR shape must read as an auth failure')
  }
  const converted = new SolanaMobileWalletAdapterProtocolError(
    0,
    SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED,
    'authorization request failed',
  )
  if (!isAuthorizationFailure(converted)) {
    throw new Error(
      'assertIsAuthorizationFailureSelfCheck: converted SolanaMobileWalletAdapterProtocolError must read as an auth failure',
    )
  }
  const messageOnly = new Error('authorization request failed')
  if (!isAuthorizationFailure(messageOnly)) {
    throw new Error('assertIsAuthorizationFailureSelfCheck: message-only fallback must read as an auth failure')
  }
  const unrelated = new Error('network request failed')
  if (isAuthorizationFailure(unrelated)) {
    throw new Error('assertIsAuthorizationFailureSelfCheck: an unrelated error must not read as an auth failure')
  }
}

if (__DEV__) {
  try {
    assertIdentityHashSelfCheck()
    console.log('[dexxer] assertIdentityHashSelfCheck: identityHash OK')
  } catch (e) {
    console.error('[dexxer] assertIdentityHashSelfCheck FAILED', e)
  }
  try {
    assertIsAuthorizationFailureSelfCheck()
    console.log('[dexxer] assertIsAuthorizationFailureSelfCheck: isAuthorizationFailure OK')
  } catch (e) {
    console.error('[dexxer] assertIsAuthorizationFailureSelfCheck FAILED', e)
  }
}
