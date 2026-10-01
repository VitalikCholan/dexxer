// app/src/features/onboard/onboardLegs.ts
//
// What onboarding still has to send for an owner, as transaction legs:
// faucet_init (+ATA-create if missing) + init_user,
// delegateSpl, delegate_user — the L1 legs, fee_payer-sponsored unless the
// owner self-funds — and init_permissions + set_session on the ER,
// owner-paid. Each builder decides from ONE L1 snapshot (`onboardState.ts`)
// and returns a `BatchLeg` or `null` (nothing to do). Week 6 split of
// batchOnboarding.ts, which now only runs the legs. `test/onboarding.test.ts`
// pins every scenario.
//
// --- Week-5 Task 6: zero-SOL onboarding ------------------------------------
//
// Fix round 1 (week 4, task 6) got `faucet_init`/`init_user`/`delegateSpl`
// fronted by `fee_payer` but left two costs on the owner: the ATA-create
// (`createAssociatedTokenAccountIdempotentInstruction`, previously
// owner-funded) and `delegate_user`'s own `payer` field, which had no
// distinct-from-`owner` account at all — a genuinely 0-SOL owner could not
// complete onboarding (real measured minimum ≈0.0033-0.0035 SOL). Week 5
// closed both gaps program-side (`delegate_user` gained its own `payer`,
// split from `owner` — week-5 Task 3 P1) and relayer-side
// (`services/relayer/src/sponsor.ts`'s whitelist now fronts the ATA-create
// AND `delegate_user`'s rent too, `payer@0`/`payer@1` respectively — see its
// file header). This file follows: the ATA-create's `payer` and
// `delegate_user`'s `payer` are now `feePayerPubkey`, not `owner`.
//
// The session fee top-up (a plain `SystemProgram.transfer(owner, session,
// SESSION_LAMPORTS)`, `session.ts`'s former `sessionTopUpIx`) is GONE — not
// just unsponsored-but-present, removed entirely. It funded the session
// key's own ER tx fees; `services/relayer/src/sponsor.ts`'s week-5 file
// header explains why: `fee_payer` cannot pay for an ER transaction it did
// not itself originate (`InvalidAccountForFee`, measured week 4, finding
// A.3), and a plain `SystemProgram.transfer` was the ONLY SystemProgram
// instruction ever on the sponsor whitelist — removing the leg removes that
// whole drain surface by construction (relayer's own words: "with it goes
// the only SystemProgram instruction this endpoint ever accepted").
//
// Two accounts (position slots): `init_user` creates `UserAccount` and the
// zero-copy `Positions` (16 slots) together, `delegate_user` delegates both,
// `init_permissions` makes both private. A returning owner whose accounts are
// `exited` gets NO leg at all: only the relayer's janitor (`close_exited_user`)
// can remove them, after which onboarding starts fresh (state `Exited`).
//
// --- Fix round 1 (task-6 controller ruling) changes, kept for history -----
//
// Finding A.1 (program): `faucet_init`/`init_user` gained a `payer` account
// distinct from `owner` (programs/dexxer_core/src/instructions/user.rs) —
// `fee_payer` now genuinely fronts PDA rent for the L1a leg, not just the
// network fee. Verified on real devnet this fix round.
//
// Finding A.2 (eSPL): `delegateSpl(..., { payer: feePayerPubkey, ... })` —
// `fee_payer` fronts the eSPL init/delegate rent for the L1b leg too (the
// `transferToVaultIx` inside it still moves the OWNER's own dUSDC,
// unaffected). Verified on real devnet this fix round.
//
// Finding A.3 (ER leg) — ATTEMPTED, REVERTED, and now PERMANENT (week 5):
// sponsoring the permissions+session leg too (`feePayer: feePayerPubkey`,
// sent on the owner's TEE connection) was tried and rejected outright by
// devnet-tee — `"InvalidAccountForFee"` — fee_payer is not a valid
// fee-paying account for a transaction on the ER there. The ER leg stays
// owner-funded/owner-feePayer; only its (small) network fee remains a
// non-zero cost, unrelated to rent.
//
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { baseConn, ER_VALIDATOR } from '@/src/lib/solana'
import { dexxerCoreProgram, DEXXER_CORE_PROGRAM_ID } from '@/src/lib/anchor'
import { readUserAccountActionsLeft, readUserAccountSessionExpiry, readUserAccountSessionKey } from '@/src/lib/codecs'
import { delegationTriple } from '@/src/lib/pdas'
import type { Mwa } from '@/src/lib/txSend'
import { LOW_SESSION_ACTIONS } from '@/src/lib/session'
import type { NonceInfo, NonceSlot } from '@/src/lib/nonce'
import {
  eataDelegated,
  isDelegated,
  isExitedOnL1,
  l1KeysFor,
  readL1Snapshot,
  sessionFresh,
  type L1Snapshot,
} from './onboardState'
import {
  DEPOSIT,
  SESSION_ACTIONS,
  SESSION_EXPIRY_SECS,
  SESSION_RENEW_MARGIN_SECS,
  type BatchLeg,
  type OnboardCtx,
  type OnboardState,
} from './onboardTypes'

