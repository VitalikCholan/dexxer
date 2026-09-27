// app/src/lib/config.ts
//
// The app's one network profile (week 6). Devnet by default — the same
// endpoints `tests/er/lib/env.ts`'s `cfg()` `devnet` profile uses — with
// every entry overridable through an `EXPO_PUBLIC_*` variable, so pointing
// a build at another relayer/validator is an env change, not edits in three
// files (`solana.ts` held the RPC/TEE/validator, `pdas.ts` the feed id).
//
// Metro inlines `process.env.EXPO_PUBLIC_*` only when read as a STATIC
// member expression, at bundle time. `ENV` below captures each one that
// way exactly once; `resolveConfig` is a pure function of such an object,
// which is also what makes it testable (`test/config.test.ts`) without
// touching module caches.

export interface NetworkConfig {
  /** Base-layer (L1) RPC — wallet balance, L1 legs, `Disclosure`/`BalancesRoot` reads. */
  baseRpc: string
  /** The wallet-ui `MobileWalletProvider` endpoint (`useMobileWallet().connection`): the PUBLIC devnet RPC, which serves `requestAirdrop` — `baseRpc` (MagicBlock's) is for the app's own reads and sends. */
  walletRpc: string
  /** MagicBlock PER (Intel TDX) TEE RPC — ephemeral position accounts live here, not on L1. */
  teeRpc: string
  /** TEE websocket sibling (`accountSubscribe`), same auth token. Derived from `teeRpc`. */
  teeWs: string
  /** The ER validator identity PDAs are delegated *to* (`delegateSpl`'s `validator`, `delegate_user`'s target). */
  erValidator: string
  /** `services/relayer` origin — `/sponsor`, `/nonce`, indexer REST + WS. No trailing slash. */
  relayerUrl: string
  /** MWA dApp identity URI (Digital Asset Links at `<origin>/.well-known/assetlinks.json`). Origin only, no trailing slash. */
  identityUri: string
  /** SIWS `domain` — `identityUri`'s host. */
  identityDomain: string
  /** Pyth Lazer feed id the devnet market was `init_market`'d with (`tests/er/lib/admin.ts`'s `LAZER_FEED_ID`). */
  lazerFeedId: string
}

/** Devnet defaults — `docs/deployments.md`, `tests/er/lib/env.ts`. */
export const DEVNET = {
  baseRpc: 'https://rpc.magicblock.app/devnet',
  walletRpc: 'https://api.devnet.solana.com',
  teeRpc: 'https://devnet-tee.magicblock.app',
  erValidator: 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
  relayerUrl: 'https://relayer-production-1ae7.up.railway.app',
  lazerFeedId: '6',
} as const

export type EnvOverrides = Partial<
  Record<
    | 'EXPO_PUBLIC_BASE_RPC'
    | 'EXPO_PUBLIC_WALLET_RPC'
    | 'EXPO_PUBLIC_TEE_RPC'
    | 'EXPO_PUBLIC_ER_VALIDATOR'
    | 'EXPO_PUBLIC_RELAYER_URL'
    | 'EXPO_PUBLIC_IDENTITY_URI'
    | 'EXPO_PUBLIC_LAZER_FEED_ID',
    string | undefined
  >
>

// Static reads on purpose — see the file header.
const ENV: EnvOverrides = {
  EXPO_PUBLIC_BASE_RPC: process.env.EXPO_PUBLIC_BASE_RPC,
  EXPO_PUBLIC_WALLET_RPC: process.env.EXPO_PUBLIC_WALLET_RPC,
  EXPO_PUBLIC_TEE_RPC: process.env.EXPO_PUBLIC_TEE_RPC,
  EXPO_PUBLIC_ER_VALIDATOR: process.env.EXPO_PUBLIC_ER_VALIDATOR,
  EXPO_PUBLIC_RELAYER_URL: process.env.EXPO_PUBLIC_RELAYER_URL,
  EXPO_PUBLIC_IDENTITY_URI: process.env.EXPO_PUBLIC_IDENTITY_URI,
  EXPO_PUBLIC_LAZER_FEED_ID: process.env.EXPO_PUBLIC_LAZER_FEED_ID,
}

const noTrailingSlash = (u: string) => u.replace(/\/$/, '')

export function resolveConfig(env: EnvOverrides = ENV): NetworkConfig {
  const teeRpc = env.EXPO_PUBLIC_TEE_RPC ?? DEVNET.teeRpc
  const relayerUrl = noTrailingSlash(env.EXPO_PUBLIC_RELAYER_URL ?? DEVNET.relayerUrl)
  // Identity defaults to the relayer's origin, which serves the Digital
  // Asset Links statement; must be `https` origin-only for wallets to verify
  // it — override once the app has its own domain.
  const identityUri = noTrailingSlash(env.EXPO_PUBLIC_IDENTITY_URI ?? new URL(relayerUrl).origin)
  return {
    baseRpc: env.EXPO_PUBLIC_BASE_RPC ?? DEVNET.baseRpc,
    walletRpc: env.EXPO_PUBLIC_WALLET_RPC ?? DEVNET.walletRpc,
    teeRpc,
    teeWs: teeRpc.replace(/^https/, 'wss').replace(/^http:/, 'ws:'),
    erValidator: env.EXPO_PUBLIC_ER_VALIDATOR ?? DEVNET.erValidator,
    relayerUrl,
    identityUri,
    identityDomain: new URL(identityUri).host,
    lazerFeedId: env.EXPO_PUBLIC_LAZER_FEED_ID ?? DEVNET.lazerFeedId,
  }
}

/** The resolved profile this build runs against. */
export const config: NetworkConfig = resolveConfig()
