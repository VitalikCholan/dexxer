// app/src/lib/trade.ts
//
// Trade-side helpers: fixed-point scaling (`usdAmount`/`solSize`), client
// uPnL, the `Trade` account list, and the four session-signed ER
// instructions (`open/close/increase/decrease_position`) — sent without an
// MWA prompt, signed by the local session `Keypair` (`session.ts`). Split
// out of `program.ts` (week 6).
import { BN } from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { dexxerCoreProgram } from './anchor'
import { readPosition, type SideName } from './codecs'

/** u64::MAX — the permissive ("no slippage protection") limit for a Short close (mirrors `tests/er/lib/trader.ts`'s `U64_MAX`). */
export const U64_MAX = 18_446_744_073_709_551_615n

/** Scale a whole/fractional USD amount to the program's 1e6 fixed-point (dUSDC decimals / PRICE_SCALE) — mirrors `tests/er/lib/trader.ts`'s `usd`. */
export function usdAmount(n: number): bigint {
  return BigInt(Math.round(n * 1_000_000))
}

/** Scale a whole/fractional SOL size to the program's 1e9 fixed-point (math.rs SIZE_SCALE) — mirrors `tests/er/lib/trader.ts`'s `solSize`. */
export function solSize(n: number): bigint {
  return BigInt(Math.round(n * 1_000_000_000))
}

/**
 * Client-side uPnL, mirroring `programs/dexxer_core/src/math.rs`'s `upnl`
 * exactly: `size * (mark - entry)` for Long (`entry - mark` for Short),
 * truncated toward zero by `SIZE_SCALE` (1e9) — not floored. JS/TS `bigint`
 * division already truncates toward zero (matches Rust's `i128` division),
 * so no extra rounding step is needed here.
 */
export function computeUpnl(side: SideName, size: bigint, entry: bigint, mark: bigint): bigint {
  const diff = side === 'Long' ? mark - entry : entry - mark
  return (size * diff) / 1_000_000_000n
}

/** Accounts every `Trade` instruction (`open_position`/`close_position`) needs beyond `signer` — see `programs/dexxer_core/src/instructions/trade.rs`'s `Trade` context. */
export interface TradeAccounts {
  config: PublicKey
  market: PublicKey
  marketRisk: PublicKey
  /** Private live pool counters (week 4, Task 1) — `Trade` writes here, never the public `pool` snapshot. */
  poolLive: PublicKey
  userAccount: PublicKey
  position: PublicKey
  feed: PublicKey
  /** Week 5, Task 1: a close pushes its `ClosedRecord` straight into the owner's ring, so every trade ix carries it. */
  disclosureQueue: PublicKey
  /** Week 5, Task 3: pays the per-position liquidation task's scheduler CPI, and is that task's authority. */
  feeEscrow: PublicKey
  /**
   * Week 5, Task 3's Magic Actions task context. An inert writable placeholder
   * on-chain: the Magic Program never creates, writes or reassigns it, and any
   * already-existing writable account is accepted (Task 0, measurement 6).
   * Every client passes the position PDA so registration and cancel name the
   * same account.
   */
  taskContext: PublicKey
  magicProgram: PublicKey
  /**
   * Week 5, Task 3: `crank_signer_pda(feeEscrow)` — the signer a scheduled
   * `liquidation_check` tick carries. `open_position` rejects any other value.
   */
  liqCrankSigner: PublicKey
}

// Poll `getSignatureStatuses` instead of `Connection.confirmTransaction` —
// same finding as `useOnboarding.ts`'s `confirmOnConn` / `tests/er/lib/env.ts`'s
// `confirmSignature`: the ER validator's confirmation websocket doesn't
// reliably deliver `signatureSubscribe` notifications on-device, so
// `confirmTransaction` can hang indefinitely even after the tx has landed.
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

/** Sign with the session `Keypair` locally (no MWA prompt) and send+confirm on `conn` — fee payer = session, per file header/Task 8 brief. */
async function sendSessionTx(conn: Connection, session: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = session.publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  tx.sign(session)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
  await confirmOnConn(conn, sig)
  return sig
}

/** `open_position` on the ER, signed ONLY by `session` — no MWA prompt (mirrors `tests/er/lib/trader.ts`'s `openPosition` / `01-onboard-private.ts`'s session-signed open). */
export async function openPosition(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  side: 'long' | 'short',
  sizeSol: number,
  marginUsd: number,
  limitUsdPrice: number,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .openPosition(
      side === 'long' ? { long: {} } : { short: {} },
      new BN(solSize(sizeSol).toString()),
      new BN(usdAmount(marginUsd).toString()),
      new BN(usdAmount(limitUsdPrice).toString()),
    )
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}

/**
 * `close_position` on the ER, signed ONLY by `session`. `limitUsdPrice`
 * defaults to 0, a "no slippage protection" sentinel — `close_position`'s
 * Short branch requires `exec_price <= limit_price`, so a literal 0 would
 * always reject a short close; this reads the position's side first and
 * maps the sentinel to the permissive bound for that side (0 for Long,
 * u64::MAX for Short), same as `tests/er/lib/trader.ts`'s `closePosition`.
 */
export async function closePosition(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  limitUsdPrice = 0,
): Promise<string> {
  const posState = await readPosition(conn, accounts.position)
  if (!posState) throw new Error('closePosition: Position account not found')
  const isShort = posState.side === 'Short'
  const limitArg = limitUsdPrice === 0 ? (isShort ? U64_MAX : 0n) : usdAmount(limitUsdPrice)
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .closePosition(new BN(limitArg.toString()))
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}

/**
 * `increase_position` on the ER, signed ONLY by `session` (Task 10 —
 * Positions screen's "Increase" sheet). Same `Trade` context/limit-price
 * direction as `open_position` (Long: price <= limit; Short: price >=
 * limit) — `programs/dexxer_core/src/instructions/trade.rs`.
 */
export async function increasePosition(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  addSizeSol: number,
  addMarginUsd: number,
  limitUsdPrice: number,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .increasePosition(
      new BN(solSize(addSizeSol).toString()),
      new BN(usdAmount(addMarginUsd).toString()),
      new BN(usdAmount(limitUsdPrice).toString()),
    )
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}

/**
 * `decrease_position` on the ER, signed ONLY by `session` (Task 10 —
 * Positions screen's "Decrease" sheet). Limit-price direction is the
 * OPPOSITE of open/increase (Long: price >= limit; Short: price <= limit —
 * same direction as `close_position`, `trade.rs`).
 */
export async function decreasePosition(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  closeSizeSol: number,
  limitUsdPrice: number,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .decreasePosition(new BN(solSize(closeSizeSol).toString()), new BN(usdAmount(limitUsdPrice).toString()))
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}
