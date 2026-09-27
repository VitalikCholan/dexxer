// app/src/lib/txSend.ts
//
// Owner-signed transaction primitives (week 6: extracted from
// batchOnboarding.ts — `accountTx.ts` needs them for deposit/withdraw just
// as onboarding does). Every owner signature goes through MWA (`sign`, a
// wallet prompt); submission is ours, on the connection that actually holds
// the accounts. Measured wallet truths these encode (24–25.09, live
// Phantom/fakewallet): a prompt can outlive a blockhash (re-sign after
// signing, `signWithLiveBlockhash`), so owner L1 legs ride relayer-created
// durable nonces when available (`signOwnerL1`) and fall back to a live
// blockhash when the relayer cannot hand one out. `test/txSend.test.ts`.
import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { baseConn } from './solana'
import { readConfigFeePayer } from './codecs'
import { describeTxError } from './errors'
import { confirmOnConn } from './confirm'
import { sponsorTx } from './sponsor'
import { fetchNonces, nonceTransaction } from './nonce'

export interface Mwa {
  signAndSendTransaction: (tx: Transaction, minContextSlot: number) => Promise<string>
  /** Matches `@wallet-ui/react-native-web3js`'s real overload: an array in, an array out, ONE wallet prompt for the whole batch (`use-mobile-wallet.d.ts`). */
  signTransactions: <K extends Transaction | Transaction[]>(tx: K) => Promise<K>
  getConnection: (owner: PublicKey) => Promise<Connection>
  /** Relayer session before any relayer call (spec §2.7) — see `relayerAuth.ts`. */
  ensureRelayerSession: (owner: PublicKey) => Promise<void>
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
/**
 * Builds `ixs` on a fresh blockhash, has the wallet sign, then checks the
 * blockhash is STILL valid — a wallet prompt can take longer than a devnet
 * blockhash lives (measured with Phantom 24.09: 38 s and 55 s per prompt while
 * the user reads "Advanced"; a tx sent after that is silently dropped and only
 * surfaces as "confirm timeout"). Re-signs up to `attempts` times.
 */
export async function signWithLiveBlockhash(
  conn: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  sign: (tx: Transaction) => Promise<Transaction>,
  appendLog?: (s: string) => void,
  attempts = 3,
): Promise<Transaction> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const tx = new Transaction().add(...ixs)
    tx.feePayer = feePayer
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
    const signed = await sign(tx)
    const bh = signed.recentBlockhash
    const stillValid = bh ? (await conn.isBlockhashValid(bh, { commitment: 'confirmed' })).value : false
    if (stillValid) return signed
    appendLog?.(`blockhash expired while the wallet was signing (attempt ${attempt}/${attempts}) — re-signing`)
  }
  throw new Error('blockhash kept expiring while the wallet was signing — retry and confirm in the wallet sooner')
}

export async function sendL1(
  owner: PublicKey,
  ixs: TransactionInstruction[],
  signTransactions: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const signed = await signOwnerL1(owner, owner, ixs, signTransactions)
  const sig = await baseConn.sendRawTransaction(signed.serialize(), { skipPreflight: true })
  await confirmOnConn(baseConn, sig)
  return sig
}

/**
 * Signs an owner L1 transaction on the owner's durable nonce (slot 0,
 * `nonce.ts` — the relayer creates the accounts on first use), so the wallet
 * may take any time to sign; falls back to a live blockhash only if the
 * relayer cannot hand out a nonce.
 */
export async function signOwnerL1(
  owner: PublicKey,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  sign: (tx: Transaction) => Promise<Transaction>,
): Promise<Transaction> {
  try {
    const [nonce] = await fetchNonces(owner)
    if (__DEV__)
      console.log(
        `[dexxer] signOwnerL1: durable nonce slot 0 ${nonce.account.toBase58()} (${nonce.value.slice(0, 8)}…)`,
      )
    const signed = await sign(nonceTransaction(feePayer, owner, nonce, ixs))
    if (__DEV__) {
      const order = signed.instructions.map((ix) => ix.programId.toBase58().slice(0, 6)).join(',')
      // `requireAllSignatures: false` — a SPONSORED tx has no fee_payer
      // signature yet; the default `serialize()` threw `Signature
      // verification failed` here and sent every 0-SOL deposit down the
      // live-blockhash fallback (measured 25.09, fakewallet, dev build).
      const wire = signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
      console.log(
        `[dexxer] signOwnerL1: wallet returned ixs=[${order}] blockhash=${signed.recentBlockhash?.slice(0, 8)} tx=${wire}`,
      )
    }
    return signed
  } catch (e) {
    // Relayer down / rate-limited: fall back to a live blockhash rather than
    // blocking the user — with a fast wallet it still lands.
    if (__DEV__) console.log(`[dexxer] signOwnerL1: nonce unavailable (${describeTxError(e)}) — live blockhash`)
    return signWithLiveBlockhash(baseConn, feePayer, ixs, sign)
  }
}

/**
 * Like `sendL1`, but `fee_payer` pays: the owner signs with `tx.feePayer =
 * Config.fee_payer`, the relayer's `POST /sponsor` adds its signature, then
 * we send. Needed for any L1 leg a 0-SOL-onboarded owner runs after
 * onboarding — live fakewallet smoke (24.09, M-K) found Deposit's owner-paid
 * `faucet_mint` silently dropped ("confirm timeout"): the owner had 0 SOL for
 * the network fee. Throws `SponsorError` verbatim when the relayer rejects.
 */
export async function sendL1Sponsored(
  owner: PublicKey,
  config: PublicKey,
  ixs: TransactionInstruction[],
  signTransactions: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const configInfo = await baseConn.getAccountInfo(config, 'confirmed')
  if (!configInfo) throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
  const signed = await signOwnerL1(owner, readConfigFeePayer(configInfo.data), ixs, signTransactions)
  const sponsored = await sponsorTx(signed, owner)
  const sig = await baseConn.sendRawTransaction(sponsored.serialize(), { skipPreflight: true })
  if (__DEV__) console.log(`[dexxer] sendL1Sponsored: sent ${sig} (feePayer ${sponsored.feePayer?.toBase58()})`)
  await confirmOnConn(baseConn, sig)
  return sig
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
