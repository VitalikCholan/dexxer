// app/src/features/onboard/batchOnboarding.ts
//
// The batched onboarding engine (Task 6, week 4; extracted from
// useOnboarding.ts in fix round 1, finding E): faucet_init (+ATA-create if
// missing) + init_user + delegateSpl + delegate_user collected into up to
// two sponsored L1 transactions, and init_permissions + set_session (+ the
// session fee top-up) collected into one owner-paid ER transaction — signed
// in ONE `mwa.signTransactions([...])` call. `useOnboarding.ts` stays the
// thin hook wrapper: React state, `buildCtx`, and the legacy `runFlow`
// fallback (`LEGACY_ONBOARDING`) live there; this file owns the shared
// send/confirm primitives and the batch pipeline itself.
//
// --- Fix round 1 (task-6 controller ruling) changes -----------------------
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
// Finding A.3 (ER leg) — ATTEMPTED, REVERTED: tried sponsoring the
// permissions+session leg too (`feePayer: feePayerPubkey`, sent on the
// owner's TEE connection, with the session top-up folded in as a
// SystemProgram transfer — `services/relayer/src/sponsor.ts` still supports
// this shape in its whitelist). Verified directly against live devnet-tee
// this fix round (`tests/er/devnet/zz-verify-sponsor-flow.ts`, a non-MWA
// reproduction of this exact leg): the TEE rejects it — `"InvalidAccountForFee"`
// — fee_payer is not a valid fee-paying account for a transaction on the ER
// there (confirms `app/src/lib/session.ts`'s `sessionTopUpIx` doc comment:
// the ER only clones a referenced non-delegated account's *L1* balance for
// reads, so a non-delegated arbitrary payer's fee-paying role isn't
// recognized). Reverted to owner-funded/owner-feePayer (below), the
// pre-fix-round design, reconfirmed working end-to-end this run
// (`tests/er/devnet/01-onboard-private.ts` PASS) — per the task-6 brief's
// contingency: "keep L1 rent sponsorship [...] report DONE_WITH_CONCERNS
// naming the residual gap." See `collectBatchLegs`'s ER-leg comment below
// for the full account.
//
// Post-verification finding (not one of A-E, found while verifying A):
// `delegate_user` has no `payer` field distinct from `owner` (unchanged by
// this fix round — Finding A only touched `faucet_init`/`init_user`), and
// its own CPI to the Delegation Program needs MORE lamports from `owner`
// than `init_user`'s existing permission-rent prefund covers (observed on
// real devnet: ~1.1-1.35M extra lamports, on top of the ~1.49M ATA rent +
// ~0.65M owner-wallet rent floor already required). So a genuinely
// zero-lamport owner still cannot complete onboarding even after this fix
// round — real minimum observed ≈0.0033-0.0035 SOL, not zero. Flagged in
// the report as a residual gap for a future round; not fixed here (out of
// this round's assigned scope, needs its own investigation).
//
// Finding D (review): blockhashes are fetched immediately before
// `signTransactions` (not earlier — `collectBatchLegs` below does no RPC
// blockhash reads at all, only account-state reads). Between legs, each
// leg's blockhash is re-validated (`Connection.isBlockhashValid`) right
// before it's submitted — confirming an earlier leg can take up to ~15s
// (`confirmOnConn`'s 100 tries * 150ms), long enough for a later leg's
// blockhash to expire while waiting. An expired leg is rebuilt with a fresh
// blockhash and re-signed ALONE (one extra MWA prompt, logged as `re-sign
// leg i (blockhash expired)`) rather than failing the whole batch.
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  type Keypair,
} from '@solana/web3.js'
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
import {
  dexxerCoreProgram,
  readConfigFeePayer,
  readUserAccountFreeMargin,
  readUserAccountSessionKey,
  DEXXER_CORE_PROGRAM_ID,
} from '@/src/lib/program'
import { delegationTriple } from '@/src/lib/pdas'
import { sponsorTx, SponsorError } from '@/src/lib/sponsor'
import { sessionTopUpIx, SESSION_LAMPORTS } from '@/src/lib/session'

