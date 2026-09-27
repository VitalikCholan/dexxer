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
// `free_margin`) is deliberately NOT part of the batch — it is the real
// Deposit screen's job (`AccountScreen.tsx`; the standalone "Deposit (dev)"
// action was removed in week 6).
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
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { toPublicKey } from '@/src/lib/mwa/accounts'
import { baseConn } from '@/src/lib/solana'
import { useTeeConnection } from '@/src/lib/er'
import { useRelayerSession } from '@/src/lib/relayerAuth'
import { readConfigDusdcMint } from '@/src/lib/codecs'
import { pdas } from '@/src/lib/pdas'
import { getOrCreateExitSalt, getOrCreateSessionKeypair, getSessionKeypair } from '@/src/lib/session'
import { ensureAuthorized } from '@/src/lib/mwa/session'
import { useMwaSigning } from '@/src/lib/mwa/useMwaSigning'
import {
  IDLE_BATCH_PROGRESS,
  runBatchedOnboarding,
  type BatchProgress,
  type Mwa,
  type OnboardCtx,
  type OnboardState,
  errText,
} from './batchOnboarding'
import { l1KeysFor, l1ProgressFrom, readL1Snapshot, type L1Snapshot } from './onboardState'

export type { BatchPhase, BatchProgress, OnboardState } from './batchOnboarding'

/**
 * One base-layer read of everything onboarding decides from — the mount-time
 * gate (`l1ProgressFrom`) and the batch (`runBatchedOnboarding`) share it,
 * where they used to issue their own sequential `getAccountInfo` calls for
 * the same accounts. Two round trips: `Config` first (the owner-keyed
 * accounts derive from its `dusdc_mint`), then the five-account snapshot.
 * No ER auth prompt — L1 only, safe on mount/owner change.
 */
async function readOwnerL1(owner: PublicKey): Promise<{ snap: L1Snapshot; mint: PublicKey } | { error: string }> {
  const configInfo = await baseConn.getAccountInfo(pdas.config(), 'confirmed')
  if (!configInfo) return { error: 'Config PDA not found — protocol not bootstrapped on this devnet deployment' }
  const mint = readConfigDusdcMint(configInfo.data)
  const snap = await readL1Snapshot(baseConn, l1KeysFor(owner, mint))
  return { snap, mint }
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
}

export function useOnboarding(): UseOnboarding {
  const { account, connect, identity, store, signAndSendTransaction } = useMobileWallet()
  const { signTransactions } = useMwaSigning()
  const { getConnection } = useTeeConnection()
  const { ensureRelayerSession } = useRelayerSession()
  const [state, setState] = useState<OnboardState>('Disconnected')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sessionPubkey, setSessionPubkey] = useState<PublicKey | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchProgress>(IDLE_BATCH_PROGRESS)

  const owner = account ? toPublicKey(account.address) : null
  // `signTransactions` here is `useMwaSigning()`'s retry-wrapped version, not
  // the raw hook's — see `mwa/errors.ts`'s "Phantom reauthorize bug" section.
  const mwa: Mwa = { signAndSendTransaction, signTransactions, getConnection, ensureRelayerSession }

  const appendLog = useCallback((s: string) => setLog((prev) => [...prev, s]), [])

  // Week 5, Task 6: identity-aware auth — `ensureAuthorized` raw-deauthorizes
  // a stored token issued under a DIFFERENT app identity before letting
  // `connect()` authorize fresh, and persists the resulting token's identity
  // hash for next time. See `mwa/session.ts`'s file header for why the library's
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
      const result = await readOwnerL1(owner)
      if ('error' in result) {
        setError(result.error)
        return
      }
      setState(l1ProgressFrom(result.snap))
      const existing = await getSessionKeypair(owner)
      setSessionPubkey(existing?.publicKey ?? null)
    } catch (e) {
      setError(errText(e))
    }
  }, [owner])

  const buildCtx = useCallback(async (o: PublicKey, mint: PublicKey): Promise<OnboardCtx> => {
    const config = pdas.config()
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
      const l1 = await readOwnerL1(owner)
      if ('error' in l1) throw new Error(l1.error)
      const ctx = await buildCtx(owner, l1.mint)
      await runBatchedOnboarding(ctx, mwa, appendLog, setState, setBatchProgress, l1.snap)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    owner,
    connectWallet,
    buildCtx,
    appendLog,
    signAndSendTransaction,
    signTransactions,
    getConnection,
    ensureRelayerSession,
  ])

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
  }
}
