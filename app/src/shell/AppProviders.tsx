import { IDENTITY_URI } from '@/src/lib/solana'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js'
import { PropsWithChildren } from 'react'
import { AuthProvider } from '@/src/shell/AuthProvider'
import { config } from '@/src/lib/config'
import { AppTheme } from '@/src/shell/AppTheme'
import { SelectedMarketProvider } from '@/src/lib/marketStore'

// MWA `AppIdentity` (solana-mobile-wallet skill, § provider / AppIdentity):
// `uri` must be a real https URL — wallets display it during authorization
// (fakewallet previously showed "App" / "<no URI>" / "Client not
// verifiable"). This repo is the only https URL we own today; move `uri` to
// the product domain once one exists. `icon` is resolved relative to `uri`
// per the MWA spec — this repo has no favicon served at that path, so it's
// omitted rather than pointed at a 404.
//
// Week 5, Task 6: exported (not just module-private) so it stays the single
// source of truth this literal object identity feeds — an `auth_token` is
// bound to the exact `AppIdentity` it was issued under, and `src/lib/mwa/`'s
// `identityHash`/`ensureAuthorized`/`disconnect` (wired from
// `useOnboarding.ts`'s `connectWallet` and
// `WalletUiButtonDisconnect.tsx`) hash it to detect a change and
// raw-deauthorize the stale token before this repo's `uri` ever moves.
export const identity = { name: 'Dexxer', uri: IDENTITY_URI }
const queryClient = new QueryClient()
export function AppProviders({ children }: PropsWithChildren) {
  return (
    <AppTheme>
      <QueryClientProvider client={queryClient}>
        <SelectedMarketProvider>
          <SolanaProvider>
            <AuthProvider>{children}</AuthProvider>
          </SolanaProvider>
        </SelectedMarketProvider>
      </QueryClientProvider>
    </AppTheme>
  )
}

// Week 6: one network profile (`src/lib/config.ts`) — the template's cluster
// switcher is gone. `chain` is fixed to devnet until there is a second
// deployment to point at; `endpoint` is the PUBLIC devnet RPC on purpose
// (see `walletRpc`'s doc comment).
function SolanaProvider({ children }: PropsWithChildren) {
  return (
    <MobileWalletProvider chain="solana:devnet" endpoint={config.walletRpc} identity={identity}>
      {children}
    </MobileWalletProvider>
  )
}