export type OnboardState =
  'Disconnected' | 'NotOnboarded' | 'Funded' | 'Initialized' | 'Delegated' | 'Credited' | 'Permissioned' | 'SessionSet'

export type BatchPhase = 'Idle' | 'Collecting' | 'Signing' | 'Submitting' | 'Done' | 'Failed'

export interface BatchProgress {
  phase: BatchPhase
  /** Which leg is in flight/failed — 'faucet+init_user' | 'delegate' | 'permissions+session'. */
  step: string | null
  i: number
  n: number
}

export const IDLE_BATCH_PROGRESS: BatchProgress = { phase: 'Idle', step: null, i: 0, n: 0 }

/** Faucet/deposit amount — 1,000 dUSDC (6 decimals), same as `tests/er/devnet/01-onboard-private.ts`. */
export const DEPOSIT = 1_000_000_000n
export const SESSION_EXPIRY_SECS = 3600
export const SESSION_ACTIONS = 20

export function errText(e: unknown): string {
  const err = e as { message?: string }
  return err?.message ?? String(e)
}

// L1 send: sign via MWA (sign-only), then submit ourselves on `baseConn`.
// We deliberately do NOT use the wallet's `signAndSendTransactions`: the
// reference fakewallet's `SendTransactionsUseCase` throws
// `InvalidTransactionsException` (JSON-RPC code -2, "payloads invalid for
// signing") on multi-instruction transactions such as `delegateSpl` (3 eSPL
// ixs) — reproduced on-device 21.09, while single-ix `faucet_init`/`init_user`
// sent fine. Own submission to `rpc.magicblock.app/devnet` — the RPC that
// actually holds the eSPL/dUSDC accounts — mirrors `sendErOwner` and
// sidesteps the wallet's send path entirely.
export async function sendL1(
  owner: PublicKey,
  ixs: TransactionInstruction[],
  signTransactions: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = owner
  tx.recentBlockhash = (await baseConn.getLatestBlockhash()).blockhash
  const signed = await signTransactions(tx)
  const sig = await baseConn.sendRawTransaction(signed.serialize(), { skipPreflight: true })
  await confirmOnConn(baseConn, sig)
  return sig
}

