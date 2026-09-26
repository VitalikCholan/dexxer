import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'

/**
 * Normalise what the MWA wallet returns from `signMessages`.
 * Some wallets return the 64-byte detached signature; others return
 * `message ‖ signature` (or `signature ‖ message`). Pick whichever slice
 * verifies against the owner key, and report the raw length for RESULT.md.
 */
export function pickSignature(message: Uint8Array, signed: Uint8Array, owner: PublicKey, log?: (s: string) => void) {
  const candidates: [string, Uint8Array][] = [
    ['as-is', signed],
    ['last64', signed.slice(-64)],
    ['first64', signed.slice(0, 64)],
  ]
  for (const [label, sig] of candidates) {
    if (sig.length !== 64) continue
    if (nacl.sign.detached.verify(message, sig, owner.toBytes())) {
      log?.(`signMessages returned ${signed.length} bytes; signature = ${label}`)
      return sig
    }
  }
  throw new Error(`no 64-byte slice of the ${signed.length}-byte signMessages result verifies for ${owner.toBase58()}`)
}

/** The hook's `account.address` is typed PublicKey but is a base58 string at runtime. */
export function toPublicKey(address: unknown): PublicKey {
  return address instanceof PublicKey ? address : new PublicKey(String(address))
}
