// app/src/lib/session.ts
//
// The session key: a locally-generated `Keypair` that signs ER trades
// directly, without an MWA prompt per action — the entire point of session
// keys (docs/dexxer-mobile-stack.md §3). It never leaves the device: stored
// in `expo-secure-store` under `dexxer.session.<owner base58>`, one per
// owner (SecureStore keys may only contain alphanumerics, `.`, `-`, `_` —
// base58 satisfies that).
//
// Onboarding's `set_session` (owner-signed, via MWA) authorizes this key as
// a `UserAccount`/`Positions` permission member
// (`app/src/features/onboard/useOnboarding.ts`); once that lands, the
// session key can sign ER instructions on its own, same as `crank`/`admin`
// in `tests/er/lib/trader.ts`.
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import nacl from 'tweetnacl'
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk'
import { TEE_RPC, TEE_WS } from './solana'

/**
 * Week 6: a session key is considered (nearly) spent at this many remaining
 * `actions_left`. One threshold for both sides of the UX: Trade/Account warn
 * from here down, and a re-authorize run re-issues `set_session` from here
 * down (`onboardState.ts`'s `sessionFresh`) — so the "Re-authorize" button
 * shown with the warning actually does something.
 */
export const LOW_SESSION_ACTIONS = 3

function storageKey(owner: PublicKey): string {
  return `dexxer.session.${owner.toBase58()}`
}

function exitSaltStorageKey(owner: PublicKey): string {
  return `dexxer.exitsalt.${owner.toBase58()}`
}

/**
 * Load the owner's `init_user` exit salt from secure storage, generating and
 * persisting one on first use (week 3, spec §2.4.2). This is a bridge value
 * only — it exists so a re-tap of onboarding after a partial failure reuses
 * the same salt it already sent on chain (idempotent onboarding) rather than
 * generating a new one and mismatching `UserAccount.exit_salt`. The Task-9
 * receipt screen reads the salt back from `UserAccount` via the TEE, not
 * from this store.
 */
export async function getOrCreateExitSalt(owner: PublicKey): Promise<Uint8Array> {
  const key = exitSaltStorageKey(owner)
  const existing = await SecureStore.getItemAsync(key)
  if (existing) {
    return Uint8Array.from(JSON.parse(existing) as number[])
  }
  const salt = crypto.getRandomValues(new Uint8Array(32))
  await SecureStore.setItemAsync(key, JSON.stringify(Array.from(salt)))
  return salt
}

/** Load the owner's session `Keypair` from secure storage, generating and persisting one on first use. */
export async function getOrCreateSessionKeypair(owner: PublicKey): Promise<Keypair> {
  const key = storageKey(owner)
  const existing = await SecureStore.getItemAsync(key)
  if (existing) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(existing) as number[]))
  }
  const kp = Keypair.generate()
  await SecureStore.setItemAsync(key, JSON.stringify(Array.from(kp.secretKey)))
  return kp
}

/** Read the owner's session `Keypair` if one has already been created, without generating a new one. */
export async function getSessionKeypair(owner: PublicKey): Promise<Keypair | null> {
  const existing = await SecureStore.getItemAsync(storageKey(owner))
  if (!existing) return null
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(existing) as number[]))
}

export async function clearSessionKeypair(owner: PublicKey): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(owner))
}

interface CachedTeeConn {
  conn: Connection
  expiresAt: number
}
const cache = new Map<string, CachedTeeConn>()
const REFRESH_SKEW_MS = 30_000

/**
 * The session's own TEE connection — authenticated by signing `getAuthToken`'s
 * challenge locally with the stored keypair (no MWA prompt), mirroring
 * `tests/er/lib/env.ts`'s `teeConn(session)`.
 */
export async function teeConnectionForSession(session: Keypair): Promise<Connection> {
  const key = session.publicKey.toBase58()
  const hit = cache.get(key)
  if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) return hit.conn
  const auth = await getAuthToken(TEE_RPC, session.publicKey, async (m) => nacl.sign.detached(m, session.secretKey))
  const conn = new Connection(`${TEE_RPC}?token=${auth.token}`, {
    wsEndpoint: `${TEE_WS}?token=${auth.token}`,
    commitment: 'confirmed',
  })
  cache.set(key, { conn, expiresAt: auth.expiresAt })
  return conn
}
