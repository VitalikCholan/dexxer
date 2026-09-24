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
import { PublicKey, type Transaction } from '@solana/web3.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha2'
import { transact, type Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
  type AuthorizationResult,
  type Chain,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import {
  useMobileWallet,
  toUint8Array,
  type Account as WalletUiAccount,
  type AuthorizationStore,
  type WalletAuthorization,
} from '@wallet-ui/react-native-web3js'

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
// `isAuthorizationFailure` below recognizes either shape (raw RN error or
// the converted protocol error, plus a string-message fallback for anything
// that got wrapped again in between). `withAuthRetry` (clear-then-retry) and
// `reauthorizeFresh` (fresh-authorize-in-one-session, no clear) below are
// the two different recovery strategies built on top of it — see "fix round
// 2" right below for why there are two.
//
// --- Fix round 2 (24.09.2026 live Phantom retest): WHY it always rejects ---
//
// Phantom's own log names the real reason, independent of the RN
// missing-`await` bug above: `Declining sol_mwa_reauthorize: dApp identity
// is not verified (mwaIdentityVerified !== true)`. Phantom only honours
// `reauthorize` for dApps it has verified via Digital Asset Links at
// `identity.uri` — for an unverified identity (this app, until we host
// `assetlinks.json` on our own domain) EVERY `reauthorize` is rejected,
// unconditionally, forever, not just on a stale/expired token. So the fix
// round 1 retry (`withAuthRetry`: catch the -1, `store.persist(null)`,
// re-run the SAME call) was necessary but landed on the wrong strategy for
// the SIGNING path: clearing the store empties `accounts`, and
// `auth-provider.tsx`'s root gate (`isAuthenticated: accounts.length > 0`,
// `app/_layout.tsx`) reads an empty `accounts` as "disconnected" and
// navigates to `/sign-in` — observed live on commit 921a1cb: reauthorize
// -1 -> store cleared -> root gate bounces to `/sign-in` mid-onboarding ->
// the retried sign call never lands because the screen that was calling it
// is gone.
//
// `reauthorizeFresh` below is the fix: it never clears the store. It runs a
// genuinely fresh `wallet.authorize({identity, chain})` (no `auth_token` —
// a true `authorize`, which Phantom does NOT gate on identity verification,
// only `reauthorize` is refused) and the actual signing/messaging call
// INSIDE THE SAME raw `transact()` session, then persists the new
// authorization over the old one directly — `accounts` is never empty at
// any point observers can see it. The user sees one extra `authorize`
// prompt before the sign/message prompt every time a signing session starts
// (until Digital Asset Links verification is live), instead of a silent
// failure or a navigation bounce.
//
// `withAuthRetry` (clear-then-retry) is kept for `ensureAuthorized`'s
// connect/SIWS path only — there is no "already connected" screen to fall
// out of when `connect`/`signIn` themselves are what the user is currently
// waiting on, so clearing first is safe there and simpler than replicating
// `reauthorizeFresh` for a plain authorize with no extra `op`.

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

// --- Fix round 3 (24.09.2026 live Phantom retest #2): teardown race -------
//
// Fix round 2's `reauthorizeFresh` opens a SECOND raw `transact()` session
// right after the FIRST session (the one wallet-ui's own `signTransactions`/
// `connect` opened, which failed on `reauthorize`) tears down. Logcat
// (10:16:46): wallet-ui's `endSession` at `:46.404` -> our `startSession` at
// `:46.429` (25 ms later) -> association intent sent to Phantom at `:46.436`
// -> Phantom's own `onScenarioTeardownComplete` for the FIRST session only
// at `:46.437` — one millisecond after our new association intent already
// went out. Phantom drops the new association outright: no "Parsed
// association Uri" for it in its log (at `10:14` it even parsed the intent
// TWICE across two scenario generations, then `onScenarioError`d). Native
// symptom: `LocalAssociationScenario$ConnectionFailedException: Unable to
// connect to websocket server`. A run with a ~1 s natural gap between the
// two sessions (10:16:33) succeeded outright — this is a pure timing race,
// not a logic bug: Phantom needs its previous MWA scenario fully torn down
// before it accepts a new local association, measured at roughly
// 100–500 ms after `endSession`.
//
// Two independent mitigations below: `SCENARIO_TEARDOWN_DELAY_MS` waits
// BEFORE opening the new session at all (shrinks how often the race is even
// hit), and `withSessionRetry` catches it if the race is lost anyway and
// retries once after `SESSION_ESTABLISHMENT_RETRY_DELAY_MS` (by then
// Phantom's teardown is certainly done). Both are applied everywhere this
// file opens a session right after a previous one just failed:
// `reauthorizeFresh` (fix round 2's fresh-authorize path) and
// `withAuthRetry`'s retried `run()` (`ensureAuthorized`'s connect/SIWS
// path) — never on the FIRST attempt of either, which isn't racing
// anything.

/** Phantom's measured scenario-teardown window (see above) — waited before opening a new session right after a previous one closed. */
const SCENARIO_TEARDOWN_DELAY_MS = 800
/** Wait before the single retry in {@link withSessionRetry} — long enough that teardown is certainly done by the second attempt. */
const SESSION_ESTABLISHMENT_RETRY_DELAY_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `SolanaMobileWalletAdapterError` codes that name a session/association
 * failure (as opposed to a config/environment error a retry can't fix, or
 * `ERROR_ASSOCIATION_CANCELLED`, which is the user deliberately backing out
 * — retrying that would just reopen a prompt they closed on purpose).
 */
const SESSION_ESTABLISHMENT_ERROR_CODES: readonly string[] = [
  SolanaMobileWalletAdapterErrorCode.ERROR_ASSOCIATION_PORT_OUT_OF_RANGE,
  SolanaMobileWalletAdapterErrorCode.ERROR_WALLET_NOT_FOUND,
  SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_TIMEOUT,
  SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED,
  SolanaMobileWalletAdapterErrorCode.ERROR_ILLEGAL_TRANSPORT_STATE,
]

/**
 * True when `e` is some shape of "couldn't open the MWA session at all" —
 * the scenario-teardown race documented above, or one of the protocol
 * library's own session-establishment error codes. Message-substring
 * matching is the primary signal: the native
 * `LocalAssociationScenario$ConnectionFailedException` reaches JS as a
 * generic error whose `.code` is not one of the protocol library's own
 * codes (`transact`'s `startSession` call IS properly `await`ed — unlike
 * the missing-`await` bug `isAuthorizationFailure` works around — so this
 * doesn't need that same raw-vs-converted shape matching).
 */
export function isSessionEstablishmentFailure(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { code?: unknown; message?: unknown }
  const message = typeof err.message === 'string' ? err.message : ''
  if (message.includes('ConnectionFailedException')) return true
  if (message.includes('Unable to connect to websocket server')) return true
  if (typeof err.code === 'string' && SESSION_ESTABLISHMENT_ERROR_CODES.includes(err.code)) return true
  return false
}

/**
 * Runs `run()`; on an {@link isSessionEstablishmentFailure} error, waits
 * {@link SESSION_ESTABLISHMENT_RETRY_DELAY_MS} and runs it exactly once
 * more. Any other error, or a second failure, propagates as-is (no infinite
 * retry) — mirrors {@link withAuthRetry}'s shape, for a different failure
 * class.
 */
async function withSessionRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (!isSessionEstablishmentFailure(e)) throw e
    await sleep(SESSION_ESTABLISHMENT_RETRY_DELAY_MS)
    return await run()
  }
}

