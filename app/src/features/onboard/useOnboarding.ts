// app/src/features/onboard/useOnboarding.ts
//
// State machine driving the onboarding screen:
//   NotOnboarded -> Funded -> Initialized -> Delegated -> Credited ->
//   Permissioned -> SessionSet
//
// `advance()` runs `runBatchedOnboarding` (`batchOnboarding.ts`) —
// faucet_init (+ATA-create if missing) + init_user (or
// init_user_reuse_queue for a returning owner) + delegateSpl +
// delegate_user collected into three fee_payer-sponsored L1 transactions, and
// init_permissions + set_session collected into one owner-paid ER
// transaction, all signed in ONE `mwa.signTransactions([...])` call
// (week-5 Task 6: no more session-lamports top-up leg — see
// `batchOnboarding.ts`'s file header). `credit_deposit` (crediting
// `free_margin`) is deliberately NOT part of the batch — see
// `batchOnboarding.ts`'s `runDevDeposit` and the real Deposit screen
// (`AccountScreen.tsx`).
//
// This file is just the hook wrapper: React state and `buildCtx`. The batch
// pipeline itself (`collectBatchLegs`/`runBatchedOnboarding`/`BatchLeg`) and
// the shared send/confirm primitives
// (`sendL1`/`sendErOwner`/`confirmOnConn`/`waitDelegated`) live in
// `batchOnboarding.ts`. The original one-prompt-per-step flow this file used
// to keep behind a `LEGACY_ONBOARDING` flag was removed in week 5 — it
// pre-dated the sponsored/fee_payer-paid account shapes (owner-paid ATA/
// `delegate_user`, an L1 session top-up) and would no longer build against
// the current program/relayer whitelist.
import { useCallback, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { toPublicKey } from '@/src/spikes/mwa'
import { baseConn } from '@/src/lib/solana'
import { useTeeConnection } from '@/src/lib/er'
import { readConfigDusdcMint } from '@/src/lib/codecs'
import { pdas } from '@/src/lib/pdas'
import { getOrCreateExitSalt, getOrCreateSessionKeypair, getSessionKeypair } from '@/src/lib/session'
import { ensureAuthorized, useMwaSigning } from '@/src/lib/mwaAuth'
import {
  IDLE_BATCH_PROGRESS,
  runBatchedOnboarding,
  runDevDeposit,
  type BatchProgress,
  type Mwa,
  type OnboardCtx,
  type OnboardState,
  errText,
} from './batchOnboarding'

export type { BatchPhase, BatchProgress, OnboardState } from './batchOnboarding'

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
  /** `Collecting -> Signing -> Submitting(i/n) -> Done | Failed(step)` — see `batchOnboarding.ts`'s `BatchProgress`. */
  batchProgress: BatchProgress
  connectWallet: () => Promise<void>
  refresh: () => Promise<void>
  /** Runs onboarding forward from wherever it currently stands, all the way to `SessionSet` (or the first failure). */
  advance: () => Promise<void>
  /** Task 6: standalone "Deposit (dev)" action — `credit_deposit` alone, not part of the batch. See `batchOnboarding.ts`'s `runDevDeposit`. */
  runDeposit: () => Promise<void>
}

export function useOnboarding(): UseOnboarding {
  const { account, connect, identity, store, signAndSendTransaction } = useMobileWallet()
  const { signTransactions } = useMwaSigning()
  const { getConnection } = useTeeConnection()
  const [state, setState] = useState<OnboardState>('Disconnected')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sessionPubkey, setSessionPubkey] = useState<PublicKey | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchProgress>(IDLE_BATCH_PROGRESS)

  const owner = account ? toPublicKey(account.address) : null
  // `signTransactions` here is `useMwaSigning()`'s retry-wrapped version, not
  // the raw hook's — see `mwaAuth.ts`'s "Phantom reauthorize bug" section.
  const mwa: Mwa = { signAndSendTransaction, signTransactions, getConnection }

  const appendLog = useCallback((s: string) => setLog((prev) => [...prev, s]), [])

  // Week 5, Task 6: identity-aware auth — `ensureAuthorized` raw-deauthorizes
  // a stored token issued under a DIFFERENT app identity before letting
  // `connect()` authorize fresh, and persists the resulting token's identity
  // hash for next time. See `mwaAuth.ts`'s file header for why the library's
  // own `connect()` doesn't already do this.
  const connectWallet = useCallback(async () => {
    setError(null)
    try {
      await ensureAuthorized(identity, connect, store)
    } catch (e) {
      setError(errText(e))
    }
  }, [connect, identity, store])

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
      await runBatchedOnboarding(ctx, mwa, appendLog, setState, setBatchProgress)
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
