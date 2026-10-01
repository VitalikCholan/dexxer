// app/src/features/onboard/onboardTypes.ts
//
// Types and constants shared by the onboarding pipeline (week 6 split of
// batchOnboarding.ts): the coarse `OnboardState` the screen's progress bar
// understands, the finer `BatchProgress` the batch reports, the per-owner
// account bundle (`OnboardCtx`) and the transaction leg shape. No logic.
import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { NonceInfo } from '@/src/lib/nonce'

export type OnboardState =
  'Disconnected' | 'NotOnboarded' | 'Funded' | 'Exited' | 'Initialized' | 'Delegated' | 'Credited' | 'Permissioned' | 'SessionSet'

export type BatchPhase = 'Idle' | 'Collecting' | 'Signing' | 'Submitting' | 'Done' | 'Failed'

export interface BatchProgress {
  phase: BatchPhase
  /** Which leg is in flight/failed — 'faucet+init_user' | 'delegate_spl' | 'delegate_user' | 'permissions+session'. */
  step: string | null
  i: number
  n: number
}

export const IDLE_BATCH_PROGRESS: BatchProgress = { phase: 'Idle', step: null, i: 0, n: 0 }

/** Faucet/deposit amount — 1,000 dUSDC (6 decimals), same as `tests/er/devnet/01-onboard-private.ts`. */
export const DEPOSIT = 1_000_000_000n
// 24h, matching design copy ("Session key active for 24h", OnboardScreen.tsx)
// — `Config.session_expiry`/`UserAccount.session_expiry` is `i64` unix
// seconds with no program-side TTL cap (verified in dexxer_core), so this is
// purely a client-chosen duration.
export const SESSION_EXPIRY_SECS = 86_400
/**
 * A session whose on-chain expiry is within this margin is re-set by the next
 * onboarding/re-authorize run even though the key matches — otherwise a
 * device landing on /onboard with a lapsed session had nothing to sign
 * (measured 25.09: `TradeScreen` said "Session expired", `OnboardScreen`
 * said "You're set", `collectBatchLegs` skipped `set_session`).
 */
export const SESSION_RENEW_MARGIN_SECS = 3_600
export const SESSION_ACTIONS = 20

export interface OnboardCtx {
  owner: PublicKey
  config: PublicKey
  mint: PublicKey
  /** SOL market — kept for `L1Keys` compatibility only; NOT an account of `init_user`/`delegate_user`/`init_permissions`. */
  market: PublicKey
  userAccount: PublicKey
  /** Zero-copy `Positions` (16 slots) — the trader's second delegated account next to `userAccount`. */
  positions: PublicKey
  faucetPda: PublicKey
  mintAuth: PublicKey
  pool: PublicKey
  /** Private live pool counters (week 4, Task 1) — `credit_deposit` writes here. */
  poolLive: PublicKey
  poolAta: PublicKey
  ownerAta: PublicKey
  session: Keypair
  exitSalt: Uint8Array
}

export interface BatchLeg {
  /** Log/progress label — also `BatchProgress.step` while this leg is in flight. */
  label: string
  ixs: TransactionInstruction[]
  conn: Connection
  feePayer: PublicKey
  /** The two L1 legs go through `/sponsor` (fee_payer co-signs, findings A.1/A.2) UNLESS the owner self-funds (`selfFund.ts`, 24.09: Phantom simulation); the ER leg never does — see file header, Finding A.3 (attempted, reverted). */
  sponsor: boolean
  /** `OnboardState` to report once this leg lands. */
  onLanded: OnboardState[]
  /** Durable nonce backing this leg (L1 legs, `nonce.ts`); absent = plain blockhash (ER leg, or nonce accounts not created yet). */
  nonce?: NonceInfo
}