/** Which relayer-created durable nonce (`nonce.ts`, `dn0/dn1/dn2`) backs each L1 leg — by label, never by array position. */
const LEG_NONCE_SLOT: Record<string, NonceSlot> = {
  'faucet+init_user': 0,
  delegate_spl: 1,
  delegate_user: 2,
}

/** Everything a leg builder decides from — one L1 snapshot, the owner ctx, who pays. */
interface LegEnv {
  ctx: OnboardCtx
  snap: L1Snapshot
  feePayer: PublicKey
  /** `fee_payer` co-signs via `/sponsor` unless the owner self-funds (`selfFund.ts`, `feePayer === owner`). */
  sponsored: boolean
  core: ReturnType<typeof dexxerCoreProgram>
  mwa: Pick<Mwa, 'getConnection'>
  appendLog: (s: string) => void
  nonces: (NonceInfo | null)[]
}

function nonceFor(env: LegEnv, label: string): NonceInfo | undefined {
  return env.nonces[LEG_NONCE_SLOT[label]] ?? undefined
}

function l1Leg(env: LegEnv, label: string, ixs: TransactionInstruction[], onLanded: OnboardState[]): BatchLeg | null {
  if (ixs.length === 0) return null
  return {
    label,
    ixs,
    conn: baseConn,
    feePayer: env.feePayer,
    sponsor: env.sponsored,
    onLanded,
    nonce: nonceFor(env, label),
  }
}