/**
 * Runs `run()`; on an {@link isAuthorizationFailure} error, clears the
 * stored authorization (`opts.clearAuthorization`), waits out Phantom's
 * scenario-teardown window ({@link SCENARIO_TEARDOWN_DELAY_MS} — see "fix
 * round 3" above), and runs it once more through {@link withSessionRetry}
 * (so a lost teardown race gets its own extra chance) — the retried call
 * then authorizes fresh instead of reauthorizing. Any other error, or a
 * second failure, propagates as-is (no infinite retry).
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
    await sleep(SCENARIO_TEARDOWN_DELAY_MS)
    return await withSessionRetry(run)
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

/** Replica of wallet-ui's internal, unexported `ellipsify` (`get-account-from-authorized-account.ts`) — only used as the label fallback below, so a replicated `WalletAuthorization` matches the library's own output field-for-field. */
function ellipsifyAddress(str: string, len = 4, delimiter = '..'): string {
  const limit = len * 2 + delimiter.length
  return str.length > limit ? str.slice(0, len) + delimiter + str.slice(-len) : str
}

/**
 * Replica of wallet-ui's internal, unexported `getAccountFromAuthorizedAccount`
 * — decodes one raw protocol `Account` (base64 `address`) into wallet-ui's
 * own `Account` shape (a real `PublicKey`). Neither this nor
 * `getAuthorizationFromAuthorizationResult` below is exported by the
 * library (confirmed reading `index.native.mjs`'s export list) — replicated
 * here so `reauthorizeFresh`'s `store.persist(...)` writes the exact shape
 * the library itself would have written.
 */
