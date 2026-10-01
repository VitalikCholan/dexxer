// app/src/features/account/accountTx.ts
//
// Task 10: Deposit/Withdraw/Exit transaction builders for the Account
// screen. All four instructions here (`faucet_mint`, `credit_deposit`,
// `withdraw`, `undelegate_user`) are `owner: Signer` on-chain
// (programs/dexxer_core/src/instructions/user.rs) — unlike Trade/Positions,
// which are session-signed — so every builder goes through Mobile Wallet
// Adapter (`mwa.getConnection`/`signTransactions`), the same pattern
// `useOnboarding.ts`/`batchOnboarding.ts` already use, never the session key.
import { BN } from '@coral-xyz/anchor'
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  magicFeeVaultPdaFromValidator,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { baseConn, ER_VALIDATOR } from '@/src/lib/solana'
import { dexxerCoreProgram } from '@/src/lib/anchor'
import { readConfigDusdcMint } from '@/src/lib/codecs'
import { usdAmount } from '@/src/lib/trade'
import { pdas } from '@/src/lib/pdas'
import type { DecodedPositions } from '@/src/lib/positions'
import { sendErOwner, sendL1, sendL1Sponsored, type Mwa } from '@/src/lib/txSend'
import { SELF_FUND_TX_MIN_LAMPORTS, canSelfFund } from '@/src/lib/selfFund'

export interface AccountPdas {
  owner: PublicKey
  config: PublicKey
  mint: PublicKey
  faucet: PublicKey
  mintAuth: PublicKey
  pool: PublicKey
  poolLive: PublicKey
  poolAta: PublicKey
  ownerAta: PublicKey
  userAccount: PublicKey
  feeEscrow: PublicKey
}

/** Reads `Config` once and derives every PDA Deposit/Withdraw/Exit need — mirrors `useOnboarding.ts`'s `buildCtx`. */
export async function buildAccountPdas(owner: PublicKey): Promise<AccountPdas> {
  const config = pdas.config()
  const configInfo = await baseConn.getAccountInfo(config, 'confirmed')
  if (!configInfo) throw new Error('Config PDA not found — protocol not bootstrapped on this devnet deployment')
  const mint = readConfigDusdcMint(configInfo.data)
  return {
    owner,
    config,
    mint,
    faucet: pdas.faucet(owner),
    mintAuth: pdas.mintAuth(),
    pool: pdas.pool(mint),
    poolLive: pdas.poolLive(mint),
    poolAta: pdas.poolAta(mint),
    ownerAta: getAssociatedTokenAddressSync(mint, owner),
    userAccount: pdas.userAccount(owner),
    feeEscrow: pdas.feeEscrow(),
  }
}

/**
 * `faucet_mint` (L1, owner-signed) then `credit_deposit` (ER, owner-signed)
 * — the same dev-deposit path `batchOnboarding.ts`'s `runDevDeposit` uses,
 * minus its "already funded" skip: a real Deposit always mints + credits
 * the amount the user typed.
 */
