// app/src/lib/er.ts
//
// Owner-side TEE (PER) connection: `devnet-tee.magicblock.app` requires a
// `?token=` from `getAuthToken`, proven by signing a challenge message with
// the identity being authenticated (spike-07, week2-results.md §Task 1
// M1/M2, `tests/er/lib/env.ts`'s `teeConn`). For the OWNER, that signature
// has to come from Mobile Wallet Adapter (`signMessages`) — there is no
// local owner key. `session.ts` has the session-key equivalent, which signs
// locally instead.
//
// `signMessages`'s raw response isn't reliably the bare 64-byte ed25519
// signature on every wallet (week-0 finding, `spikes/mwa.ts`'s
// `pickSignature`) — normalized here before it reaches `getAuthToken`.
import { Connection, PublicKey } from '@solana/web3.js'
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk'
import { pickSignature } from '../spikes/mwa'
import { TEE_RPC, TEE_WS } from './solana'
import { useMwaSigning } from './mwa/useMwaSigning'

interface CachedTeeConn {
  conn: Connection
  expiresAt: number
}

// In-memory only (not persisted, unlike the session key) — cheap to
// re-derive on cold start, and per-identity like the reference's `teeConn`.
const cache = new Map<string, CachedTeeConn>()

// getAuthToken doesn't expose a token TTL beyond `expiresAt`; refresh a
// little early so a request never races expiry mid-flight.
const REFRESH_SKEW_MS = 30_000

export type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>

/** Owner (or any keyed identity)'s TEE connection, cached in memory per pubkey. */
export async function teeConnectionFor(owner: PublicKey, signMessage: SignMessageFn): Promise<Connection> {
  const key = owner.toBase58()
  const hit = cache.get(key)
  if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) return hit.conn
  const auth = await getAuthToken(TEE_RPC, owner, signMessage)
  const conn = new Connection(`${TEE_RPC}?token=${auth.token}`, {
    wsEndpoint: `${TEE_WS}?token=${auth.token}`,
    commitment: 'confirmed',
  })
  cache.set(key, { conn, expiresAt: auth.expiresAt })
  return conn
}

/**
 * `useTeeConnection()`: `getConnection(owner)` returns (and caches) a TEE
 * `Connection` authenticated as `owner`, via MWA `signMessages` +
 * `pickSignature`. One MWA prompt per fresh/expired token, not per call.
 * `signMessages` here is `useMwaSigning()`'s retry-wrapped version (a
 * `reauthorize` rejection self-heals with one fresh `authorize` prompt
 * instead of surfacing as `-1 authorization request failed` — see
 * `mwa/errors.ts`'s "Phantom reauthorize bug" section).
 */
export function useTeeConnection() {
  const { signMessages } = useMwaSigning()
  async function getConnection(owner: PublicKey): Promise<Connection> {
    return teeConnectionFor(owner, async (message) => {
      const signed = await signMessages(message) // MWA bottom sheet
      return pickSignature(message, signed, owner)
    })
  }
  return { getConnection }
}