// Poll `getSignatureStatuses` instead of `Connection.confirmTransaction` — found
// on-device (task-7 emulator verification) that `rpc.magicblock.app/devnet`'s
// websocket doesn't reliably deliver `signatureSubscribe` notifications
// (`Tried to call a JSON-RPC method 'signatureSubscribe' but the socket was
// not 'CONNECTING' or 'OPEN'`, retried forever), hanging `confirmTransaction`
// indefinitely even though the L1 transaction had already landed. Same root
// cause/fix as `tests/er/lib/env.ts`'s `confirmSignature` (documented there
// for the ER validator specifically) — this app hits it on the BASE
// connection too, so both `sendL1` and `sendErOwner` below poll instead.
export async function confirmOnConn(conn: Connection, sig: string, tries = 100, delayMs = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { value } = await conn.getSignatureStatuses([sig])
    const status = value[0]
    if (status) {
      if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`)
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`confirm timeout waiting for ${sig}`)
}

// --- ER send: owner-signed via MWA (ER blockhash — sign then send ourselves, mirrors Check 8). ---
export async function sendErOwner(
  conn: Connection,
  owner: PublicKey,
  ixs: TransactionInstruction[],
  signTransactions: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = owner
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  const signed = await signTransactions(tx)
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true })
  await confirmOnConn(conn, sig)
  return sig
}

export async function waitDelegated(
  pubkey: PublicKey,
  label: string,
  appendLog: (s: string) => void,
  tries = 60,
  delayMs = 500,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const info = await baseConn.getAccountInfo(pubkey, 'confirmed')
    if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
      appendLog(`${label} delegated`)
      return
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`timeout waiting for ${label} (${pubkey.toBase58()}) to be delegated`)
}

export interface OnboardCtx {
  owner: PublicKey
  config: PublicKey
  mint: PublicKey
  market: PublicKey
  userAccount: PublicKey
  position: PublicKey
  disclosureQueue: PublicKey
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

export interface Mwa {
  signAndSendTransaction: (tx: Transaction, minContextSlot: number) => Promise<string>
  /** Matches `@wallet-ui/react-native-web3js`'s real overload: an array in, an array out, ONE wallet prompt for the whole batch (`use-mobile-wallet.d.ts`). */
  signTransactions: <K extends Transaction | Transaction[]>(tx: K) => Promise<K>
  getConnection: (owner: PublicKey) => Promise<Connection>
}

/**
 * `credit_deposit` alone (ER, owner-signed, unsponsored — not on the /sponsor
 * whitelist and not meant to be: it moves the owner's own dUSDC into the
 * pool, not a rent/fee cost fee_payer should ever front). Task 10 replaces
 * this with the real Deposit screen; kept here as a standalone "Deposit
 * (dev)" action in the meantime. Idempotent: a no-op if `free_margin` is
 * already nonzero.
 */
export async function runDevDeposit(
  ctx: OnboardCtx,
  mwa: Pick<Mwa, 'signTransactions' | 'getConnection'>,
  appendLog: (s: string) => void,
  setState: (s: OnboardState) => void,
): Promise<void> {
  const { owner, userAccount, pool, poolLive, ownerAta, poolAta } = ctx
  const ownerTee = await mwa.getConnection(owner)
  const coreEr = dexxerCoreProgram(ownerTee, owner)
  const userAccountInfoEr = await ownerTee.getAccountInfo(userAccount, 'confirmed')
  const freeMargin = userAccountInfoEr ? readUserAccountFreeMargin(userAccountInfoEr.data) : 0n
  if (freeMargin !== 0n) {
    appendLog('credit_deposit: free_margin already nonzero, skipped')
    return
  }
  const ix = await coreEr.methods
    .creditDeposit(new BN(DEPOSIT.toString()))
    .accounts({ owner, userAccount, pool, poolLive, ownerAta, vaultAta: poolAta, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction()
  appendLog(`credit_deposit ${await sendErOwner(ownerTee, owner, [ix], mwa.signTransactions)}`)
  setState('Credited')
}

export interface BatchLeg {
  /** Log/progress label — also `BatchProgress.step` while this leg is in flight. */
  label: string
  ixs: TransactionInstruction[]
  conn: Connection
  feePayer: PublicKey
  /** The two L1 legs go through `/sponsor` (fee_payer co-signs, findings A.1/A.2); the ER leg and the session top-up don't — see file header, Finding A.3 (attempted, reverted). */
  sponsor: boolean
  /** `OnboardState` to report once this leg lands. */
  onLanded: OnboardState[]
}

/**
 * Inspects on-chain state (L1 + ER) and returns only the transaction legs
 * still needed — an already-onboarded wallet gets back an empty array (zero
 * wallet prompts). Fetches `ownerTee` unconditionally (one MWA
 * `signMessages` prompt) since even a "what's left" check needs it to read
 * ER-side permission/session state once delegation has happened.
 */
export async function collectBatchLegs(
  ctx: OnboardCtx,
  mwa: Pick<Mwa, 'getConnection'>,
  feePayerPubkey: PublicKey,
  appendLog: (s: string) => void,
): Promise<BatchLeg[]> {
  const {
    owner,
    config,
    mint,
    market,
    userAccount,
    position,
    disclosureQueue,
    faucetPda,
    mintAuth,
    ownerAta,
    session,
    exitSalt,
  } = ctx
  const core = dexxerCoreProgram(baseConn, owner)
  const legs: BatchLeg[] = []

  // --- L1a: [createAta?] + faucet_init + init_user (fee_payer fronts rent — Finding A.1) ---
  const l1a: TransactionInstruction[] = []
  const faucetInfo = await baseConn.getAccountInfo(faucetPda, 'confirmed')
  if (!faucetInfo) {
    const ataInfo = await baseConn.getAccountInfo(ownerAta, 'confirmed')
    if (!ataInfo) l1a.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerAta, owner, mint))
    l1a.push(
      await core.methods
        .faucetInit(new BN(DEPOSIT.toString()))
        .accounts({
          owner,
          payer: feePayerPubkey,
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
  const userAccountInfo = await baseConn.getAccountInfo(userAccount, 'confirmed')
  if (!userAccountInfo) {
    l1a.push(
      await core.methods
        .initUser(Array.from(exitSalt))
        .accounts({
          owner,
          payer: feePayerPubkey,
          config,
          market,
          userAccount,
          position,
          disclosureQueue,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    )
  } else {
    appendLog('init_user: exists, skipped')
  }
  if (l1a.length > 0)
    legs.push({
      label: 'faucet+init_user',
      ixs: l1a,
      conn: baseConn,
      feePayer: feePayerPubkey,
      sponsor: true,
      onLanded: ['Funded', 'Initialized'],
    })

  // --- L1b: delegateSpl (fee_payer fronts eSPL rent — Finding A.2) + delegate_user ---
  // `userAccountInfo` above is `null` both when the account doesn't exist
  // yet (about to be created by L1a) and — irrelevantly here — when it does
  // exist but isn't delegated; either way delegation is still pending.
  const delegated = userAccountInfo !== null && userAccountInfo.owner.equals(DELEGATION_PROGRAM_ID)
  const l1b: TransactionInstruction[] = []
  if (!delegated) {
    const delegateSplIxs = await delegateSpl(owner, mint, DEPOSIT, {
      payer: feePayerPubkey,
      validator: ER_VALIDATOR,
      initVaultIfMissing: false,
      idempotent: false,
    })
    l1b.push(...delegateSplIxs)
    const ut = delegationTriple(userAccount)
    const pt = delegationTriple(position)
    const dt = delegationTriple(disclosureQueue)
    l1b.push(
      await core.methods
        .delegateUser()
        .accounts({
          owner,
          config,
          market,
          bufferUserAccount: ut.buffer,
          delegationRecordUserAccount: ut.record,
          delegationMetadataUserAccount: ut.metadata,
          userAccount,
          bufferPosition: pt.buffer,
          delegationRecordPosition: pt.record,
          delegationMetadataPosition: pt.metadata,
          position,
          bufferDisclosureQueue: dt.buffer,
          delegationRecordDisclosureQueue: dt.record,
          delegationMetadataDisclosureQueue: dt.metadata,
          disclosureQueue,
          ownerProgram: DEXXER_CORE_PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    )
  } else {
    appendLog('delegate: already delegated, skipped')
  }
  if (l1b.length > 0)
    legs.push({
      label: 'delegate',
      ixs: l1b,
      conn: baseConn,
      feePayer: feePayerPubkey,
      sponsor: true,
      onLanded: ['Delegated'],
    })

  // --- Er: init_permissions + set_session (owner-paid, unsponsored) ---
  //
  // Finding A.3 was attempted as "sponsor this leg too" (feePayer =
  // fee_payer, sent on the TEE connection, folding the session top-up in as
  // a SystemProgram transfer the relayer whitelist cross-checks against
  // `set_session`'s argument — see `services/relayer/src/sponsor.ts`, which
  // still supports that shape). Verified directly against live devnet-tee
  // this fix round (`tests/er/devnet/zz-verify-sponsor-flow.ts`, a
  // non-MWA reproduction of this exact leg): the TEE rejects it outright —
  // `"InvalidAccountForFee"` — fee_payer is not a valid fee-paying account
  // for an ER transaction there, confirming the suspicion this file's
  // header comment flagged (the ER only clones a referenced non-delegated
  // account's *L1* balance for reads; it does not accept an arbitrary
  // non-delegated account as the ER-side fee payer for a tx it did not
  // itself originate). Reverted to owner-funded/owner-feePayer — the
  // pre-fix-round design, reconfirmed working end-to-end this run
  // (`tests/er/devnet/01-onboard-private.ts` PASS) — per the task-6 brief's
  // own contingency: "keep L1 rent sponsorship [...] report
  // DONE_WITH_CONCERNS naming the residual gap." The residual gap: the ER
  // leg (init_permissions/set_session) and the session top-up still cost
  // the owner a network fee + 0.01 SOL respectively — not sponsored.
  const ownerTee = await mwa.getConnection(owner)
  const coreEr = dexxerCoreProgram(ownerTee, owner)
  const userPermission = permissionPdaFromAccount(userAccount)
  const positionPermission = permissionPdaFromAccount(position)
  const dqPermission = permissionPdaFromAccount(disclosureQueue)
  const permAccounts = {
    owner,
    config,
    market,
    userAccount,
    position,
    disclosureQueue,
    userPermission,
    positionPermission,
    dqPermission,
    permissionProgram: PERMISSION_PROGRAM_ID,
    ephemeralVault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
  }
  const er: TransactionInstruction[] = []
  if (delegated) {
    // Already delegated (a previous run got this far) — real ER state exists, check it.
    const permInfo = await ownerTee.getAccountInfo(userPermission, 'confirmed')
    if (!permInfo || !permInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
      er.push(await coreEr.methods.initPermissions().accounts(permAccounts).instruction())
    } else {
      appendLog('init_permissions: exists, skipped')
    }
    const userAccountInfoEr = await ownerTee.getAccountInfo(userAccount, 'confirmed')
    const sessionKeyOnChain = userAccountInfoEr ? readUserAccountSessionKey(userAccountInfoEr.data) : PublicKey.default
    if (!sessionKeyOnChain.equals(session.publicKey)) {
      const expiry = Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECS
      er.push(
        await coreEr.methods
          .setSession(session.publicKey, new BN(expiry), SESSION_ACTIONS)
          .accounts(permAccounts)
          .instruction(),
      )
    } else {
      appendLog('set_session: already set to this device session key, skipped')
    }
  } else {
    // Not delegated yet — the ER validator has nothing to read for these
    // PDAs until L1b lands, so both steps are unconditionally needed once
    // it does (this same batch's L1b, in the normal fresh-onboarding case).
    er.push(await coreEr.methods.initPermissions().accounts(permAccounts).instruction())
    const expiry = Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECS
    er.push(
      await coreEr.methods
        .setSession(session.publicKey, new BN(expiry), SESSION_ACTIONS)
        .accounts(permAccounts)
        .instruction(),
    )
  }
  if (er.length > 0)
    legs.push({
      label: 'permissions+session',
      ixs: er,
      conn: ownerTee,
      feePayer: owner,
      sponsor: false,
      onLanded: ['Permissioned', 'SessionSet'],
    })

  // --- session fee top-up (L1, owner-funded, unsponsored) ---
  const sessionBalance = await baseConn.getBalance(session.publicKey, 'confirmed')
  if (sessionBalance < SESSION_LAMPORTS / 2) {
    legs.push({
      label: 'session top-up',
      ixs: [sessionTopUpIx(owner, session.publicKey)],
      conn: baseConn,
      feePayer: owner,
      sponsor: false,
      onLanded: [],
    })
  } else {
    appendLog('session lamports: already funded, skipped')
  }

  return legs
}

/**
 * Collects whatever's left (`collectBatchLegs`), signs every leg's
 * transaction in ONE `mwa.signTransactions([...])` call, then submits each
 * sequentially — L1a before L1b (L1b's `delegate_user` needs L1a's
 * `init_user` to have landed), then the ER leg, then the session top-up.
 * The two L1 legs go through `/sponsor` first (fee_payer co-signs —
 * findings A.1/A.2); the ER leg and the session top-up don't (finding A.3,
 * attempted and reverted — see file header). `onProgress` reports
 * `Collecting -> Signing -> Submitting(i/n) -> Done | Failed(step)` for the
 * UI; `setState` still drives the coarse `OnboardState` the screen's
 * progress bar already understands (each leg's `onLanded` states, in
 * order).
 *
 * Finding D: blockhashes are fetched right here, immediately before
 * `signTransactions` — never earlier. Between legs, a leg whose blockhash
 * has since expired (confirming an earlier leg can take up to ~15s) is
 * rebuilt with a fresh blockhash and re-signed ALONE (one extra prompt)
 * rather than failing the whole batch.
 */
export async function runBatchedOnboarding(
  ctx: OnboardCtx,
  mwa: Mwa,
  appendLog: (s: string) => void,
  setState: (s: OnboardState) => void,
  onProgress: (p: BatchProgress) => void,
): Promise<void> {
  onProgress({ phase: 'Collecting', step: null, i: 0, n: 0 })
  const configInfo = await baseConn.getAccountInfo(ctx.config, 'confirmed')
  if (!configInfo) throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
  const feePayerPubkey = readConfigFeePayer(configInfo.data)

  const legs = await collectBatchLegs(ctx, mwa, feePayerPubkey, appendLog)
  if (legs.length === 0) {
    appendLog('onboarding: nothing left to do')
    onProgress({ phase: 'Done', step: null, i: 0, n: 0 })
    return
  }

  const txs = await Promise.all(
    legs.map(async (leg) => {
      const tx = new Transaction().add(...leg.ixs)
      tx.feePayer = leg.feePayer
      tx.recentBlockhash = (await leg.conn.getLatestBlockhash()).blockhash
      return tx
    }),
  )

  onProgress({ phase: 'Signing', step: null, i: 0, n: legs.length })
  let signed: Transaction[]
  try {
    signed = await mwa.signTransactions(txs)
  } catch (e) {
    onProgress({ phase: 'Failed', step: 'signing', i: 0, n: legs.length })
    throw e
  }

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    onProgress({ phase: 'Submitting', step: leg.label, i: i + 1, n: legs.length })
    try {
      let toSend = signed[i]

      // Finding D: re-validate this leg's blockhash right before it's sent —
      // an earlier leg's confirmation wait (up to ~15s) may have let this
      // one's expire.
      const bh = toSend.recentBlockhash
      const stillValid = bh ? (await leg.conn.isBlockhashValid(bh, { commitment: 'confirmed' })).value : false
      if (!stillValid) {
        appendLog(`re-sign leg ${i + 1} (blockhash expired)`)
        const fresh = new Transaction().add(...leg.ixs)
        fresh.feePayer = leg.feePayer
        fresh.recentBlockhash = (await leg.conn.getLatestBlockhash()).blockhash
        const [reSigned] = await mwa.signTransactions([fresh])
        toSend = reSigned
      }

      if (leg.sponsor) {
        try {
          toSend = await sponsorTx(toSend)
        } catch (e) {
          const msg = e instanceof SponsorError ? `sponsor rejected (${e.status}): ${e.message}` : errText(e)
          throw new Error(`${leg.label}: ${msg}`)
        }
      }
      const sig = await leg.conn.sendRawTransaction(toSend.serialize(), { skipPreflight: true })
      await confirmOnConn(leg.conn, sig)
      appendLog(`${leg.label} ${sig}`)
      // `delegate_user`'s three accounts don't appear as delegated on L1
      // immediately after the tx confirms — poll BEFORE the next leg (the ER
      // leg reads these same PDAs on the ER validator, which only clones a
      // delegated account after L1 shows it delegated), mirroring the
      // legacy flow's ordering.
      if (leg.label === 'delegate') {
        await waitDelegated(ctx.userAccount, 'UserAccount', appendLog)
        await waitDelegated(ctx.position, 'Position', appendLog)
        await waitDelegated(ctx.disclosureQueue, 'DisclosureQueue', appendLog)
      }
    } catch (e) {
      onProgress({ phase: 'Failed', step: leg.label, i: i + 1, n: legs.length })
      throw e
    }
    for (const s of leg.onLanded) setState(s)
  }

  onProgress({ phase: 'Done', step: null, i: legs.length, n: legs.length })
}
