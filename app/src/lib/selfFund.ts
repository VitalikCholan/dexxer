// app/src/lib/selfFund.ts
//
// Self-funded vs sponsored L1 legs (24.09.2026, live Phantom smoke).
//
// Phantom simulates every transaction it is asked to sign. A `/sponsor`-bound
// transaction has `feePayer = relayer` with the relayer's signature slot still
// EMPTY at signing time, so Phantom's simulation cannot run and it shows
// "Failed to simulate … Confirm (unsafe)" — Phantom's maintainers confirm
// there is no way around that from the wallet side
// (github.com/phantom/docs/discussions/209). The 0-SOL sponsorship path
// (week 5) is therefore kept ONLY for wallets that actually need it; a wallet
// that already holds enough SOL pays its own rent/fees, signs a complete
// transaction, and gets the normal wallet prompt.
//
// Thresholds are deliberately conservative: onboarding rent (Faucet,
// UserAccount, Position, DisclosureQueue, ATA, eATA, three delegation
// records) is ≈0.03 SOL on devnet; the deposit leg is one `faucet_mint` fee.
// Below the threshold we fall back to sponsoring rather than failing the
// user on an "insufficient funds" mid-batch.
import type { PublicKey } from '@solana/web3.js'
import { baseConn } from './solana'

/** Onboarding self-funds only above this — rent for all PDAs + fees, with headroom. */
export const SELF_FUND_ONBOARDING_MIN_LAMPORTS = 50_000_000 // 0.05 SOL
/** A single L1 instruction (e.g. Deposit's `faucet_mint`) self-funds above this. */
export const SELF_FUND_TX_MIN_LAMPORTS = 1_000_000 // 0.001 SOL

/**
 * `true` when `owner` holds at least `minLamports` on L1 and should pay for
 * its own L1 leg (no `/sponsor`). Any RPC failure resolves to `false` — the
 * sponsored path is the one that works for everybody, so it is the safe
 * default.
 */
export async function canSelfFund(owner: PublicKey, minLamports: number): Promise<boolean> {
  try {
    const lamports = await baseConn.getBalance(owner, 'confirmed')
    const self = lamports >= minLamports
    if (__DEV__) console.log(`[dexxer] selfFund: owner has ${lamports} lamports, min ${minLamports} → ${self ? 'self-funded' : 'sponsored'}`)
    return self
  } catch (e) {
    if (__DEV__) console.log(`[dexxer] selfFund: balance read failed, defaulting to sponsored: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
