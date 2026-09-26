// app/src/lib/mwa/errors.ts
//
// Classification of the two MWA failure shapes this app recovers from —
// "wallet rejected reauthorize" and "could not open the MWA session at all"
// — and the retry policies built on them. Split out of `mwaAuth.ts` (week
// 6); the fix-round history below is the evidence for each check.
import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'

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
// `AuthProvider.tsx`'s root gate (`isAuthenticated: accounts.length > 0`,
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
export const SCENARIO_TEARDOWN_DELAY_MS = 800
/** Wait before the single retry in {@link withSessionRetry} — long enough that teardown is certainly done by the second attempt. */
const SESSION_ESTABLISHMENT_RETRY_DELAY_MS = 1500

export function sleep(ms: number): Promise<void> {
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
export async function withSessionRetry<T>(run: () => Promise<T>): Promise<T> {
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
