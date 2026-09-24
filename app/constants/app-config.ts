import { clusterApiUrl } from '@solana/web3.js'
import { Cluster } from '@/components/cluster/cluster'
import { ClusterNetwork } from '@/components/cluster/cluster-network'

export class AppConfig {
  static name = 'app'
  // Fix round 2 (24.09.2026 live Phantom retest): this was still the
  // template placeholder `https://example.com` (visible in logcat's
  // `sign_in_payload: {"uri":"https://example.com"}`), mismatched against
  // the actual MWA identity uri (`components/app-providers.tsx`'s
  // `identity.uri`). SIWS's `uri`/`domain` should describe the same dApp
  // identity `authorize`/`reauthorize` already does.
  static uri = 'https://github.com/VitalikCholan/dexxer'
  static clusters: Cluster[] = [
    {
      id: 'solana:devnet',
      name: 'Devnet',
      endpoint: clusterApiUrl('devnet'),
      network: ClusterNetwork.Devnet,
    },
    {
      id: 'solana:testnet',
      name: 'Testnet',
      endpoint: clusterApiUrl('testnet'),
      network: ClusterNetwork.Testnet,
    },
  ]
}
