import { Connection, PublicKey } from '@solana/web3.js'
import { config } from './config'

// Week 6: every value below comes from `config.ts`'s network profile
// (devnet by default, `EXPO_PUBLIC_*` overrides) — this module keeps the
// names the rest of the app imports.

/**
 * Base L1 devnet connection (web3.js v1). Used for anything that reads or
 * writes L1 state directly (wallet balance, airdrops, settlement txs).
 *
 * Do not use this for ER/PER reads or writes — those go through the
 * MagicBlock Oracle / TEE RPC (see TEE_RPC below).
 */
export const baseConn = new Connection(config.baseRpc, 'confirmed')

/**
 * MagicBlock PER (Intel TDX) TEE RPC endpoint for devnet. Ephemeral
 * position accounts live here, not on L1 — see docs/dexxer-architecture.md.
 */
export const TEE_RPC = config.teeRpc

/** TEE RPC's websocket sibling (accountSubscribe etc.), same auth token. */
export const TEE_WS = config.teeWs

/**
 * devnet-tee's ER validator identity — the address PDAs are delegated *to*
 * (`delegateSpl`'s `validator` option, `delegate_user`'s target). Matches
 * `tests/er/lib/env.ts`'s `devnet` profile / weeks0-5-history.md#week-2 §Task 1 M1
 * (this is the TEE validator's own key, not a program-derived signer).
 */
export const ER_VALIDATOR = new PublicKey(config.erValidator)

/**
 * Task 6 (week 4): the relayer's own domain — `services/relayer`, holding
 * `fee_payer` (see repo CLAUDE.md's privacy rule: crank + fee_payer only,
 * never owner/session tokens). `EXPO_PUBLIC_*` so it's baked into the dev
 * build the same way any other `expo-constants`-style env var would be;
 * unset in normal dev, so this falls back to the live Railway deployment.
 */
export const RELAYER_URL = config.relayerUrl

/**
 * MWA dApp identity URI (24.09.2026, live Phantom smoke). Wallets verify the
 * calling APK against `https://<host>/.well-known/assetlinks.json` at this
 * origin (MWA spec, "Identity verification on Android"); Phantom refuses
 * `reauthorize` when that check fails, costing an extra prompt per session.
 * The relayer serves the statement (`services/relayer/src/assetlinks.ts`),
 * so the identity defaults to the relayer's origin. Must be `https`, origin
 * only (no path). Override with `EXPO_PUBLIC_IDENTITY_URI` once the app has
 * its own domain. Changing it invalidates stored auth tokens by design —
 * `mwa/tokenStore.ts`'s `identityHash` detects the change and deauthorizes.
 */
export const IDENTITY_URI = config.identityUri
/** SIWS `domain` — the identity URI's host, per the SIWS spec (must match `uri`). */
export const IDENTITY_DOMAIN = config.identityDomain