export async function depositTx(
  p: AccountPdas,
  mwa: Pick<Mwa, 'signTransactions' | 'getConnection' | 'ensureRelayerSession'>,
  amountUsd: number,
): Promise<{ mintSig: string; creditSig: string }> {
  // `faucet_mint` rides on a relayer nonce (and may be sponsored): session first, before the wallet prompt (spec §2.7).
  await mwa.ensureRelayerSession(p.owner)
  const amount = usdAmount(amountUsd)
  const coreL1 = dexxerCoreProgram(baseConn, p.owner)
  const mintIx = await coreL1.methods
    .faucetMint(new BN(amount.toString()))
    .accounts({
      owner: p.owner,
      config: p.config,
      faucet: p.faucet,
      dusdcMint: p.mint,
      mintAuth: p.mintAuth,
      ownerAta: p.ownerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction()
  // Owner-paid when the wallet holds SOL (Phantom cannot simulate a sponsored
  // tx — selfFund.ts); fee_payer-sponsored otherwise (a 0-SOL-onboarded owner
  // cannot pay the network fee — live fakewallet smoke 24.09, the owner-paid
  // leg was silently dropped).
  const mintSig = (await canSelfFund(p.owner, SELF_FUND_TX_MIN_LAMPORTS))
    ? await sendL1(p.owner, [mintIx], mwa.signTransactions)
    : await sendL1Sponsored(p.owner, p.config, [mintIx], mwa.signTransactions)

  const ownerTee = await mwa.getConnection(p.owner)
  const coreEr = dexxerCoreProgram(ownerTee, p.owner)
  const creditIx = await coreEr.methods
    .creditDeposit(new BN(amount.toString()))
    .accounts({
      owner: p.owner,
      userAccount: p.userAccount,
      pool: p.pool,
      poolLive: p.poolLive,
      ownerAta: p.ownerAta,
      vaultAta: p.poolAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction()
  const creditSig = await sendErOwner(ownerTee, p.owner, [creditIx], mwa.signTransactions)
  return { mintSig, creditSig }
}

/** CLAUDE.md: `require!(amount >= MIN_WITHDRAW = 1_000_000)` — 1 dUSDC. Enforced client-side too, as a friendlier error before the wallet prompt. */
export const MIN_WITHDRAW_USD = 1

/** `withdraw` (ER, owner-signed). `FeeEscrow`/commit-intent plumbing is server-side; this only builds the one instruction. */
export async function withdrawTx(
  p: AccountPdas,
  mwa: Pick<Mwa, 'signTransactions' | 'getConnection'>,
  amountUsd: number,
): Promise<string> {
  if (amountUsd < MIN_WITHDRAW_USD) throw new Error(`minimum withdrawal is ${MIN_WITHDRAW_USD} dUSDC`)
  const amount = usdAmount(amountUsd)
  const ownerTee = await mwa.getConnection(p.owner)
  const coreEr = dexxerCoreProgram(ownerTee, p.owner)
  const ix = await coreEr.methods
    .withdraw(new BN(amount.toString()))
    .accounts({
      owner: p.owner,
      userAccount: p.userAccount,
      pool: p.pool,
      poolLive: p.poolLive,
      ownerAta: p.ownerAta,
      vaultAta: p.poolAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      config: p.config,
      feeEscrow: p.feeEscrow,
      magicFeeVault: magicFeeVaultPdaFromValidator(ER_VALIDATOR),
      magicContext: MAGIC_CONTEXT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction()
  return sendErOwner(ownerTee, p.owner, [ix], mwa.signTransactions)
}

const MAX_EXIT_MARKETS = 16

/**
 * Markets whose liquidation tasks `undelegate_user` should cancel: SOL first
 * (never dropped), then open slots, then history newest first (a liquidated
 * position leaves its task running until the next open or the exit), unique,
 * at most 16 (the program's `remaining_accounts` cap).
 */
export function exitMarkets(p: DecodedPositions | null, sol: PublicKey): PublicKey[] {
  const out: PublicKey[] = []
  const seen = new Set<string>()
  const add = (m: PublicKey) => {
    const key = m.toBase58()
    if (seen.has(key)) return
    seen.add(key)
    out.push(m)
  }
  add(sol)
  if (p) {
    for (const s of p.slots) add(s.market)
    for (let i = p.history.length - 1; i >= 0; i--) add(p.history[i].market)
  }
  return out.slice(0, MAX_EXIT_MARKETS)
}

/** The `undelegate_user` instruction (12 named accounts + `markets` read-only as remaining accounts). */
export async function exitIx(
  p: AccountPdas,
  conn: Connection,
  positions: PublicKey,
  markets: PublicKey[],
): Promise<TransactionInstruction> {
  const coreEr = dexxerCoreProgram(conn, p.owner)
  return coreEr.methods
    .undelegateUser()
    .accounts({
      owner: p.owner,
      config: p.config,
      userAccount: p.userAccount,
      positions,
      userPermission: permissionPdaFromAccount(p.userAccount),
      positionsPermission: permissionPdaFromAccount(positions),
      ephemeralVault: EPHEMERAL_VAULT_ID,
      permissionProgram: PERMISSION_PROGRAM_ID,
      feeEscrow: p.feeEscrow,
      magicFeeVault: magicFeeVaultPdaFromValidator(ER_VALIDATOR),
      magicContext: MAGIC_CONTEXT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
    })
    .remainingAccounts(markets.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })))
    .instruction()
}

/**
 * `undelegate_user` (ER, owner-signed). Program gates: `open_count == 0` and
 * zero margin (the caller's Exit checklist mirrors them; the program
 * re-asserts both). `markets` (<= 16, unique) are the markets whose
 * liquidation tasks to cancel.
 */
export async function exitTx(
  p: AccountPdas,
  mwa: Pick<Mwa, 'signTransactions' | 'getConnection'>,
  positions: PublicKey,
  markets: PublicKey[],
): Promise<string> {
  const ownerTee = await mwa.getConnection(p.owner)
  const ix = await exitIx(p, ownerTee, positions, markets)
  return sendErOwner(ownerTee, p.owner, [ix], mwa.signTransactions)
}
