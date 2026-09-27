// app/src/lib/nonce.ts
//
// Durable nonces for every OWNER-signed L1 transaction (24.09.2026, live
// Phantom onboarding).
//
// Why: Alpenglow shortened devnet slots to ~150–250 ms (activated 24.08;
// mainnet-beta activation starts 28.09), so the 150-slot blockhash window is
// now ~25 s — measured on both rpc.magicblock.app/devnet and
// api.devnet.solana.com. A Phantom prompt takes ~38 s before the user can
// even confirm (its fee estimation backs off on 429s from
// api.devnet.solana.com), so EVERY plain-blockhash tx we handed it came back
// expired and was silently dropped ("confirm timeout"). A durable nonce
// replaces `recentBlockhash` with the value stored in a nonce account; the tx
// stays valid until that nonce is advanced, so the wallet may take as long
// as it likes (solana.com/docs/core/transactions/durable-nonces).
//
// Who creates the accounts: the RELAYER (`POST /nonce`,
// `services/relayer/src/nonce.ts`) — the owner cannot land the creation tx
// either (same slow wallet), while the relayer signs instantly. The relayer
// fronts the rent (~0.00145 SOL each); the nonce AUTHORITY is the owner, so
// only the owner's signature can advance/use them. Two accounts per owner:
// onboarding signs its two L1 legs in ONE wallet prompt and each needs its
// own nonce; every later single L1 tx (Deposit's `faucet_mint`, …) uses
// slot 0. The call is idempotent and free once the accounts exist.
//
// Needs the owner's relayer session (spec §2.7, `relayerAuth.ts`); a 401
// clears the stored token so the next flow run signs in again.
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { clearRelayerToken, relayerAuthHeaders } from './relayerAuth'
import { RELAYER_URL } from './solana'

export type NonceSlot = 0 | 1

export interface NonceInfo {
  slot: NonceSlot
  account: PublicKey
  /** Current stored nonce — used as the tx's `recentBlockhash`. */
  value: string
}

interface NonceResponse {
  owner?: string
  created?: boolean
  signature?: string
  nonces?: { account: string; nonce: string | null }[]
  error?: string
}

/**
 * Asks the relayer for the owner's two nonce accounts (creating them on the
 * first call) and returns their CURRENT nonce values — always call right
 * before building a tx; a value is single-use. Throws on any relayer
 * failure; callers decide whether to fall back to a live blockhash.
 */
export async function fetchNonces(owner: PublicKey): Promise<NonceInfo[]> {
  let res: Response
  try {
    res = await fetch(`${RELAYER_URL}/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await relayerAuthHeaders(owner)) },
      body: JSON.stringify({ owner: owner.toBase58() }),
    })
  } catch (e) {
    throw new Error(`nonce: could not reach relayer: ${e instanceof Error ? e.message : String(e)}`)
  }
  const body = (await res.json().catch(() => ({}))) as NonceResponse
  if (res.status === 401) await clearRelayerToken(owner)
  if (!res.ok) throw new Error(body.error ?? `nonce: /nonce returned ${res.status}`)
  const list = body.nonces ?? []
  if (list.length !== 2 || list.some((n) => !n.nonce)) throw new Error('nonce: relayer returned an incomplete nonce set')
  if (__DEV__ && body.created) console.log(`[dexxer] nonce: relayer created the nonce accounts (${body.signature})`)
  return list.map((n, i) => ({ slot: i as NonceSlot, account: new PublicKey(n.account), value: n.nonce as string }))
}

/**
 * A transaction on a durable nonce: web3.js prepends `nonceAdvance(owner)`
 * and uses `nonce.value` as `recentBlockhash` when the message is compiled,
 * so the tx never expires by slot — only when the nonce is advanced.
 */
export function nonceTransaction(feePayer: PublicKey, owner: PublicKey, nonce: NonceInfo, ixs: TransactionInstruction[]): Transaction {
  const tx = new Transaction({
    feePayer,
    nonceInfo: {
      nonce: nonce.value,
      nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: nonce.account, authorizedPubkey: owner }),
    },
  })
  // Phantom prepends its own ComputeBudget instructions to a tx that has none
  // (measured 24.09; phantom/docs#91) — which pushes `AdvanceNonceAccount`
  // out of slot 0 and turns the durable-nonce tx into an ordinary one with an
  // unknown blockhash ("Blockhash not found", silently dropped). Carrying our
  // own ComputeBudget pair right after the advance keeps Phantom from adding
  // its own. The relayer's /sponsor whitelist accepts both (price ≤ cap).
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: NONCE_TX_CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: NONCE_TX_CU_PRICE_MICROLAMPORTS }),
    ...ixs,
  )
  return tx
}

/** Generous for the heaviest owner L1 tx (onboarding L1a: ATA + faucet_init + init_user ≈ 200k CU). */
export const NONCE_TX_CU_LIMIT = 600_000
/** Token priority fee — enough to be a real SetComputeUnitPrice, negligible in cost (600k CU × 1000 µL = 0.0006 SOL max). */
export const NONCE_TX_CU_PRICE_MICROLAMPORTS = 1_000