function accountFromAuthorizedAccount(account: AuthorizationResult['accounts'][number]): WalletUiAccount {
  const address = new PublicKey(toUint8Array(account.address))
  return {
    address,
    addressBase64: account.address,
    icon: account.icon as WalletUiAccount['icon'],
    label: account.label ?? ellipsifyAddress(address.toString()),
    publicKey: address,
  }
}

/**
 * Replica of wallet-ui's internal, unexported `getAuthorizationFromAuthorizationResult`
 * — same account-carryover rule (keep the previously selected account if
 * it's still in the newly authorized set, otherwise fall back to the first
 * account), so a fresh authorize never silently switches the active
 * account out from under the caller.
 */
function authorizationFromResult(
  result: AuthorizationResult,
  previouslySelectedAccount: WalletUiAccount | undefined,
): WalletAuthorization {
  const accounts = result.accounts.map(accountFromAuthorizedAccount)
  const stillAuthorized =
    previouslySelectedAccount != null &&
    result.accounts.some(({ address }) => address === previouslySelectedAccount.addressBase64)
  return {
    accounts,
    authToken: result.auth_token,
    selectedAccount: stillAuthorized ? previouslySelectedAccount! : accounts[0],
  }
}

/**
 * Phantom refuses `reauthorize` for unverified dApp identities (Digital
 * Asset Links at `identity.uri`); until we host `assetlinks.json` on our
 * own domain, each signing session re-authorizes with a prompt instead of
 * silently reusing the cached token. This runs that fresh `authorize` (no
 * `auth_token`) and `op(wallet, account)` in ONE raw `transact()` session —
 * one extra prompt, never two separate sessions — and persists the result
 * into wallet-ui's `store` without ever clearing it first (see "fix round
 * 2" above for why clearing first broke onboarding on live Phantom).
 *
 * This is exactly the "open a new session right after a previous one just
 * failed" shape "fix round 3" above warns about (the previous session being
 * the one whose `reauthorize` just got rejected) — so it waits out
 * {@link SCENARIO_TEARDOWN_DELAY_MS} first and runs the `transact()` call
 * itself through {@link withSessionRetry}.
 */
async function reauthorizeFresh<T>(
  chain: Chain,
  identity: Identity,
  store: AuthorizationStore,
  op: (wallet: Web3MobileWallet, account: WalletUiAccount) => Promise<T>,
): Promise<T> {
  const previous = await store.fetch()
  const previouslySelectedAccount = previous?.selectedAccount
  await sleep(SCENARIO_TEARDOWN_DELAY_MS)
  const { authorization, result } = await withSessionRetry(() =>
    transact(async (wallet) => {
      let authResult: AuthorizationResult | undefined
      // Fix round 4 (24.09.2026, live fakewallet Deposit): fakewallet ROTATES
      // the auth token on every `reauthorize` and revokes the previous one
      // (`AuthRepositoryImpl: Reissued AuthRecord id=9 ... Revoking id=8`).
      // Two signing calls inside ONE async flow (Deposit = `signTransactions`
      // for the L1 leg, then `signMessages` for the TEE token) hit this:
      // the second call's wallet-ui closure still carried the pre-rotation
      // token -> instant `-1`. The store, however, already holds the rotated
      // token — so try THAT before authorizing afresh. Authorizing afresh is
      // not free on fakewallet: a fresh `authorize` mints a brand-new account
      // (`5Ahk..` instead of the connected `6YX1..`), which then signs with
      // the wrong key (`pickSignature` "no 64-byte slice verifies").
      const latestToken = previous?.authToken
      if (latestToken) {
        try {
          authResult = await wallet.authorize({ identity, chain, auth_token: latestToken })
          console.log('[mwa] reauthorize with the latest stored token succeeded (stale-closure token was rejected)')
        } catch (e) {
          if (!isAuthorizationFailure(e)) throw e
          console.log('[mwa] latest stored token rejected too; authorizing afresh')
        }
      }
      if (!authResult) authResult = await wallet.authorize({ identity, chain })
      const authorization = authorizationFromResult(authResult, previouslySelectedAccount)
      // `address` is typed `PublicKey` but is a base58 STRING at runtime once
      // it round-trips through the store (see `spikes/mwa.ts`'s `toPublicKey`)
      // — compare the base64 form both sides always carry, print via String().
      const got = String(authorization.selectedAccount.address)
      if (previouslySelectedAccount && authorization.selectedAccount.addressBase64 !== previouslySelectedAccount.addressBase64) {
        const expected = String(previouslySelectedAccount.address)
        console.error(`[mwa] wallet authorized a different account: got ${got}, expected ${expected}`)
        throw new Error(`Wallet returned account ${ellipsifyAddress(got)} instead of the connected ${ellipsifyAddress(expected)} — reconnect the wallet and retry`)
      }
      console.log(`[mwa] fresh session authorized as ${ellipsifyAddress(got)}; running the signing op`)
      const result = await op(wallet, authorization.selectedAccount)
      return { authorization, result }
    }),
  )
  await store.persist(authorization)
  await saveAuthToken({ token: authorization.authToken, identityHash: identityHash(identity) })
  return result
}

