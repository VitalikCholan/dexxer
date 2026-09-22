// app/src/features/onboard/useOnboarding.ts
//
// State machine driving the onboarding screen:
//   NotOnboarded -> Funded -> Initialized -> Delegated -> Credited ->
//   Permissioned -> SessionSet
//
// Task 6 (week 4): `advance()` now runs `runBatchedOnboarding` — faucet_init
// (+ATA-create if missing) + init_user + delegateSpl + delegate_user +
// init_permissions + set_session (+ the session fee top-up) collected into
// up to four transactions and signed in ONE `mwa.signTransactions([...])`
// call, with the two L1 transactions sponsored by the relayer's
// `POST /sponsor` (`services/relayer/src/sponsor.ts`) so the owner never
// pays a network fee for them. `credit_deposit` (crediting `free_margin`)
// is deliberately NOT part of the batch — see `runDevDeposit` below and
// Task 10's real Deposit screen.
//
// The original step-by-step flow (`runFlow`, one MWA prompt per
// instruction/small group) is kept intact behind `LEGACY_ONBOARDING` below
// for quick rollback/debugging — set it to `true` to go back to it.
// Mirrors `tests/er/devnet/01-onboard-private.ts` / `tests/er/lib/trader.ts`
// (`onboardTrader`) step-for-step — same instructions, same accounts, same
// order — with every owner-signed step routed through Mobile Wallet Adapter
// instead of a local `Keypair`.
//
// L1 sends: MWA `signTransactions` (sign-only), then this app submits on
// `baseConn` itself — the reference fakewallet's own send path
// (`SendTransactionsUseCase`) rejects multi-ix txs like `delegateSpl` with
// "payloads invalid for signing" (found task-7 emulator verification).
// ER sends: same pattern against the owner's TEE connection, polling
// `getSignatureStatuses` instead of `Connection.confirmTransaction` (the ER
// validator's confirmation websocket is unreliable — see
// `tests/er/lib/env.ts`'s `confirmSignature` for the root cause).
//
// Every step checks on-chain state first and skips if already done
// (idempotent, like `onboardTrader`), so `advance()` (the screen's single
// "Continue" action) is safe to call again after a partial failure — a
// re-tap resumes from wherever onboarding actually broke, and running it
// again on an already-onboarded wallet is a fast no-op all the way through
// (in the batched flow: zero transactions to sign, so zero wallet prompts).
import { useCallback, useState } from 'react'
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  type Keypair,
} from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { toPublicKey } from '@/src/spikes/mwa'
import { baseConn, ER_VALIDATOR } from '@/src/lib/solana'
import { useTeeConnection } from '@/src/lib/er'
import {
  dexxerCoreProgram,
  readConfigDusdcMint,
  readConfigFeePayer,
  readUserAccountFreeMargin,
  readUserAccountSessionKey,
  DEXXER_CORE_PROGRAM_ID,
} from '@/src/lib/program'
import { delegationTriple, pdas } from '@/src/lib/pdas'
import { sponsorTx, SponsorError } from '@/src/lib/sponsor'
import {
  getOrCreateExitSalt,
  getOrCreateSessionKeypair,
  getSessionKeypair,
  sessionTopUpIx,
  SESSION_LAMPORTS,
} from '@/src/lib/session'

export type OnboardState =
  'Disconnected' | 'NotOnboarded' | 'Funded' | 'Initialized' | 'Delegated' | 'Credited' | 'Permissioned' | 'SessionSet'

/** Set `true` to fall back to the original one-prompt-per-step flow (`runFlow`) — see file header. */
const LEGACY_ONBOARDING = false

export type BatchPhase = 'Idle' | 'Collecting' | 'Signing' | 'Submitting' | 'Done' | 'Failed'

export interface BatchProgress {
  phase: BatchPhase
  /** Which leg is in flight/failed — 'faucet+init_user' | 'delegate' | 'permissions+session' | 'session top-up'. */
  step: string | null
  i: number
  n: number
}

