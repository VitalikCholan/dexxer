// app/src/lib/relayerAuth.ts
//
// Relayer API session (spec §2.7): the relayer's write endpoints (`/sponsor`,
// `/nonce`) need a Bearer token it issues for a Sign-In With Solana message
// carrying its own single-use nonce. Connect (`auth-provider.tsx`) gets one
// for free from the SIWS prompt it already shows; flows that talk to the
// relayer call `ensureRelayerSession` BEFORE their first wallet prompt —
// `signOwnerL1` silently falls back to a live blockhash when `/nonce` fails,
// which on Phantom means "confirm timeout" (Alpenglow), so a late 401 must
// never be what discovers a missing session.
//
// The token opens only the relayer's API — it is not a TEE token and never
// leaves this app except in that header. Stored per owner in SecureStore.
import { PublicKey } from '@solana/web3.js'
import * as SecureStore from 'expo-secure-store'
import { createSignInMessage } from '@solana/wallet-standard-util'
import { useCallback } from 'react'
import { IDENTITY_DOMAIN, IDENTITY_URI, RELAYER_URL } from './solana'
import { useMwaSigning } from './mwaAuth'
import { pickSignature } from '../spikes/mwa'

/** Renew this long before the relayer's `expiresAt`, so a flow never starts on a token about to lapse. */
const REFRESH_SKEW_MS = 5 * 60 * 1000

export interface SiwsChallenge {
  nonce: string
  issuedAt: string
  expirationTime: string
  domain: string
  uri: string
  statement: string
  version: string
}

interface StoredSession {
  token: string
  expiresAt: number
}

export class RelayerAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RelayerAuthError'
  }
}

function storageKey(owner: PublicKey): string {
  return `dexxer.relayer.${owner.toBase58()}`
}

async function getRelayerToken(owner: PublicKey): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(storageKey(owner))
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as StoredSession
    return s.expiresAt - REFRESH_SKEW_MS > Date.now() ? s.token : null
  } catch {
    return null
  }
}

export async function clearRelayerToken(owner: PublicKey): Promise<void> {
  await SecureStore.deleteItemAsync(storageKey(owner))
}

/** `Authorization` header for the relayer's write endpoints — empty when there is no live session (the relayer then answers 401). */
export async function relayerAuthHeaders(owner: PublicKey): Promise<Record<string, string>> {
  const token = await getRelayerToken(owner)
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${RELAYER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new RelayerAuthError(`could not reach relayer: ${e instanceof Error ? e.message : String(e)}`, 0)
  }
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new RelayerAuthError(payload.error ?? `${path} returned ${res.status}`, res.status)
  return payload
}

export async function fetchChallenge(): Promise<SiwsChallenge> {
  return postJson<SiwsChallenge>('/auth/challenge', {})
}

/**
 * The SIWS fields to sign: `domain`/`uri` are the app's own MWA identity
 * (what the wallet checks the request against); nonce/timestamps/statement
 * come from the relayer's challenge.
 */
export function siwsPayload(challenge: SiwsChallenge) {
  if (__DEV__ && challenge.domain !== IDENTITY_DOMAIN) {
    console.warn(
      `[dexxer] relayer SIWS_DOMAIN ${challenge.domain} ≠ app IDENTITY_DOMAIN ${IDENTITY_DOMAIN} — the relayer will reject this sign-in`,
    )
  }
  return {
    domain: IDENTITY_DOMAIN,
    uri: IDENTITY_URI,
    statement: challenge.statement,
    version: challenge.version,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expirationTime: challenge.expirationTime,
  }
}

/** Trades a signed SIWS message for a relayer session and stores it. `signature` must be the bare 64-byte ed25519 signature. */
export async function exchangeSiws(owner: PublicKey, signedMessage: Uint8Array, signature: Uint8Array): Promise<void> {
  const out = await postJson<{ token: string; expiresAt: number }>('/auth/siws', {
    address: owner.toBase58(),
    signedMessage: Buffer.from(signedMessage).toString('base64'),
    signature: Buffer.from(signature).toString('base64'),
  })
  const stored: StoredSession = { token: out.token, expiresAt: out.expiresAt }
  await SecureStore.setItemAsync(storageKey(owner), JSON.stringify(stored))
}

/** No-op with a live token; otherwise one `signMessage` prompt over a relayer-nonced SIWS message. */
export async function ensureRelayerSession(
  owner: PublicKey,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<void> {
  if (await getRelayerToken(owner)) return
  const challenge = await fetchChallenge()
  const message = createSignInMessage({ ...siwsPayload(challenge), address: owner.toBase58() })
  await exchangeSiws(owner, message, await signMessage(message))
}

/**
 * The relayer cannot issue a session right now: unreachable (0), no `/auth`
 * on this deployment (404 — a relayer predating spec §2.7), or a server-side
 * failure (5xx). Flows then carry on exactly as they did before sessions
 * existed whenever the relayer was down (`/nonce` → live blockhash, `/sponsor`
 * legs fail with the relayer's own error) instead of blocking a self-funded
 * owner. A 4xx from `/auth/siws` or a wallet rejection still surfaces.
 */
function relayerUnavailable(e: unknown): boolean {
  return e instanceof RelayerAuthError && (e.status === 0 || e.status === 404 || e.status >= 500)
}

/** Hook form: signs with `useMwaSigning()`'s retry-wrapped `signMessages`, normalized by `pickSignature` (same as `er.ts`). */
export function useRelayerSession() {
  const { signMessages } = useMwaSigning()
  const ensure = useCallback(
    async (owner: PublicKey) => {
      try {
        await ensureRelayerSession(owner, async (message) => pickSignature(message, await signMessages(message), owner))
      } catch (e) {
        if (!relayerUnavailable(e)) throw e
        if (__DEV__) console.log(`[dexxer] relayer session unavailable, continuing without it — ${String(e)}`)
      }
    },
    [signMessages],
  )
  return { ensureRelayerSession: ensure }
}
