// app/src/features/onboard/onboardState.ts
//
// Week 6: the on-chain state onboarding decides from, read ONCE, plus the
// pure decisions derived from it. Before this, `collectBatchLegs`,
// `runBatchedOnboarding` and `useOnboarding`'s mount-time gate each issued
// their own sequential `getAccountInfo` calls for the same handful of
// accounts (six base-layer round trips per `advance()`); now the five L1
// accounts arrive in one `getMultipleAccountsInfo` and every branch below
// is a function of that snapshot — testable without a connection
// (`test/onboardState.test.ts`; `test/onboarding.test.ts` pins the legs
// built on top).
//
// ER-side state (permission PDA, the delegated `UserAccount`'s session
// fields) is deliberately NOT batched here: whether devnet-tee serves
// permissioned accounts through `getMultipleAccounts` is unmeasured, so the
// owner-TEE reads stay as the two `getAccountInfo` calls they always were.
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DELEGATION_PROGRAM_ID, deriveEphemeralAta } from '@magicblock-labs/ephemeral-rollups-sdk'
import { pdas } from '@/src/lib/pdas'
import { readUserAccountExited } from '@/src/lib/codecs'
import type { OnboardState } from './batchOnboarding'

export interface L1Keys {
  config: PublicKey
  faucet: PublicKey
  ownerAta: PublicKey
  userAccount: PublicKey
  /** Ephemeral ATA (eSPL) — delegated by `delegateSpl`, gates the `delegate_spl` leg. */
  eata: PublicKey
}

/** Raw `AccountInfo` (or `null` = does not exist) for each of `L1Keys`, as one base-layer read returned them. */
export type L1Snapshot = { [K in keyof L1Keys]: AccountInfo<Buffer> | null }

/** The five base-layer accounts onboarding looks at for `owner`, given the deployment's dUSDC `mint`. */
export function l1KeysFor(owner: PublicKey, mint: PublicKey): L1Keys {
  return {
    config: pdas.config(),
    faucet: pdas.faucet(owner),
    ownerAta: getAssociatedTokenAddressSync(mint, owner),
    userAccount: pdas.userAccount(owner),
    eata: deriveEphemeralAta(owner, mint)[0],
  }
}

/** The subset of `Connection` `readL1Snapshot` needs — a test passes a fake. */
export type BaseReader = Pick<Connection, 'getMultipleAccountsInfo'>

/** One `getMultipleAccountsInfo` over all of `keys` (5 accounts, well under the RPC's 100-key cap). */
export async function readL1Snapshot(base: BaseReader, keys: L1Keys): Promise<L1Snapshot> {
  const [config, faucet, ownerAta, userAccount, eata] = await base.getMultipleAccountsInfo(
    [keys.config, keys.faucet, keys.ownerAta, keys.userAccount, keys.eata],
    'confirmed',
  )
  return { config, faucet, ownerAta, userAccount, eata }
}

/** `UserAccount` exists and sits under the Delegation Program — the ER owns it now. */
export function isDelegated(snap: L1Snapshot): boolean {
  return snap.userAccount !== null && snap.userAccount.owner.equals(DELEGATION_PROGRAM_ID)
}

/**
 * Returning owner (week-5 Task 2): the `UserAccount` PDA survived a prior
 * `undelegate_user`, is back under `dexxer_core` and carries `exited`. Only
 * `init_user_reuse_queue` (`mut`, not `init`) can re-initialise it.
 */
export function needsReuseQueue(snap: L1Snapshot): boolean {
  return snap.userAccount !== null && !isDelegated(snap) && readUserAccountExited(snap.userAccount.data)
}

/** The eSPL ephemeral ATA is already delegated — `delegateSpl` is not idempotent, so its leg must be skipped. */
export function eataDelegated(snap: L1Snapshot): boolean {
  return snap.eata !== null && snap.eata.owner.equals(DELEGATION_PROGRAM_ID)
}

/**
 * Coarse L1-only progress for the onboarding screen's gate (no ER auth
 * prompt needed) — formerly `useOnboarding`'s `checkL1Progress`.
 */
export function l1ProgressFrom(snap: L1Snapshot): OnboardState {
  if (!snap.faucet) return 'NotOnboarded'
  if (!snap.userAccount) return 'Funded'
  if (isDelegated(snap)) return 'Delegated'
  return 'Initialized'
}

/** The ER-side `UserAccount` fields `set_session` is decided on. */
export interface ErSession {
  sessionKey: PublicKey
  /** Unix seconds (`UserAccount.session_expiry`, i64). */
  sessionExpiry: bigint
  /** `UserAccount.actions_left` — spent one per session-signed trade. */
  actionsLeft: number
}

/**
 * `true` iff the on-chain session is this device's key, expires more than
 * `marginSecs` after `nowSec`, AND still has more than `lowActions` actions
 * — a matching key that lapses sooner, or is (nearly) out of actions, is
 * re-set now rather than leaving the device with nothing to sign later
 * (expiry: measured 25.09, `SESSION_RENEW_MARGIN_SECS`; actions: week 6 —
 * `set_session` is what refills `actions_left`, so a re-authorize that
 * skipped it on a key with 0 actions left would change nothing).
 */
export function sessionFresh(
  er: ErSession,
  deviceKey: PublicKey,
  nowSec: bigint,
  marginSecs: bigint,
  lowActions: number,
): boolean {
  return er.sessionKey.equals(deviceKey) && er.sessionExpiry > nowSec + marginSecs && er.actionsLeft > lowActions
}
