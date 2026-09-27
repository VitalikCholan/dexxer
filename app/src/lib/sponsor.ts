// app/src/lib/sponsor.ts
//
// Client side of the relayer's `POST /sponsor` (Task 6, `services/relayer/
// src/sponsor.ts`): hands a whitelisted, already owner-signed `Transaction`
// to the relayer and gets it back with the relayer's `fee_payer` signature
// added. The app never treats a non-2xx response as anything but a hard
// failure — no retry loop here, `useOnboarding.ts` surfaces the server's
// `error` string as-is (it's already specific: "not in whitelist", "rate
// limit", "daily sponsor budget exceeded", etc.). Needs the owner's relayer
// session (spec §2.7, `relayerAuth.ts`): a 401 clears the stored token so the
// next flow run signs in again.
import { PublicKey, Transaction } from '@solana/web3.js'
import { clearRelayerToken, relayerAuthHeaders } from './relayerAuth'
import { RELAYER_URL } from './solana'

export class SponsorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SponsorError'
  }
}

/**
 * Sends `tx` (owner-signed, `tx.feePayer` already set to the relayer's
 * `fee_payer`) to `POST /sponsor` and returns the transaction with the
 * `fee_payer` signature attached. Throws `SponsorError` on any rejection
 * (400/429/5xx) — the caller decides how to surface it (`useOnboarding.ts`'s
 * `Failed(step)` state).
 */
export async function sponsorTx(tx: Transaction, owner: PublicKey): Promise<Transaction> {
  const body = JSON.stringify({
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
  })
  let res: Response
  try {
    res = await fetch(`${RELAYER_URL}/sponsor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await relayerAuthHeaders(owner)) },
      body,
    })
  } catch (e) {
    throw new SponsorError(`could not reach relayer: ${e instanceof Error ? e.message : String(e)}`, 0)
  }
  const payload = (await res.json().catch(() => ({}))) as { tx?: string; error?: string }
  if (res.status === 401) await clearRelayerToken(owner)
  if (!res.ok) {
    throw new SponsorError(payload.error ?? `/sponsor returned ${res.status}`, res.status)
  }
  if (!payload.tx) {
    throw new SponsorError('/sponsor returned 200 without a tx', res.status)
  }
  return Transaction.from(Buffer.from(payload.tx, 'base64'))
}
