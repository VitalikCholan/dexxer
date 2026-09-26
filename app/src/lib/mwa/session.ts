// app/src/lib/mwa/session.ts
//
// Week 5, Task 6: identity-aware MWA auth-token hygiene (week 6: split out of
// `mwaAuth.ts`; the token store, error classifiers and the signing hook now
// live beside this file).
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
//     - (week 6: the `spikes/Check8`/`Check10` diagnostics that were also routed
//       through it have been deleted)
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
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { clearAuthToken, identityHash, loadAuthToken, saveAuthToken, type Identity } from './tokenStore'
import { withAuthRetry } from './errors'

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
    if (__DEV__) console.warn('[dexxer] mwa/session: deauthorize failed (continuing)', e)
  }
}

/** Minimal shape this file needs off `useMobileWallet()`'s `store` — avoids importing the library's full `AuthorizationStore` type just to read/clear the current auth token. `persist(null)` is the library's own `deauthorizeSessions()` body (a local cache clear, no on-wallet `deauthorize` call — see file header) and is what `withAuthRetry`'s `clearAuthorization` uses to drop wallet-ui's cached token alongside this file's own. */
export interface AuthStoreLike {
  fetch: () => Promise<{ authToken?: string } | null>
  /** Only ever called with `null` here (clear) — narrower than the library's real `(auth: WalletAuthorization | null) => Promise<void>`, which a wider `unknown` param would reject as incompatible. */
  persist: (auth: null) => Promise<void>
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
