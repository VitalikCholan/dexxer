// app/src/lib/trade.ts
//
// Trade-side helpers: fixed-point scaling (`usdAmount`/`solSize`), client
// uPnL, the `Trade` account list, and the five session-signed ER
// instructions (`open/close/increase/decrease_position`, `add_margin`) —
// sent without an MWA prompt, signed by the local session `Keypair`
// (`session.ts`). Split out of `program.ts` (week 6).
import { BN } from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { dexxerCoreProgram } from './anchor'
import { type SideName } from './codecs'
import { confirmOnConn } from './confirm'
import { pdas } from './pdas'
import { decodePositions, slotFor } from './positions'

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

/**
 * Accounts every `Trade` instruction (`open/close/increase/decrease_position`,
 * `add_margin`) needs beyond `signer` — 12 in all, in the IDL's order:
 * `programs/dexxer_core/src/instructions/trade.rs`'s `Trade` context.
 */
export interface TradeAccounts {
  config: PublicKey
  /** The selected market's PDA; the trader's position on it is the `Positions` slot whose `market` equals it. */
  market: PublicKey
  marketRisk: PublicKey
  /** Private live pool counters (week 4, Task 1) — `Trade` writes here, never the public `pool` snapshot. */
  poolLive: PublicKey
  userAccount: PublicKey
  /** The owner's zero-copy `Positions` (16 slots + history ring). */
  positions: PublicKey
  /** The market's oracle feed (`Market.feed`). */
  feed: PublicKey
  /** Week 5, Task 3: pays the per-position liquidation task's scheduler CPI, and is that task's authority. */
  feeEscrow: PublicKey
  /**
   * Week 5, Task 3's Magic Actions task context. An inert writable placeholder
   * on-chain: the Magic Program never creates, writes or reassigns it, and any
   * already-existing writable account is accepted (Task 0, measurement 6).
   * Every client passes the `Positions` PDA so registration and cancel name
   * the same account.
   */
  taskContext: PublicKey
  magicProgram: PublicKey
  /**
   * Week 5, Task 3: `crank_signer_pda(feeEscrow)` — the signer a scheduled
   * `liquidation_check` tick carries. `open_position` rejects any other value.
   */
  liqCrankSigner: PublicKey
}

/** The market-independent accounts, derived once per owner (`useTradeSession`'s `base`). */
export type BaseTradeAccounts = Omit<TradeAccounts, 'market' | 'marketRisk' | 'feed' | 'taskContext'>

/** One market's full account set: its PDA, risk PDA and feed on top of the owner's base; `taskContext` = `positions`. */
export function tradeAccountsFor(base: BaseTradeAccounts, m: { market: PublicKey; feed: PublicKey }): TradeAccounts {
  return { ...base, market: m.market, marketRisk: pdas.marketRisk(m.market), feed: m.feed, taskContext: base.positions }
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

// Week 6: every trade instruction below takes RAW program units — `bigint`
// at 1e9 (size) / 1e6 (USD, price), exactly what goes on the wire. Text
// inputs convert ONCE at the UI edge (`solSize`/`usdAmount`); prices that
// already are bigints (mark, slippage limits, `U64_MAX`) are passed through.
// The previous `number` API re-scaled inside, so `Number(U64_MAX) / 1e6`
// came back as 2^64 and the Short-decrease-without-mark path threw at
// encode time ("byte array longer than desired length"; `test/trade.test.ts`).

/** `open_position` on the ER, signed ONLY by `session` — no MWA prompt (mirrors `tests/er/lib/trader.ts`'s `openPosition` / `01-onboard-private.ts`'s session-signed open). */
export async function openPosition(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  side: 'long' | 'short',
  size: bigint,
  margin: bigint,
  limitPrice: bigint,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .openPosition(
      side === 'long' ? { long: {} } : { short: {} },
      new BN(size.toString()),
      new BN(margin.toString()),
      new BN(limitPrice.toString()),
    )
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}

/**
 * `add_margin` on the ER, signed ONLY by `session` (C.4 — Positions card's
 * "Add margin"). Moves `amount` from free to the open position's margin and
 * recomputes its liq price; no price read, so no limit argument
 * (`trade.rs::add_margin`). There is no `remove_margin` instruction.
 */
export async function addMargin(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  amount: bigint,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .addMargin(new BN(amount.toString()))
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}

/**
 * `close_position` on the ER, signed ONLY by `session`. `limitPrice`
 * defaults to `0n`, a "no slippage protection" sentinel — `close_position`'s
 * Short branch requires `exec_price <= limit_price`, so a literal 0 would
 * always reject a short close; this reads the side of this market's slot first and
 * maps the sentinel to the permissive bound for that side (0 for Long,
 * u64::MAX for Short), same as `tests/er/lib/trader.ts`'s `closePosition`.
 */
export async function closePosition(
  conn: Connection,
  session: Keypair,
  accounts: TradeAccounts,
  limitPrice = 0n,
): Promise<string> {
  const info = await conn.getAccountInfo(accounts.positions, 'confirmed')
  const slot = info ? slotFor(decodePositions(info.data), accounts.market) : null
  if (!slot) throw new Error('closePosition: no open position on this market')
  const isShort = slot.side === 'Short'
  const limitArg = limitPrice === 0n ? (isShort ? U64_MAX : 0n) : limitPrice
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
  addSize: bigint,
  addMargin: bigint,
  limitPrice: bigint,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .increasePosition(new BN(addSize.toString()), new BN(addMargin.toString()), new BN(limitPrice.toString()))
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
  closeSize: bigint,
  limitPrice: bigint,
): Promise<string> {
  const core = dexxerCoreProgram(conn, session.publicKey)
  const ix = await core.methods
    .decreasePosition(new BN(closeSize.toString()), new BN(limitPrice.toString()))
    .accounts({ signer: session.publicKey, ...accounts })
    .instruction()
  return sendSessionTx(conn, session, [ix])
}