/**
 * Drop-in replacement for `useMobileWallet()`'s raw `signTransactions`/
 * `signMessages`: tries the raw hook call first (cheap — reuses the cached
 * token when the wallet still accepts `reauthorize`), and on
 * {@link isAuthorizationFailure} falls back to {@link reauthorizeFresh}
 * exactly once (no further retry — a second failure propagates as-is).
 * Every real (non-spike) signing/messaging call site should use this
 * instead of destructuring `signTransactions`/`signMessages` straight off
 * `useMobileWallet()`.
 */
export function useMwaSigning() {
  const {
    chain,
    identity,
    signTransactions: rawSignTransactions,
    signMessages: rawSignMessages,
    store,
  } = useMobileWallet()

  const signTransactions = useCallback(
    async <K extends Transaction | Transaction[]>(tx: K): Promise<K> => {
      try {
        return await rawSignTransactions(tx)
      } catch (e) {
        if (!isAuthorizationFailure(e)) throw e
        console.log('[mwa] signTransactions: reauthorize rejected by the wallet; retrying in a fresh session')
        const txs = (Array.isArray(tx) ? tx : [tx]) as Transaction[]
        const signed = await reauthorizeFresh(chain, identity, store, (wallet) =>
          wallet.signTransactions({ transactions: txs }),
        )
        return (Array.isArray(tx) ? signed : signed[0]) as K
      }
    },
    [rawSignTransactions, chain, identity, store],
  )

  const signMessages = useCallback(
    async <K extends Uint8Array | Uint8Array[]>(message: K): Promise<K> => {
      try {
        return await rawSignMessages(message)
      } catch (e) {
        if (!isAuthorizationFailure(e)) throw e
        console.log('[mwa] signMessages: reauthorize rejected by the wallet; retrying in a fresh session')
        const payloads = (Array.isArray(message) ? message : [message]) as Uint8Array[]
        const signed = await reauthorizeFresh(chain, identity, store, (wallet, account) =>
          wallet.signMessages({ addresses: payloads.map(() => account.addressBase64), payloads }),
        )
        return (Array.isArray(message) ? signed : signed[0]) as K
      }
    },
    [rawSignMessages, chain, identity, store],
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

/**
 * Self-check for {@link isSessionEstablishmentFailure}: both the exact
 * "fix round 3" message shape (native exception name + wording) and the
 * message-only fallback, plus a matching protocol error code, must all read
 * as a session-establishment failure; an unrelated error (including
 * {@link isAuthorizationFailure}'s own "authorization request failed" —
 * the two checks must not collide) must not. Throws on mismatch.
 */
export function assertIsSessionEstablishmentFailureSelfCheck(): void {
  const connectionFailed = new Error(
    'LocalAssociationScenario$ConnectionFailedException: Unable to connect to websocket server',
  )
  if (!isSessionEstablishmentFailure(connectionFailed)) {
    throw new Error(
      'assertIsSessionEstablishmentFailureSelfCheck: ConnectionFailedException message must read as a session-establishment failure',
    )
  }
  const messageOnly = new Error('Unable to connect to websocket server')
  if (!isSessionEstablishmentFailure(messageOnly)) {
    throw new Error(
      'assertIsSessionEstablishmentFailureSelfCheck: message-only fallback must read as a session-establishment failure',
    )
  }
  const codeBased = new SolanaMobileWalletAdapterError(
    SolanaMobileWalletAdapterErrorCode.ERROR_WALLET_NOT_FOUND,
    'Found no installed wallet that supports the mobile wallet protocol.',
  )
  if (!isSessionEstablishmentFailure(codeBased)) {
    throw new Error(
      'assertIsSessionEstablishmentFailureSelfCheck: ERROR_WALLET_NOT_FOUND must read as a session-establishment failure',
    )
  }
  const unrelated = new Error('authorization request failed')
  if (isSessionEstablishmentFailure(unrelated)) {
    throw new Error(
      'assertIsSessionEstablishmentFailureSelfCheck: an authorization failure must not read as a session-establishment failure',
    )
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
  try {
    assertIsSessionEstablishmentFailureSelfCheck()
    console.log('[dexxer] assertIsSessionEstablishmentFailureSelfCheck: isSessionEstablishmentFailure OK')
  } catch (e) {
    console.error('[dexxer] assertIsSessionEstablishmentFailureSelfCheck FAILED', e)
  }
}