// --- L1a: [createAta?] + faucet_init + init_user ---
// (fee_payer fronts every bit of this leg's rent — the ATA-create too,
// week-5 Task 6, on top of fix round 1's faucet_init/init_user coverage.)
// Measured 25.09 on a nonce (advance + 2 ComputeBudget prepended):
// faucet part 682 bytes, init_user part 631 — comfortably one tx.
async function legFaucetInitUser(env: LegEnv): Promise<BatchLeg | null> {
  const { ctx, snap, feePayer, core, appendLog } = env
  const { owner, config, mint, userAccount, positions, faucetPda, mintAuth, ownerAta, exitSalt } = ctx
  const ixs: TransactionInstruction[] = []
  if (!snap.faucet) {
    if (!snap.ownerAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(feePayer, ownerAta, owner, mint))
    ixs.push(
      await core.methods
        .faucetInit(new BN(DEPOSIT.toString()))
        .accounts({
          owner,
          payer: feePayer,
          config,
          faucet: faucetPda,
          dusdcMint: mint,
          mintAuth,
          ownerAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    )
  } else {
    appendLog('faucet_init: exists, skipped')
  }
  const initAccounts = {
    owner,
    payer: feePayer,
    config,
    userAccount,
    positions,
    systemProgram: SystemProgram.programId,
  }
  if (!snap.userAccount) {
    ixs.push(await core.methods.initUser(Array.from(exitSalt)).accounts(initAccounts).instruction())
  } else {
    appendLog('init_user: exists, skipped')
  }
  return l1Leg(env, 'faucet+init_user', ixs, ['Funded', 'Initialized'])
}

// --- L1b: delegateSpl (fee_payer fronts eSPL rent — Finding A.2)  (leg `delegate_spl`) ---
// --- L1b': delegate_user  (leg `delegate_user`) ---
// Two transactions since 25.09: together, on a nonce (advance + 2
// ComputeBudget prepended) they measured 1322 bytes > 1232 (`Transaction
// too large`, live fakewallet, sponsored 0-SOL wallet — the pre-nonce
// combined tx fit). Both are still signed in the same wallet prompt — one
// more tx and one more relayer-held nonce, not one more tap.
// `delegate_spl` is gated on its own outcome (the eATA under the
// Delegation Program on L1), so a retry after a failed `delegate_user`
// doesn't re-run a non-idempotent `delegateSpl`.
// `snap.userAccount` is `null` both when the account doesn't exist yet
// (about to be created by L1a) and — irrelevantly here — when it does
// exist but isn't delegated; either way delegation is still pending.
async function legDelegateSpl(env: LegEnv): Promise<BatchLeg | null> {
  const { ctx, snap, feePayer, appendLog } = env
  if (isDelegated(snap)) return null
  if (eataDelegated(snap)) {
    appendLog('delegate_spl: eATA already delegated, skipped')
    return null
  }
  const ixs = await delegateSpl(ctx.owner, ctx.mint, DEPOSIT, {
    payer: feePayer,
    validator: ER_VALIDATOR,
    initVaultIfMissing: false,
    idempotent: false,
  })
  return l1Leg(env, 'delegate_spl', ixs, [])
}

async function legDelegateUser(env: LegEnv): Promise<BatchLeg | null> {
  const { ctx, snap, feePayer, core, appendLog } = env
  if (isDelegated(snap)) {
    appendLog('delegate: already delegated, skipped')
    return null
  }
  const { owner, config, userAccount, positions } = ctx
  const ut = delegationTriple(userAccount)
  const pt = delegationTriple(positions)
  const ix = await core.methods
    .delegateUser()
    .accounts({
      owner,
      // Week 5, Task 3 (P1) split this payer out of `owner`; Task 6
      // sponsors it — `fee_payer` fronts the delegation records'
      // rent for both accounts, closing fix round 1's residual "still ≈0.0033-0.0035 SOL"
      // gap (see file header).
      payer: feePayer,
      config,
      bufferUserAccount: ut.buffer,
      delegationRecordUserAccount: ut.record,
      delegationMetadataUserAccount: ut.metadata,
      userAccount,
      bufferPositions: pt.buffer,
      delegationRecordPositions: pt.record,
      delegationMetadataPositions: pt.metadata,
      positions,
      ownerProgram: DEXXER_CORE_PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  return l1Leg(env, 'delegate_user', [ix], ['Delegated'])
}

// --- ER: init_permissions + set_session (owner-paid, unsponsored) ---
//
// Cannot be sponsored — `fee_payer` is not a valid fee-paying account for
// an ER transaction it did not itself originate (`InvalidAccountForFee`,
// measured on devnet-tee, Finding A.3 — see file header). Stays
// owner-feePayer; the only remaining cost here is this leg's own (small)
// ER network fee. Fetches `ownerTee` unconditionally (one MWA
// `signMessages` prompt) since even a "what's left" check needs it to read
// ER-side permission/session state once delegation has happened. The two
// ER reads stay separate `getAccountInfo` calls — see onboardState.ts's
// header for why they are not batched like the L1 ones.
async function legPermissionsSession(env: LegEnv): Promise<BatchLeg | null> {
  const { ctx, snap, mwa, appendLog } = env
  const { owner, config, userAccount, positions, session } = ctx
  const ownerTee = await mwa.getConnection(owner)
  const coreEr = dexxerCoreProgram(ownerTee, owner)
  const userPermission = permissionPdaFromAccount(userAccount)
  const permAccounts = {
    owner,
    config,
    userAccount,
    positions,
    userPermission,
    positionsPermission: permissionPdaFromAccount(positions),
    permissionProgram: PERMISSION_PROGRAM_ID,
    ephemeralVault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
  }
  const setSessionIx = () =>
    coreEr.methods
      .setSession(session.publicKey, new BN(Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECS), SESSION_ACTIONS)
      .accounts(permAccounts)
      .instruction()
  const ixs: TransactionInstruction[] = []
  if (isDelegated(snap)) {
    // Already delegated (a previous run got this far) — real ER state exists, check it.
    const permInfo = await ownerTee.getAccountInfo(userPermission, 'confirmed')
    if (!permInfo || !permInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
      ixs.push(await coreEr.methods.initPermissions().accounts(permAccounts).instruction())
    } else {
      appendLog('init_permissions: exists, skipped')
    }
    const userAccountInfoEr = await ownerTee.getAccountInfo(userAccount, 'confirmed')
    const er = {
      sessionKey: userAccountInfoEr ? readUserAccountSessionKey(userAccountInfoEr.data) : PublicKey.default,
      sessionExpiry: userAccountInfoEr ? readUserAccountSessionExpiry(userAccountInfoEr.data) : 0n,
      actionsLeft: userAccountInfoEr ? readUserAccountActionsLeft(userAccountInfoEr.data) : 0,
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    if (!sessionFresh(er, session.publicKey, nowSec, BigInt(SESSION_RENEW_MARGIN_SECS), LOW_SESSION_ACTIONS)) {
      if (er.sessionKey.equals(session.publicKey))
        appendLog(
          `set_session: same key but expiry ${er.sessionExpiry} is past/near or only ${er.actionsLeft} actions left — renewing`,
        )
      ixs.push(await setSessionIx())
    } else {
      appendLog('set_session: already set to this device session key and fresh, skipped')
    }
  } else {
    // Not delegated yet — the ER validator has nothing to read for these
    // PDAs until L1b lands, so both steps are unconditionally needed once
    // it does (this same batch's L1b, in the normal fresh-onboarding case).
    ixs.push(await coreEr.methods.initPermissions().accounts(permAccounts).instruction())
    ixs.push(await setSessionIx())
  }
  if (ixs.length === 0) return null
  return {
    label: 'permissions+session',
    ixs,
    conn: ownerTee,
    feePayer: owner,
    sponsor: false,
    onLanded: ['Permissioned', 'SessionSet'],
  }
}

/** In send order: L1a before L1b (`delegate_user` needs `init_user` landed), then the ER leg. */
const LEG_BUILDERS: ((env: LegEnv) => Promise<BatchLeg | null>)[] = [
  legFaucetInitUser,
  legDelegateSpl,
  legDelegateUser,
  legPermissionsSession,
]

/**
 * Inspects on-chain state (one L1 snapshot — `onboardState.ts` — plus the
 * ER reads inside the ER leg) and returns only the transaction legs still
 * needed — an already-onboarded wallet gets back an empty array (zero
 * wallet prompts). Pass `l1` to reuse a snapshot the caller already took
 * (`runBatchedOnboarding` does); otherwise one is read here.
 */
export async function collectBatchLegs(
  ctx: OnboardCtx,
  mwa: Pick<Mwa, 'getConnection'>,
  feePayerPubkey: PublicKey,
  appendLog: (s: string) => void,
  nonces: (NonceInfo | null)[] = [null, null, null],
  l1?: L1Snapshot,
): Promise<BatchLeg[]> {
  const snap = l1 ?? (await readL1Snapshot(baseConn, l1KeysFor(ctx.owner, ctx.mint)))
  if (isExitedOnL1(snap)) {
    // Exited accounts can only be closed by the relayer's janitor; sending anything now would fail.
    appendLog('init_user: account exited, waiting for the janitor to close it')
    return []
  }
  const env: LegEnv = {
    ctx,
    snap,
    feePayer: feePayerPubkey,
    sponsored: !feePayerPubkey.equals(ctx.owner),
    core: dexxerCoreProgram(baseConn, ctx.owner),
    mwa,
    appendLog,
    nonces,
  }
  const legs: BatchLeg[] = []
  for (const build of LEG_BUILDERS) {
    const leg = await build(env)
    if (leg) legs.push(leg)
  }
  return legs
}
