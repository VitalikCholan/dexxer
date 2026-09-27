// app/src/lib/mwa/useMwaSigning.ts
//
// The ONLY path real signing/messaging calls may take: every call runs a
// fresh `authorize` and the operation inside one raw `transact()` session
// (`reauthorizeFresh`), never the library's own wrappers. The "fix round 2"
// and "fix round 3" sections in `errors.ts`, and "fix round 4/5" below, are
// the measured reasons. Split out of `mwaAuth.ts` (week 6).
import { useCallback, useMemo } from 'react'
import type { Transaction } from '@solana/web3.js'
import { transact, type Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import type { AuthorizationResult, Chain } from '@solana-mobile/mobile-wallet-adapter-protocol'
import {
  useMobileWallet,
  type Account as WalletUiAccount,
  type AuthorizationStore,
} from '@wallet-ui/react-native-web3js'
import { identityHash, saveAuthToken, type Identity } from './tokenStore'
import { isAuthorizationFailure, SCENARIO_TEARDOWN_DELAY_MS, sleep, withSessionRetry } from './errors'
import { authorizationFromResult, ellipsifyAddress } from './walletUiCompat'

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
          if (__DEV__)
            console.log('[mwa] reauthorize with the latest stored token succeeded (stale-closure token was rejected)')
        } catch (e) {
          if (!isAuthorizationFailure(e)) throw e
          if (__DEV__) console.log('[mwa] latest stored token rejected too; authorizing afresh')
        }
      }
      if (!authResult) authResult = await wallet.authorize({ identity, chain })
      const authorization = authorizationFromResult(authResult, previouslySelectedAccount)
      // `address` is typed `PublicKey` but is a base58 STRING at runtime once
      // it round-trips through the store (see `mwa/accounts.ts`'s `toPublicKey`)
      // — compare the base64 form both sides always carry, print via String().
      const got = String(authorization.selectedAccount.address)
      if (
        previouslySelectedAccount &&
        authorization.selectedAccount.addressBase64 !== previouslySelectedAccount.addressBase64
      ) {
        const expected = String(previouslySelectedAccount.address)
        if (__DEV__) console.error(`[mwa] wallet authorized a different account: got ${got}, expected ${expected}`)
        throw new Error(
          `Wallet returned account ${ellipsifyAddress(got)} instead of the connected ${ellipsifyAddress(expected)} — reconnect the wallet and retry`,
        )
      }
      if (__DEV__) console.log(`[mwa] fresh session authorized as ${ellipsifyAddress(got)}; running the signing op`)
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
 * `signMessages`. Every call runs through {@link reauthorizeFresh} — it
 * NEVER calls the library's own wrappers.
 *
 * Fix round 5 (25.09.2026, live fakewallet "Re-authorize session"): the
 * library's `authorizeSession` captures `authToken` in a hook closure. Two
 * MWA sessions inside one async flow (the TEE login's `signMessages`, then
 * the ER leg's `signTransactions`) rotate the token on the first — the
 * second still sends the pre-rotation token, the wallet rejects it, and
 * wallet-ui's OWN fallback authorizes afresh (`index.native.mjs`'s
 * `authorizeSession`: `ERROR_AUTHORIZATION_FAILED -> wallet.authorize({chain,
 * identity})`) before this file's retry ever sees an error. On fakewallet a
 * fresh authorize mints a NEW account (`B3BY..` replaced the connected
 * `5Ahk..`, whose token became unrecoverable), which then signed the
 * `5Ahk`-fee-payer transaction with the wrong key. {@link reauthorizeFresh}
 * reads the LATEST token from the store at call time and refuses an account
 * switch — so it is the only path signing may take.
 *
 * Every real (non-spike) signing/messaging call site should use this
 * instead of destructuring `signTransactions`/`signMessages` straight off
 * `useMobileWallet()`.
 */
export function useMwaSigning() {
  const { chain, identity, store } = useMobileWallet()

  const signTransactions = useCallback(
    async <K extends Transaction | Transaction[]>(tx: K): Promise<K> => {
      const txs = (Array.isArray(tx) ? tx : [tx]) as Transaction[]
      const signed = await reauthorizeFresh(chain, identity, store, (wallet) =>
        wallet.signTransactions({ transactions: txs }),
      )
      return (Array.isArray(tx) ? signed : signed[0]) as K
    },
    [chain, identity, store],
  )

  const signMessages = useCallback(
    async <K extends Uint8Array | Uint8Array[]>(message: K): Promise<K> => {
      const payloads = (Array.isArray(message) ? message : [message]) as Uint8Array[]
      const signed = await reauthorizeFresh(chain, identity, store, (wallet, account) =>
        wallet.signMessages({ addresses: payloads.map(() => account.addressBase64), payloads }),
      )
      return (Array.isArray(message) ? signed : signed[0]) as K
    },
    [chain, identity, store],
  )

  return useMemo(() => ({ signTransactions, signMessages }), [signTransactions, signMessages])
}