const IDLE_BATCH_PROGRESS: BatchProgress = { phase: 'Idle', step: null, i: 0, n: 0 }

/** Faucet/deposit amount — 1,000 dUSDC (6 decimals), same as `tests/er/devnet/01-onboard-private.ts`. */
const DEPOSIT = 1_000_000_000n
const SESSION_EXPIRY_SECS = 3600
const SESSION_ACTIONS = 20

function errText(e: unknown): string {
  const err = e as { message?: string }
  return err?.message ?? String(e)
}

// L1 send: sign via MWA (sign-only), then submit ourselves on `baseConn`.
// We deliberately do NOT use the wallet's `signAndSendTransactions`: the
// reference fakewallet's `SendTransactionsUseCase` throws
// `InvalidTransactionsException` (JSON-RPC code -2, "payloads invalid for
// signing") on multi-instruction transactions such as `delegateSpl` (3 eSPL
// ixs) — reproduced on-device 21.09, while single-ix `faucet_init`/`init_user`
// sent fine. The transaction itself is valid (owner-only signer, ~590 B). Own
// submission to `rpc.magicblock.app/devnet` — the RPC that actually holds the
// eSPL/dUSDC accounts — mirrors `sendErOwner` and sidesteps the wallet's send
// path entirely. A fresh blockhash is fetched immediately before signing to
// keep the MWA round-trip inside its validity window.
async function sendL1(
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
async function confirmOnConn(conn: Connection, sig: string, tries = 100, delayMs = 150): Promise<void> {
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
async function sendErOwner(
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

async function waitDelegated(
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

interface OnboardCtx {
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

interface Mwa {
  signAndSendTransaction: (tx: Transaction, minContextSlot: number) => Promise<string>
  /** Matches `@wallet-ui/react-native-web3js`'s real overload: an array in, an array out, ONE wallet prompt for the whole batch (`use-mobile-wallet.d.ts`). */
  signTransactions: <K extends Transaction | Transaction[]>(tx: K) => Promise<K>
  getConnection: (owner: PublicKey) => Promise<Connection>
}

/** Runs the whole remaining onboarding pipeline from `ctx`'s current on-chain state through `SessionSet`. */
async function runFlow(
  ctx: OnboardCtx,
  mwa: Mwa,
  appendLog: (s: string) => void,
  setState: (s: OnboardState) => void,
): Promise<void> {
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
    pool,
    poolLive,
    poolAta,
    ownerAta,
    session,
    exitSalt,
  } = ctx
  const core = dexxerCoreProgram(baseConn, owner)

  // === faucet (dUSDC) ===
  const faucetInfo = await baseConn.getAccountInfo(faucetPda, 'confirmed')
  if (!faucetInfo) {
    const ixs: TransactionInstruction[] = []
    const ataInfo = await baseConn.getAccountInfo(ownerAta, 'confirmed')
    if (!ataInfo) ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerAta, owner, mint))
    ixs.push(
      await core.methods
        .faucetInit(new BN(DEPOSIT.toString()))
        .accounts({
          owner,
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
    appendLog(`faucet_init ${await sendL1(owner, ixs, mwa.signTransactions)}`)
  } else {
    appendLog('faucet_init: exists, skipped')
  }
  setState('Funded')

  // === init_user ===
  const userAccountInfo = await baseConn.getAccountInfo(userAccount, 'confirmed')
  if (!userAccountInfo) {
    const ix = await core.methods
      .initUser(Array.from(exitSalt))
      .accounts({
        owner,
        config,
        market,
        userAccount,
        position,
        disclosureQueue,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    appendLog(`init_user ${await sendL1(owner, [ix], mwa.signTransactions)}`)
  } else {
    appendLog('init_user: exists, skipped')
  }
  setState('Initialized')

  // === delegateSpl (deposit) + delegate_user ===
  const userAccountInfoNow = await baseConn.getAccountInfo(userAccount, 'confirmed')
  const alreadyDelegated = userAccountInfoNow !== null && userAccountInfoNow.owner.equals(DELEGATION_PROGRAM_ID)
  if (!alreadyDelegated) {
    const delegateSplIxs = await delegateSpl(owner, mint, DEPOSIT, {
      validator: ER_VALIDATOR,
      initVaultIfMissing: false,
      idempotent: false,
    })
    appendLog(`delegateSpl ${await sendL1(owner, delegateSplIxs, mwa.signTransactions)}`)

    const ut = delegationTriple(userAccount)
    const pt = delegationTriple(position)
    const dt = delegationTriple(disclosureQueue)
    const delegateUserIx = await core.methods
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
      .instruction()
    appendLog(`delegate_user ${await sendL1(owner, [delegateUserIx], mwa.signTransactions)}`)

    await waitDelegated(userAccount, 'UserAccount', appendLog)
    await waitDelegated(position, 'Position', appendLog)
    await waitDelegated(disclosureQueue, 'DisclosureQueue', appendLog)
  } else {
    appendLog('delegate: already delegated, skipped')
  }
  setState('Delegated')

  // From here on, every step reads/writes the ER — one MWA `signMessages`
  // prompt to mint the owner's TEE auth token (cached after, see er.ts).
  const ownerTee = await mwa.getConnection(owner)
  const coreEr = dexxerCoreProgram(ownerTee, owner)

  // === credit_deposit (ER, owner token) ===
  const userAccountInfoEr = await ownerTee.getAccountInfo(userAccount, 'confirmed')
  const freeMargin = userAccountInfoEr ? readUserAccountFreeMargin(userAccountInfoEr.data) : 0n
  if (freeMargin === 0n) {
    const ix = await coreEr.methods
      .creditDeposit(new BN(DEPOSIT.toString()))
      .accounts({ owner, userAccount, pool, poolLive, ownerAta, vaultAta: poolAta, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction()
    appendLog(`credit_deposit ${await sendErOwner(ownerTee, owner, [ix], mwa.signTransactions)}`)
  } else {
    appendLog('credit_deposit: free_margin already nonzero, skipped')
  }
  setState('Credited')

  // === init_permissions (ER, private, members=[owner, crank] — session not set yet) ===
  const userPermission = permissionPdaFromAccount(userAccount)
  const positionPermission = permissionPdaFromAccount(position)
  const dqPermission = permissionPdaFromAccount(disclosureQueue)
  const permInfo = await ownerTee.getAccountInfo(userPermission, 'confirmed')
  if (!permInfo || !permInfo.owner.equals(PERMISSION_PROGRAM_ID)) {
    const ix = await coreEr.methods
      .initPermissions()
      .accounts({
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
      })
      .instruction()
    appendLog(`init_permissions ${await sendErOwner(ownerTee, owner, [ix], mwa.signTransactions)}`)
  } else {
    appendLog('init_permissions: exists, skipped')
  }
  setState('Permissioned')

  // === set_session (ER, rebuilds members=[owner, session, crank]) ===
  const userAccountInfoAfterPerm = await ownerTee.getAccountInfo(userAccount, 'confirmed')
  const sessionKeyOnChain = userAccountInfoAfterPerm
    ? readUserAccountSessionKey(userAccountInfoAfterPerm.data)
    : PublicKey.default
  if (!sessionKeyOnChain.equals(session.publicKey)) {
    const expiry = Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECS
    const ix = await coreEr.methods
      .setSession(session.publicKey, new BN(expiry), SESSION_ACTIONS)
      .accounts({
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
      })
      .instruction()
    appendLog(
      `set_session ${await sendErOwner(ownerTee, owner, [ix], mwa.signTransactions)} expiry=${expiry} actions=${SESSION_ACTIONS}`,
    )
  } else {
    appendLog('set_session: already set to this device session key, skipped')
  }

  // === fund session's own ER fee balance (base-layer transfer — see session.ts header comment) ===
  const sessionBalance = await baseConn.getBalance(session.publicKey, 'confirmed')
  if (sessionBalance < SESSION_LAMPORTS / 2) {
    appendLog(`fund session ${await sendL1(owner, [sessionTopUpIx(owner, session.publicKey)], mwa.signTransactions)}`)
  } else {
    appendLog('session lamports: already funded, skipped')
  }
  setState('SessionSet')
}

/**
 * `credit_deposit` alone (ER, owner-signed, unsponsored — not on the /sponsor
 * whitelist and not meant to be: it moves the owner's own dUSDC into the
 * pool, not a rent/fee cost fee_payer should ever front). Extracted out of
 * the legacy `runFlow` above so the batched flow (which does NOT run this
 * automatically — see file header) can still offer it as a standalone
 * "Deposit (dev)" action; Task 10 replaces this with the real Deposit
 * screen. Idempotent: a no-op if `free_margin` is already nonzero.
 */
async function runDevDeposit(
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

// --- Task 6 (week 4): batched onboarding — one signTransactions([...])
// prompt for everything owner-signed L1/ER through SessionSet, with the two
// L1 transactions sponsored by the relayer (fee_payer co-signs via
// POST /sponsor — see app/src/lib/sponsor.ts and
// services/relayer/src/sponsor.ts). See file header for the full design.

interface BatchLeg {
  /** Log/progress label — also `BatchProgress.step` while this leg is in flight. */
  label: string
  ixs: TransactionInstruction[]
  conn: Connection
  feePayer: PublicKey
  /** L1 legs go through `/sponsor` (fee_payer co-signs); the ER leg and the session top-up don't — see file header. */
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
async function collectBatchLegs(
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

  // --- L1a: [createAta?] + faucet_init + init_user ---
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

  // --- L1b: delegateSpl + delegate_user ---
  // `userAccountInfo` above is `null` both when the account doesn't exist
  // yet (about to be created by L1a) and — irrelevantly here — when it does
  // exist but isn't delegated; either way delegation is still pending.
  const delegated = userAccountInfo !== null && userAccountInfo.owner.equals(DELEGATION_PROGRAM_ID)
  const l1b: TransactionInstruction[] = []
  if (!delegated) {
    const delegateSplIxs = await delegateSpl(owner, mint, DEPOSIT, {
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

  // --- Er: init_permissions + set_session (owner-paid, unsponsored — same as today) ---
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

  // --- session fee top-up (L1, owner-funded, unsponsored — see session.ts header comment) ---
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
 * sequentially — L1 legs through `/sponsor` first (L1a before L1b: L1b's
 * `delegate_user` needs L1a's `init_user` to have landed), then the ER leg,
 * then the session top-up. `onProgress` reports `Collecting -> Signing ->
 * Submitting(i/n) -> Done | Failed(step)` for the UI; `setState` still
 * drives the coarse `OnboardState` the screen's progress bar already
 * understands (each leg's `onLanded` states, in order).
 */
async function runBatchedOnboarding(
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

/** Cheap, L1-only progress check — no ER auth prompt, safe to call on mount/owner change. */
async function checkL1Progress(
  owner: PublicKey,
): Promise<{ state: OnboardState; mint: PublicKey } | { error: string }> {
  const config = pdas.config()
  const configInfo = await baseConn.getAccountInfo(config, 'confirmed')
  if (!configInfo) return { error: 'Config PDA not found — protocol not bootstrapped on this devnet deployment' }
  const mint = readConfigDusdcMint(configInfo.data)

  const faucetInfo = await baseConn.getAccountInfo(pdas.faucet(owner), 'confirmed')
  if (!faucetInfo) return { state: 'NotOnboarded', mint }

  const userAccount = pdas.userAccount(owner)
  const userAccountInfo = await baseConn.getAccountInfo(userAccount, 'confirmed')
  if (!userAccountInfo) return { state: 'Funded', mint }
  if (userAccountInfo.owner.equals(DELEGATION_PROGRAM_ID)) return { state: 'Delegated', mint }
  return { state: 'Initialized', mint }
}

export interface UseOnboarding {
  owner: PublicKey | null
  session: PublicKey | null
  state: OnboardState
  busy: boolean
  log: string[]
  error: string | null
  /** Task 6: `Collecting -> Signing -> Submitting(i/n) -> Done | Failed(step)` — only meaningful while `LEGACY_ONBOARDING` is false. */
  batchProgress: BatchProgress
  connectWallet: () => Promise<void>
  refresh: () => Promise<void>
  /** Runs onboarding forward from wherever it currently stands, all the way to `SessionSet` (or the first failure). */
  advance: () => Promise<void>
  /** Task 6: standalone "Deposit (dev)" action — `credit_deposit` alone, not part of the batch. See `runDevDeposit`. */
  runDeposit: () => Promise<void>
}

export function useOnboarding(): UseOnboarding {
  const { account, connect, signAndSendTransaction, signTransactions } = useMobileWallet()
  const { getConnection } = useTeeConnection()
  const [state, setState] = useState<OnboardState>('Disconnected')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sessionPubkey, setSessionPubkey] = useState<PublicKey | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchProgress>(IDLE_BATCH_PROGRESS)

  const owner = account ? toPublicKey(account.address) : null
  const mwa: Mwa = { signAndSendTransaction, signTransactions, getConnection }

  const appendLog = useCallback((s: string) => setLog((prev) => [...prev, s]), [])

  const connectWallet = useCallback(async () => {
    setError(null)
    try {
      await connect()
    } catch (e) {
      setError(errText(e))
    }
  }, [connect])

  const refresh = useCallback(async () => {
    if (!owner) {
      setState('Disconnected')
      return
    }
    try {
      const result = await checkL1Progress(owner)
      if ('error' in result) {
        setError(result.error)
        return
      }
      setState(result.state)
      const existing = await getSessionKeypair(owner)
      setSessionPubkey(existing?.publicKey ?? null)
    } catch (e) {
      setError(errText(e))
    }
  }, [owner])

  const buildCtx = useCallback(async (o: PublicKey): Promise<OnboardCtx> => {
    const config = pdas.config()
    const configInfo = await baseConn.getAccountInfo(config, 'confirmed')
    if (!configInfo) throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
    const mint = readConfigDusdcMint(configInfo.data)
    const market = pdas.market()
    const userAccount = pdas.userAccount(o)
    const position = pdas.position(o, market)
    const disclosureQueue = pdas.disclosureQueue(o)
    const faucetPda = pdas.faucet(o)
    const mintAuth = pdas.mintAuth()
    const pool = pdas.pool(mint)
    const poolLive = pdas.poolLive(mint)
    const poolAta = pdas.poolAta(mint)
    const ownerAta = getAssociatedTokenAddressSync(mint, o)
    const session = await getOrCreateSessionKeypair(o)
    setSessionPubkey(session.publicKey)
    const exitSalt = await getOrCreateExitSalt(o)
    return {
      owner: o,
      config,
      mint,
      market,
      userAccount,
      position,
      disclosureQueue,
      faucetPda,
      mintAuth,
      pool,
      poolLive,
      poolAta,
      ownerAta,
      session,
      exitSalt,
    }
  }, [])

  const advance = useCallback(async () => {
    if (!owner) {
      await connectWallet()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ctx = await buildCtx(owner)
      if (LEGACY_ONBOARDING) {
        await runFlow(ctx, mwa, appendLog, setState)
      } else {
        await runBatchedOnboarding(ctx, mwa, appendLog, setState, setBatchProgress)
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, connectWallet, buildCtx, appendLog, signAndSendTransaction, signTransactions, getConnection])

  const runDeposit = useCallback(async () => {
    if (!owner) return
    setBusy(true)
    setError(null)
    try {
      const ctx = await buildCtx(owner)
      await runDevDeposit(ctx, mwa, appendLog, setState)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, buildCtx, appendLog, signTransactions, getConnection])

  return {
    owner,
    session: sessionPubkey,
    state,
    busy,
    log,
    error,
    batchProgress,
    connectWallet,
    refresh,
    advance,
    runDeposit,
  }
}
