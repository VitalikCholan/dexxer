import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js'
import { PropsWithChildren } from 'react'
import { AuthProvider } from '@/components/auth/auth-provider'
import { ClusterProvider, useCluster } from '@/components/cluster/cluster-provider'
import { AppTheme } from '@/components/app-theme'

// MWA `AppIdentity` (solana-mobile-wallet skill, § provider / AppIdentity):
// `uri` must be a real https URL — wallets display it during authorization
// (fakewallet previously showed "App" / "<no URI>" / "Client not
// verifiable"). This repo is the only https URL we own today; move `uri` to
// the product domain once one exists. `icon` is resolved relative to `uri`
// per the MWA spec — this repo has no favicon served at that path, so it's
// omitted rather than pointed at a 404.
const identity = { name: 'Dexxer', uri: 'https://github.com/VitalikCholan/dexxer' }
const queryClient = new QueryClient()
export function AppProviders({ children }: PropsWithChildren) {
  return (
    <AppTheme>
      <QueryClientProvider client={queryClient}>
        <ClusterProvider>
          <SolanaProvider>
            <AuthProvider>{children}</AuthProvider>
          </SolanaProvider>
        </ClusterProvider>
      </QueryClientProvider>
    </AppTheme>
  )
}

// We have this SolanaProvider because of the network switching logic.
// If you only connect to a single network, use MobileWalletProvider directly.
function SolanaProvider({ children }: PropsWithChildren) {
  const { selectedCluster } = useCluster()
  return (
    <MobileWalletProvider chain={selectedCluster.id} endpoint={selectedCluster.endpoint} identity={identity}>
      {children}
    </MobileWalletProvider>
  )
}
