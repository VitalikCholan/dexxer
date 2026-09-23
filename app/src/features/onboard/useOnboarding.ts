// app/src/features/onboard/useOnboarding.ts
//
// State machine driving the onboarding screen:
//   NotOnboarded -> Funded -> Initialized -> Delegated -> Credited ->
//   Permissioned -> SessionSet
//
// Task 6 (week 4): `advance()` runs `runBatchedOnboarding`
// (`batchOnboarding.ts`) — faucet_init (+ATA-create if missing) + init_user
// + delegateSpl + delegate_user collected into up to two sponsored L1
// transactions, and init_permissions + set_session (+ the session fee
// top-up) collected into one sponsored ER transaction, all signed in ONE
// `mwa.signTransactions([...])` call. `credit_deposit` (crediting
// `free_margin`) is deliberately NOT part of the batch — see
// `batchOnboarding.ts`'s `runDevDeposit` and Task 10's real Deposit screen.
//
// The original step-by-step flow (`runFlow` below, one MWA prompt per
// instruction/small group) is kept intact behind `LEGACY_ONBOARDING` for
// quick rollback/debugging — set it to `true` to go back to it. Mirrors
// `tests/er/devnet/01-onboard-private.ts` / `tests/er/lib/trader.ts`
// (`onboardTrader`) step-for-step — same instructions, same accounts, same
// order — with every owner-signed step routed through Mobile Wallet Adapter
// instead of a local `Keypair`.
//
// This file (fix round 1, finding E) is now just the hook wrapper: React
// state, `buildCtx`, and `runFlow`. The batch pipeline itself
// (`collectBatchLegs`/`runBatchedOnboarding`/`BatchLeg`) and the shared
// send/confirm primitives (`sendL1`/`sendErOwner`/`confirmOnConn`/
// `waitDelegated`) live in `batchOnboarding.ts`.
import { useCallback, useState } from 'react'
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { BN } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { toPublicKey } from '@/src/spikes/mwa'
import { baseConn, ER_VALIDATOR } from '@/src/lib/solana'
import { useTeeConnection } from '@/src/lib/er'
import {
  dexxerCoreProgram,
  readConfigDusdcMint,
  readUserAccountFreeMargin,
  readUserAccountSessionKey,
  DEXXER_CORE_PROGRAM_ID,
} from '@/src/lib/program'
import { delegationTriple, pdas } from '@/src/lib/pdas'
import {
  getOrCreateExitSalt,
  getOrCreateSessionKeypair,
  getSessionKeypair,
  sessionTopUpIx,
  SESSION_LAMPORTS,
} from '@/src/lib/session'
import {
  DEPOSIT,
  errText,
  IDLE_BATCH_PROGRESS,
  runBatchedOnboarding,
  runDevDeposit,
  sendErOwner,
  sendL1,
  SESSION_ACTIONS,
  SESSION_EXPIRY_SECS,
  waitDelegated,
  type BatchProgress,
  type Mwa,
  type OnboardCtx,
  type OnboardState,
} from './batchOnboarding'

export type { BatchPhase, BatchProgress, OnboardState } from './batchOnboarding'

/** Set `true` to fall back to the original one-prompt-per-step flow (`runFlow`) — see file header. */
const LEGACY_ONBOARDING = false

/** Runs the whole remaining onboarding pipeline from `ctx`'s current on-chain state through `SessionSet`. Legacy path — see `LEGACY_ONBOARDING`. */
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
          payer: owner,
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
        payer: owner,
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
  /** Task 6: standalone "Deposit (dev)" action — `credit_deposit` alone, not part of the batch. See `batchOnboarding.ts`'s `runDevDeposit`. */
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
