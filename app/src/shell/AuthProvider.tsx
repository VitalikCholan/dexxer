import { IDENTITY_DOMAIN } from '@/src/lib/solana'
import { createContext, type PropsWithChildren, use, useMemo } from 'react'
import { SignInOutput, useMobileWallet } from '@wallet-ui/react-native-web3js'
import { AppConfig } from '@/constants/app-config'
import { useMutation } from '@tanstack/react-query'
import { disconnect as mwaDisconnect, ensureAuthorized } from '@/src/lib/mwa/session'
import { pickSignature, toPublicKey } from '@/src/lib/mwa/accounts'
import { exchangeSiws, fetchChallenge, siwsPayload } from '@/src/lib/relayerAuth'

export interface AuthState {
  isAuthenticated: boolean
  signIn: () => Promise<SignInOutput>
  signOut: () => Promise<void>
}

const Context = createContext<AuthState>({} as AuthState)

export function useAuth() {
  const value = use(Context)
  if (!value) {
    throw new Error('useAuth must be wrapped in a <AuthProvider />')
  }

  return value
}

// Week 5, Task 6, fix round 1 (critical miss): `RootNavigator`
// (`app/_layout.tsx`) gates the ENTIRE app on `useAuth().isAuthenticated` —
// `app/sign-in.tsx`'s "Connect" button, calling this `signIn`, is the
// UNAVOIDABLE top-level entry point the moment the wallet is disconnected
// (confirmed live: the disconnect fix in this same round routes through
// `mwa/session.ts`'s `disconnect`, which flips `isAuthenticated` false and lands here,
// not on Dexxer's own `ConnectScreen`/`useOnboarding`). `signIn` is a
// distinct MWA method from `connect` (`authorizeSessionWithSignIn`, not
// `authorizeSession`) so the original grep for raw `connect()`/`disconnect()`
// missed it — but it shares the exact same stale-`auth_token`-across-
// identity-change exposure `mwa/session.ts` exists to close, since both write
// through the same underlying authorization store. Routed through
// `ensureAuthorized` the same way.
function useSignInMutation() {
  const { signIn, identity, store } = useMobileWallet()

  return useMutation({
    // Fix round 2 (24.09.2026): `uri`/`domain` must describe the same dApp
    // identity as MWA's own `identity.uri` (`AppProviders.tsx`) — a
    // mismatched SIWS uri was still the template placeholder
    // `https://example.com` (logcat: `sign_in_payload: {"uri":"..."}`).
    mutationFn: async () => {
      // spec §2.7: a relayer nonce in the SAME SIWS prompt yields a relayer
      // session for free. Relayer unreachable → plain SIWS as before; flows
      // fetch the session later via `ensureRelayerSession`.
      const challenge = await fetchChallenge().catch((e) => {
        if (__DEV__) console.log(`[dexxer] relayer challenge unavailable — ${String(e)}`)
        return null
      })
      const payload = challenge ? siwsPayload(challenge) : { uri: AppConfig.uri, domain: IDENTITY_DOMAIN }
      const out = await ensureAuthorized(identity, () => signIn(payload), store)
      if (challenge) {
        const owner = toPublicKey(out.account.address)
        try {
          await exchangeSiws(owner, out.signedMessage, pickSignature(out.signedMessage, out.signature, owner))
        } catch (e) {
          if (__DEV__) console.log(`[dexxer] relayer session not issued at Connect — ${String(e)}`)
        }
      }
      return out
    },
  })
}

export function AuthProvider({ children }: PropsWithChildren) {
  const { accounts, disconnect, store } = useMobileWallet()
  const signInMutation = useSignInMutation()

  const value: AuthState = useMemo(
    () => ({
      signIn: async () => await signInMutation.mutateAsync(),
      // Raw hook `disconnect()` never reaches the wallet's own deauthorize —
      // see `mwa/session.ts`'s file header. `signOut` itself isn't wired to any
      // UI today (the real disconnect entry points, `WalletUiDropdown.tsx`
      // and `WalletUiButtonDisconnect.tsx`, call `mwa/session.ts`'s `disconnect`
      // directly, confirmed live), but fixed here too so it can't
      // reintroduce the bug the moment it is wired up.
      signOut: async () => await mwaDisconnect(disconnect, store),
      isAuthenticated: (accounts?.length ?? 0) > 0,
      isLoading: signInMutation.isPending,
    }),
    [accounts, disconnect, store, signInMutation],
  )

  return <Context value={value}>{children}</Context>
}
