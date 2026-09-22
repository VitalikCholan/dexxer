// app/src/features/onboard/useOnboarding.ts
//
// State machine driving Task 7's onboarding screen:
//   NotOnboarded -> Funded -> Initialized -> Delegated -> Credited ->
//   Permissioned -> SessionSet
//
// Mirrors `tests/er/devnet/01-onboard-private.ts` / `tests/er/lib/trader.ts`
// (`onboardTrader`) step-for-step — same instructions, same accounts, same
// order — with every owner-signed step routed through Mobile Wallet Adapter
// instead of a local `Keypair`:
//   L1 steps (faucet_init, init_user, delegateSpl, delegate_user)
//     -> MWA `signTransactions` (sign-only), then this app submits on
//        `baseConn` — the reference fakewallet's own send path
//        (`SendTransactionsUseCase`) rejects multi-ix txs like `delegateSpl`
//        with "payloads invalid for signing" (see `sendL1` note below)
//   ER steps (credit_deposit, init_permissions, set_session)
//     -> MWA `signTransactions`, then this app sends the signed tx on the
//        TEE connection and polls `getSignatureStatuses` itself — mirrors
//        `tests/er/lib/env.ts`'s `sendAndConfirmIx`/`confirmSignature`
//        (the ER validator's confirmation websocket is unreliable, per that
//        file's header comment)
//
// Every step checks on-chain state first and skips if already done
// (idempotent, like `onboardTrader`), so `advance()` (the screen's single
// "Continue" action) is safe to call again after a partial failure — a
// re-tap resumes from wherever onboarding actually broke, and running it
// again on an already-onboarded wallet is a fast no-op all the way through.
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

export type OnboardState =
  'Disconnected' | 'NotOnboarded' | 'Funded' | 'Initialized' | 'Delegated' | 'Credited' | 'Permissioned' | 'SessionSet'

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
  signTransactions: (tx: Transaction) => Promise<Transaction>
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
    appendLog(
      `fund session ${await sendL1(owner, [sessionTopUpIx(owner, session.publicKey)], mwa.signTransactions)}`,
    )
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
  connectWallet: () => Promise<void>
  refresh: () => Promise<void>
  /** Runs onboarding forward from wherever it currently stands, all the way to `SessionSet` (or the first failure). */
  advance: () => Promise<void>
}

export function useOnboarding(): UseOnboarding {
  const { account, connect, signAndSendTransaction, signTransactions } = useMobileWallet()
  const { getConnection } = useTeeConnection()
  const [state, setState] = useState<OnboardState>('Disconnected')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sessionPubkey, setSessionPubkey] = useState<PublicKey | null>(null)

  const owner = account ? toPublicKey(account.address) : null

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

  const advance = useCallback(async () => {
    if (!owner) {
      await connectWallet()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const config = pdas.config()
      const configInfo = await baseConn.getAccountInfo(config, 'confirmed')
      if (!configInfo) throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
      const mint = readConfigDusdcMint(configInfo.data)
      const market = pdas.market()
      const userAccount = pdas.userAccount(owner)
      const position = pdas.position(owner, market)
      const disclosureQueue = pdas.disclosureQueue(owner)
      const faucetPda = pdas.faucet(owner)
      const mintAuth = pdas.mintAuth()
      const pool = pdas.pool(mint)
      const poolLive = pdas.poolLive(mint)
      const poolAta = pdas.poolAta(mint)
      const ownerAta = getAssociatedTokenAddressSync(mint, owner)
      const session = await getOrCreateSessionKeypair(owner)
      setSessionPubkey(session.publicKey)
      const exitSalt = await getOrCreateExitSalt(owner)

      const ctx: OnboardCtx = {
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
      }
      await runFlow(ctx, { signAndSendTransaction, signTransactions, getConnection }, appendLog, setState)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }, [owner, connectWallet, signAndSendTransaction, signTransactions, getConnection, appendLog])

  return { owner, session: sessionPubkey, state, busy, log, error, connectWallet, refresh, advance }
}
