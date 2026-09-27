// app/src/lib/mwa/walletUiCompat.ts
//
// Replicas of `@wallet-ui/react-native-web3js` INTERNALS that the library
// does not export — needed so `useMwaSigning.ts`'s `reauthorizeFresh` can
// persist an authorization in exactly the shape the library itself writes.
//
// PINNED TO `@wallet-ui/react-native-web3js@4.3.0` (exact, no caret — see
// package.json). Nothing here is covered by the library's public contract:
// on any wallet-ui upgrade, re-read `get-account-from-authorized-account.ts`
// and `use-authorization.ts` in the new version and re-verify each replica
// below line by line. Split out of `mwaAuth.ts` (week 6) precisely so this
// upgrade-sensitive code is one small file rather than a corner of a large one.
import { PublicKey } from '@solana/web3.js'
import type { AuthorizationResult } from '@solana-mobile/mobile-wallet-adapter-protocol'
import { toUint8Array, type Account as WalletUiAccount, type WalletAuthorization } from '@wallet-ui/react-native-web3js'

/** Replica of wallet-ui's internal, unexported `ellipsify` (`get-account-from-authorized-account.ts`) — only used as the label fallback below, so a replicated `WalletAuthorization` matches the library's own output field-for-field. */
export function ellipsifyAddress(str: string, len = 4, delimiter = '..'): string {
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
export function authorizationFromResult(
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
