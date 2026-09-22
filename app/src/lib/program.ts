// app/src/lib/program.ts
//
// Anchor `Program` construction for `dexxer_core`, mirroring
// `tests/er/lib/program.ts` (the devnet reference this app's onboarding flow
// repeats through MWA). The IDL is the plain JSON copied from
// `target/idl/dexxer_core.json` (see task-7 brief) — not an `anchor build`
// generated TS module — so, like the reference, `Program`'s generic account
// namespace can't statically know field names; callers use `accountNs()`
// to escape-hatch into `program.account.<name>.fetch(...)`.
//
// Unlike the reference (which always has a local `Keypair` to build an
// AnchorProvider's `Wallet`), the app never holds the owner's private key —
// every owner-signed instruction is signed by Mobile Wallet Adapter, and
// every session-signed one by the locally-generated session `Keypair`
// (`session.ts`). `dexxerCoreProgram` below only ever needs to *build*
// instructions (`.methods(...).accounts({...}).instruction()`) and *read*
// accounts (`accountNs(program).x.fetch(...)`) — neither touches the
// provider's `Wallet.signTransaction`, so a read-only shim is enough; it
// throws if anything ever does try to sign through it, as a guardrail
// against accidentally bypassing MWA/session signing.
import { AnchorProvider, BN, BorshAccountsCoder, Program, type Idl } from '@coral-xyz/anchor'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js'
import { keccak_256 } from '@noble/hashes/sha3'
import idlJson from '../idl/dexxer_core.json'

export const DEXXER_CORE_IDL = idlJson as unknown as Idl
export const DEXXER_CORE_PROGRAM_ID = new PublicKey((idlJson as unknown as { address: string }).address)

class ReadOnlyWallet {
  constructor(readonly publicKey: PublicKey) {}
  async signTransaction<T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> {
    throw new Error('ReadOnlyWallet cannot sign — sign owner txs via MWA, session txs via the local session Keypair')
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> {
    throw new Error('ReadOnlyWallet cannot sign — sign owner txs via MWA, session txs via the local session Keypair')
  }
}

export function anchorProviderFor(conn: Connection, pubkey: PublicKey): AnchorProvider {
  return new AnchorProvider(conn, new ReadOnlyWallet(pubkey), { commitment: 'confirmed', skipPreflight: true })
}

/** `Program` bound to `pubkey` for instruction-building and account reads only — see file header. */
export function dexxerCoreProgram(conn: Connection, pubkey: PublicKey): Program {
  return new Program(DEXXER_CORE_IDL, anchorProviderFor(conn, pubkey))
}

/** Escape hatch for `program.account.<name>.fetch(...)` when the IDL is untyped JSON (mirrors tests/er/lib/program.ts). */
export function accountNs(program: Program): any {
  return program.account
}

// --- manual account field reads (work around an Anchor + Hermes/RN decode bug) ---
//
// `Program.account.<name>.fetch()` (via `accountNs()` above) throws
// `TypeError: undefined is not a function` on-device, inside
// `buffer-layout`'s `UInt#decode` (`b.readUIntLE is not a function`) —
// found during task-7 emulator verification (fakewallet + real devnet).
// Root cause, confirmed by instrumenting both sides: a raw
// `Connection.getAccountInfo(...).data` — as `@solana/web3.js` returns it
// directly — IS a fully-functional `Buffer` in this exact environment
// (`readUIntLE` present, correct `Buffer.prototype` chain); the object that
// reaches `buffer-layout` from *inside* `@coral-xyz/anchor`'s
// `dist/browser/index.js` bundle is not — that prebuilt bundle evidently
// closes over its own internal buffer reference at build time, independent
// of `global.Buffer` (which `app/polyfill.js` does fix, for everything
// else). Reading the handful of fixed-offset fields onboarding actually
// needs by hand, straight off the raw buffer `getAccountInfo` already
// returns, sidesteps anchor's decoder entirely — instruction *building*
// (`.methods(...).accounts({...}).instruction()`) is unaffected, since that
// only encodes and never goes through this decode path.
//
// Offsets are Borsh's declared-field-order encoding — 8-byte Anchor
// discriminator, then each field in the exact order
// `target/idl/dexxer_core.json` lists them for that account (verified
// against the IDL, not guessed; mirrors CLAUDE.md's seed-mirroring rule).
const DISCRIMINATOR_LEN = 8

/** `Config.dusdc_mint` offset: disc(8) + version(1) + admin(32) + crank(32) + paused(1) + oracle_program(32) + tee_validator(32). */
const CONFIG_DUSDC_MINT_OFFSET = DISCRIMINATOR_LEN + 1 + 32 + 32 + 1 + 32 + 32

/** `UserAccount.session_key` offset: disc(8) + version(1) + owner(32). */
const USER_ACCOUNT_SESSION_KEY_OFFSET = DISCRIMINATOR_LEN + 1 + 32

/** `UserAccount.free_margin` offset: disc(8) + version(1) + owner(32) + session_key(32) + session_expiry(8) + actions_left(4). */
const USER_ACCOUNT_FREE_MARGIN_OFFSET = DISCRIMINATOR_LEN + 1 + 32 + 32 + 8 + 4

export function readConfigDusdcMint(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(CONFIG_DUSDC_MINT_OFFSET, CONFIG_DUSDC_MINT_OFFSET + 32))
}

export function readUserAccountSessionKey(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(USER_ACCOUNT_SESSION_KEY_OFFSET, USER_ACCOUNT_SESSION_KEY_OFFSET + 32))
}

export function readUserAccountFreeMargin(data: Buffer): bigint {
  return data.readBigUInt64LE(USER_ACCOUNT_FREE_MARGIN_OFFSET)
}

/** `Config.oracle_program` offset: disc(8) + version(1) + admin(32) + crank(32) + paused(1). */
const CONFIG_ORACLE_PROGRAM_OFFSET = DISCRIMINATOR_LEN + 1 + 32 + 32 + 1

export function readConfigOracleProgram(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(CONFIG_ORACLE_PROGRAM_OFFSET, CONFIG_ORACLE_PROGRAM_OFFSET + 32))
}

/**
 * `Config.fee_payer` offset (Task 6, week 4): `CONFIG_DUSDC_MINT_OFFSET`
 * (already past admin/crank/paused/oracle_program/tee_validator) +
 * dusdc_mint(32) + disclosure_delay_slots(8) + scheduler_signer(32) —
 * matches `app/src/idl/dexxer_core.json`'s `Config` type field order
 * exactly (`version, admin, crank, paused, oracle_program, tee_validator,
 * dusdc_mint, disclosure_delay_slots, scheduler_signer, fee_payer, ...`).
 * `useOnboarding.ts`'s batched flow sets `tx.feePayer` to this for the two
 * L1 transactions it hands to the relayer's `POST /sponsor`.
 */
const CONFIG_FEE_PAYER_OFFSET = CONFIG_DUSDC_MINT_OFFSET + 32 + 8 + 32

export function readConfigFeePayer(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(CONFIG_FEE_PAYER_OFFSET, CONFIG_FEE_PAYER_OFFSET + 32))
}

// --- Task 8: Position/Market manual decodes + session-signed Trade ixs ---
//
// Offsets below follow the same fixed-offset approach as the block above
// (worked around the Hermes/Anchor decode bug), verified against current
// Rust source (CLAUDE.md: verify, don't guess) —
// `programs/dexxer_core/src/state/position.rs` and `.../market.rs`, 20-Sep-2026 —
// and cross-checked against `app/src/idl/dexxer_core.json`'s `types` entries
// for `Position`/`Market` (declared field order matches Borsh's encoding
// order exactly).

/** `Position.state` offset: disc(8) + version(1) + owner(32) + market(32). 1-byte enum: 0=Empty, 1=Open, 2=Closed. */
const POSITION_STATE_OFFSET = DISCRIMINATOR_LEN + 1 + 32 + 32
/** `Position.side` offset: ...+ state(1). 1-byte enum: 0=Long, 1=Short. */
const POSITION_SIDE_OFFSET = POSITION_STATE_OFFSET + 1
/** `Position.size` offset: ...+ side(1). */
const POSITION_SIZE_OFFSET = POSITION_SIDE_OFFSET + 1
/** `Position.entry` offset: ...+ size(8). */
const POSITION_ENTRY_OFFSET = POSITION_SIZE_OFFSET + 8
/** `Position.margin` offset: ...+ entry(8). */
const POSITION_MARGIN_OFFSET = POSITION_ENTRY_OFFSET + 8
/** `Position.liq_price` offset: ...+ margin(8). */
const POSITION_LIQ_PRICE_OFFSET = POSITION_MARGIN_OFFSET + 8
// (opened_slot/liq_ticks/oi_notional/closed/bump follow — not needed by the UI, not decoded here.)

const POSITION_STATES = ['Empty', 'Open', 'Closed'] as const
export type PositionStateName = (typeof POSITION_STATES)[number]
const SIDES = ['Long', 'Short'] as const
export type SideName = (typeof SIDES)[number]

export interface DecodedPosition {
  state: PositionStateName
  side: SideName
  size: bigint
  entry: bigint
  margin: bigint
  liqPrice: bigint
}

export function decodePosition(data: Buffer): DecodedPosition {
  return {
    state: POSITION_STATES[data.readUInt8(POSITION_STATE_OFFSET)],
    side: SIDES[data.readUInt8(POSITION_SIDE_OFFSET)],
    size: data.readBigUInt64LE(POSITION_SIZE_OFFSET),
    entry: data.readBigUInt64LE(POSITION_ENTRY_OFFSET),
    margin: data.readBigUInt64LE(POSITION_MARGIN_OFFSET),
    liqPrice: data.readBigUInt64LE(POSITION_LIQ_PRICE_OFFSET),
  }
}

/** Read+decode `Position` off `conn` (raw `getAccountInfo`, not `program.account.position.fetch` — see file header). `null` if the account doesn't exist yet (pre-`init_user`). */
export async function readPosition(conn: Connection, position: PublicKey): Promise<DecodedPosition | null> {
  const info = await conn.getAccountInfo(position, 'confirmed')
  if (!info) return null
  return decodePosition(info.data)
}

/**
 * `Market.mark` offset: disc(8) + version(1) + symbol(8) + feed(32) +
 * max_lev_bps(4) + imr_bps(4) + mmr_bps(4) + open_fee_bps(2) + close_fee_bps(2) +
 * liq_fee_bps(2) + oi_cap(8) + max_position(8) + min_size(8) + max_staleness_secs(8) +
 * max_conf_bps(2) + max_deviation_bps(2).
 */
const MARKET_MARK_OFFSET = DISCRIMINATOR_LEN + 1 + 8 + 32 + 4 + 4 + 4 + 2 + 2 + 2 + 8 + 8 + 8 + 8 + 2 + 2

export interface DecodedMarket {
  mark: bigint
}

export function decodeMarket(data: Buffer): DecodedMarket {
  return { mark: data.readBigUInt64LE(MARKET_MARK_OFFSET) }
}

/** Read+decode `Market` off `conn`. `null` if the account doesn't exist. */
export async function readMarket(conn: Connection, market: PublicKey): Promise<DecodedMarket | null> {
  const info = await conn.getAccountInfo(market, 'confirmed')
  if (!info) return null
  return decodeMarket(info.data)
}

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

// --- known error codes (programs/dexxer_core/src/errors.rs) -> short messages ---
//
// Anchor's `#[error_code]` numbers variants from 6000, in declared order;
// `errors.rs`'s own doc comment says that order is pinned (append-only), so
// this mapping is safe to hardcode rather than re-derive at runtime.
export const DEXXER_ERROR_MESSAGES: Record<number, string> = {
  6000: 'arithmetic overflow',
  6001: 'division by zero',
  6002: 'invalid input',
  6003: 'protocol is paused',
  6004: 'opening new positions is paused',
  6005: 'oracle price is stale',
  6006: 'oracle confidence too wide',
  6007: 'oracle price deviates too far from mark',
  6008: 'wrong oracle feed for market',
  6009: 'invalid oracle account',
  6010: 'insufficient margin',
  6011: 'leverage too high',
  6012: 'position too small',
  6013: 'position too large',
  6014: 'open interest cap exceeded',
  6015: 'slippage exceeded — price moved past your limit',
  6016: 'position already open',
  6017: 'no open position',
  6018: 'position is not liquidatable',
  6019: 'unauthorized',
  6020: 'session key expired — redo onboarding to refresh it',
  6021: 'no actions left on this session key — redo onboarding to refresh it',
  6022: 'account has an open position',
  6023: 'disclosure queue is full',
  6024: 'invalid action signer',
  6025: 'pool is insolvent',
  6026: 'invalid liquidation candidate',
  6027: 'amount must be non-zero',
  6028: 'invalid parameters',
  6029: 'faucet daily limit exceeded',
  6030: 'withdraw is on cooldown for this account',
}

/** Map a thrown tx error to a short, readable message via `DEXXER_ERROR_MESSAGES` where the error carries a recognizable Anchor custom-error code; falls back to the raw error message. */
export function describeTxError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const hex = msg.match(/custom program error: 0x([0-9a-fA-F]+)/)
  const dec = msg.match(/"Custom":\s*(\d+)/i)
  const code = hex ? parseInt(hex[1], 16) : dec ? parseInt(dec[1], 10) : null
  if (code !== null && DEXXER_ERROR_MESSAGES[code]) {
    return `${DEXXER_ERROR_MESSAGES[code]} (${code})`
  }
  return msg
}

// --- Task 9: History/Receipt decoders (DisclosureQueue, Disclosure,
// BalancesRoot), UserAccount.exit_salt, and the keccak leaf hash ---
//
// Same manual fixed-offset approach as the block above (Anchor's Borsh
// decoder is broken on-device for `Program.account.<name>.fetch()` — see
// file header), offsets verified against current Rust source, 22-Sep-2026
// (CLAUDE.md: verify, don't guess):
//   `programs/dexxer_core/src/state/user.rs`       — UserAccount
//   `programs/dexxer_core/src/state/disclosure.rs` — DisclosureQueue, Disclosure
//   `programs/dexxer_core/src/state/position.rs`   — ClosedRecord (embedded in DisclosureQueue)
//   `programs/dexxer_core/src/state/balances_root.rs` — BalancesRoot (zero_copy, repr(C))
// and cross-checked against `tests/er/lib/program.ts`'s `decodeBalancesRoot`/
// `leaf`/`pad`/`commitmentHash` (the reference TS implementation this file's
// `leafHex` and offsets mirror byte-for-byte) and `hashes.selftest.ts` (the
// golden vectors `assertLeafGolden` below re-asserts).

/**
 * `UserAccount.exit_salt` offset: disc(8) + version(1) + owner(32) +
 * session_key(32) + session_expiry(8) + actions_left(4) + free_margin(8) +
 * locked_margin(8) + nonce(8) + last_withdraw_slot(8) = 117.
 */
const USER_ACCOUNT_EXIT_SALT_OFFSET =
  USER_ACCOUNT_FREE_MARGIN_OFFSET +
  8 /* free_margin */ +
  8 /* locked_margin */ +
  8 /* nonce */ +
  8 /* last_withdraw_slot */

export function readUserAccountExitSalt(data: Buffer): Uint8Array {
  return Uint8Array.from(data.subarray(USER_ACCOUNT_EXIT_SALT_OFFSET, USER_ACCOUNT_EXIT_SALT_OFFSET + 32))
}

/**
 * `ClosedRecord` Borsh field order (`state/position.rs`) — NOT the order the
 * week-3 plan text guessed (that guess put `salt` last; the actual struct
 * puts `salt` before `nonce`/`reveal_after_slot`/`commitment_written` — Rust
 * source wins per CLAUDE.md):
 *   market:32, side:1, size:8, entry:8, exit:8, pnl:8(i64), fees:8,
 *   reason:1, opened_slot:8, closed_slot:8, salt:32, nonce:8,
 *   reveal_after_slot:8, commitment_written:1  =  139 bytes total.
 */
const CLOSED_RECORD_SIZE = 139
const CR_MARKET_OFF = 0
const CR_SIDE_OFF = 32
const CR_SIZE_OFF = 33
const CR_ENTRY_OFF = 41
const CR_EXIT_OFF = 49
const CR_PNL_OFF = 57
const CR_FEES_OFF = 65
const CR_REASON_OFF = 73
const CR_OPENED_SLOT_OFF = 74
const CR_CLOSED_SLOT_OFF = 82
const CR_SALT_OFF = 90
const CR_NONCE_OFF = 122
const CR_REVEAL_AFTER_SLOT_OFF = 130
const CR_COMMITMENT_WRITTEN_OFF = 138

const CLOSE_REASONS = ['User', 'Liquidated'] as const
export type CloseReasonName = (typeof CLOSE_REASONS)[number]

export interface DecodedClosedRecord {
  market: PublicKey
  side: SideName
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  reason: CloseReasonName
  openedSlot: bigint
  closedSlot: bigint
  salt: Uint8Array
  nonce: bigint
  revealAfterSlot: bigint
  commitmentWritten: boolean
}

function decodeClosedRecord(data: Buffer, base: number): DecodedClosedRecord {
  return {
    market: new PublicKey(data.subarray(base + CR_MARKET_OFF, base + CR_MARKET_OFF + 32)),
    side: SIDES[data.readUInt8(base + CR_SIDE_OFF)],
    size: data.readBigUInt64LE(base + CR_SIZE_OFF),
    entry: data.readBigUInt64LE(base + CR_ENTRY_OFF),
    exit: data.readBigUInt64LE(base + CR_EXIT_OFF),
    pnl: data.readBigInt64LE(base + CR_PNL_OFF),
    fees: data.readBigUInt64LE(base + CR_FEES_OFF),
    reason: CLOSE_REASONS[data.readUInt8(base + CR_REASON_OFF)],
    openedSlot: data.readBigUInt64LE(base + CR_OPENED_SLOT_OFF),
    closedSlot: data.readBigUInt64LE(base + CR_CLOSED_SLOT_OFF),
    salt: Uint8Array.from(data.subarray(base + CR_SALT_OFF, base + CR_SALT_OFF + 32)),
    nonce: data.readBigUInt64LE(base + CR_NONCE_OFF),
    revealAfterSlot: data.readBigUInt64LE(base + CR_REVEAL_AFTER_SLOT_OFF),
    commitmentWritten: data.readUInt8(base + CR_COMMITMENT_WRITTEN_OFF) !== 0,
  }
}

/** `DisclosureQueue.records` ring capacity (`state/disclosure.rs::DQ_CAPACITY`). */
export const DQ_CAPACITY = 8

/** `DisclosureQueue.head` offset: disc(8) + version(1) + owner(32). */
const DQ_HEAD_OFFSET = DISCRIMINATOR_LEN + 1 + 32
/** `DisclosureQueue.len` offset: ...+ head(1). */
const DQ_LEN_OFFSET = DQ_HEAD_OFFSET + 1
/** `DisclosureQueue.records` offset: ...+ len(1). */
const DQ_RECORDS_OFFSET = DQ_LEN_OFFSET + 1

export interface DecodedDisclosureQueue {
  head: number
  len: number
  /** Live records only, in ring order (`records[(head + i) % DQ_CAPACITY]` for `i < len`) — not the raw fixed array. */
  records: DecodedClosedRecord[]
}

export function decodeDisclosureQueue(data: Buffer): DecodedDisclosureQueue {
  const head = data.readUInt8(DQ_HEAD_OFFSET)
  const len = data.readUInt8(DQ_LEN_OFFSET)
  const records: DecodedClosedRecord[] = []
  for (let i = 0; i < len; i++) {
    const idx = (head + i) % DQ_CAPACITY
    records.push(decodeClosedRecord(data, DQ_RECORDS_OFFSET + idx * CLOSED_RECORD_SIZE))
  }
  return { head, len, records }
}

/** Read+decode `DisclosureQueue` off `conn` (owner-TEE, per Task 9 brief). `null` if the account doesn't exist. */
export async function readDisclosureQueue(conn: Connection, dq: PublicKey): Promise<DecodedDisclosureQueue | null> {
  const info = await conn.getAccountInfo(dq, 'confirmed')
  if (!info) return null
  return decodeDisclosureQueue(info.data)
}

/**
 * `Disclosure` (L1, Borsh `#[account]`) field order (`state/disclosure.rs`):
 * version:1, owner:32 (always `Pubkey::default()` by design — spec §2.3
 * discloses the trade, not the trader), market:32, side:1, size:8, entry:8,
 * exit:8, pnl:8(i64), fees:8, reason:1, opened_slot:8, closed_slot:8,
 * nonce:8, bump:1. Note: unlike `ClosedRecord`, the on-chain `Disclosure`
 * carries no `salt`/`reveal_after_slot`/`commitment_written` — those are
 * mutable queue bookkeeping or write_disclosure-argument-only fields.
 */
const DISCLOSURE_MARKET_OFFSET = DISCRIMINATOR_LEN + 1 + 32
const DISCLOSURE_SIDE_OFFSET = DISCLOSURE_MARKET_OFFSET + 32
const DISCLOSURE_SIZE_OFFSET = DISCLOSURE_SIDE_OFFSET + 1
const DISCLOSURE_ENTRY_OFFSET = DISCLOSURE_SIZE_OFFSET + 8
const DISCLOSURE_EXIT_OFFSET = DISCLOSURE_ENTRY_OFFSET + 8
const DISCLOSURE_PNL_OFFSET = DISCLOSURE_EXIT_OFFSET + 8
const DISCLOSURE_FEES_OFFSET = DISCLOSURE_PNL_OFFSET + 8
const DISCLOSURE_REASON_OFFSET = DISCLOSURE_FEES_OFFSET + 8
const DISCLOSURE_OPENED_SLOT_OFFSET = DISCLOSURE_REASON_OFFSET + 1
const DISCLOSURE_CLOSED_SLOT_OFFSET = DISCLOSURE_OPENED_SLOT_OFFSET + 8
const DISCLOSURE_NONCE_OFFSET = DISCLOSURE_CLOSED_SLOT_OFFSET + 8

export interface DecodedDisclosure {
  market: PublicKey
  side: SideName
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  reason: CloseReasonName
  openedSlot: bigint
  closedSlot: bigint
  nonce: bigint
}

export function decodeDisclosure(data: Buffer): DecodedDisclosure {
  return {
    market: new PublicKey(data.subarray(DISCLOSURE_MARKET_OFFSET, DISCLOSURE_MARKET_OFFSET + 32)),
    side: SIDES[data.readUInt8(DISCLOSURE_SIDE_OFFSET)],
    size: data.readBigUInt64LE(DISCLOSURE_SIZE_OFFSET),
    entry: data.readBigUInt64LE(DISCLOSURE_ENTRY_OFFSET),
    exit: data.readBigUInt64LE(DISCLOSURE_EXIT_OFFSET),
    pnl: data.readBigInt64LE(DISCLOSURE_PNL_OFFSET),
    fees: data.readBigUInt64LE(DISCLOSURE_FEES_OFFSET),
    reason: CLOSE_REASONS[data.readUInt8(DISCLOSURE_REASON_OFFSET)],
    openedSlot: data.readBigUInt64LE(DISCLOSURE_OPENED_SLOT_OFFSET),
    closedSlot: data.readBigUInt64LE(DISCLOSURE_CLOSED_SLOT_OFFSET),
    nonce: data.readBigUInt64LE(DISCLOSURE_NONCE_OFFSET),
  }
}

/**
 * Base58-encoded 8-byte Anchor account discriminator for `Disclosure`,
 * computed from the app's own IDL (not hardcoded) — used as a
 * `getProgramAccounts` memcmp filter (offset 0) to find every `Disclosure`
 * on L1. `Disclosure.owner` is always `Pubkey::default()` by design (see
 * above), so results still need filtering by nonce — see
 * `HistoryScreen.tsx`.
 */
export const DISCLOSURE_DISC = new BorshAccountsCoder(DEXXER_CORE_IDL)
  .accountDiscriminator('Disclosure')
  .toString('base64')

/** Read every `Disclosure` account on `conn` (base layer) matching the discriminator filter — unfiltered by nonce, see `DISCLOSURE_DISC`. */
export async function readAllDisclosures(
  conn: Connection,
): Promise<{ pubkey: PublicKey; disclosure: DecodedDisclosure }[]> {
  const accounts = await conn.getProgramAccounts(DEXXER_CORE_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: DISCLOSURE_DISC, encoding: 'base64' } }],
  })
  return accounts.map(({ pubkey, account }) => ({ pubkey, disclosure: decodeDisclosure(account.data) }))
}

/**
 * `BalancesRoot` is `#[account(zero_copy)] #[repr(C)]` (controller ruling,
 * week 3 task 5 — a by-value Borsh decode blew the SBF stack frame), NOT
 * Borsh field order. Layout: `disc[8] | root_slot:u64le(8) |
 * leaves:[[u8;32];64](2048) | version:u8(1) | filled:u8(1) | bump:u8(1) |
 * _pad[5]` = 2072 bytes total — mirrors `tests/er/lib/program.ts`'s
 * `decodeBalancesRoot` exactly.
 */
export const ROOT_LEAVES = 64

export interface DecodedBalancesRoot {
  rootSlot: bigint
  leaves: Uint8Array[]
  version: number
  filled: number
  bump: number
}

export function decodeBalancesRoot(data: Buffer): DecodedBalancesRoot {
  let o = DISCRIMINATOR_LEN
  const rootSlot = data.readBigUInt64LE(o)
  o += 8
  const leaves: Uint8Array[] = []
  for (let i = 0; i < ROOT_LEAVES; i++) {
    leaves.push(Uint8Array.from(data.subarray(o, o + 32)))
    o += 32
  }
  const version = data.readUInt8(o)
  o += 1
  const filled = data.readUInt8(o)
  o += 1
  const bump = data.readUInt8(o)
  return { rootSlot, leaves, version, filled, bump }
}

/** Read+decode `BalancesRoot` off `conn` (base layer; pass `pdas.balancesRoot()`). `null` if the account doesn't exist yet. */
export async function readBalancesRoot(conn: Connection, balancesRoot: PublicKey): Promise<DecodedBalancesRoot | null> {
  const info = await conn.getAccountInfo(balancesRoot, 'confirmed')
  if (!info) return null
  return decodeBalancesRoot(info.data)
}

/**
 * `u64::to_le_bytes()` as a plain `Uint8Array` — NOT `Buffer` (see
 * `leafHex` below for why): the app's pinned `@types/node` is old enough
 * that `Buffer`'s inherited `Uint8Array` shape doesn't satisfy TS's newer
 * `Uint8Array<ArrayBufferLike>` iterator methods, so anything feeding
 * `@noble/hashes` has to stay a plain `Uint8Array` end-to-end rather than
 * relying on `Buffer.concat`/`Buffer.alloc`.
 */
function u64leBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, v, true)
  return out
}

/** `i64::to_le_bytes()` as a plain `Uint8Array` (see `u64leBytes`'s doc comment — `pnl` is signed). */
function i64leBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, v, true)
  return out
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * `leaf(owner, free_margin, exit_salt, root_slot) = keccak256(owner(32) ‖
 * free_margin:u64le(8) ‖ exit_salt(32) ‖ root_slot:u64le(8))` —
 * `programs/dexxer_core/src/state/balances_root.rs::leaf` /
 * `tests/er/lib/program.ts::leaf`, returned as lowercase hex (this file's
 * name for it, per the Task-9 brief interface) rather than raw bytes.
 * Built from plain `Uint8Array`s (`owner.toBytes()`, not `.toBuffer()`) —
 * see `u64leBytes`'s doc comment.
 */
export function leafHex(owner: PublicKey, freeMargin: bigint, exitSalt: Uint8Array, rootSlot: bigint): string {
  const input = concatBytes(owner.toBytes(), u64leBytes(freeMargin), exitSalt, u64leBytes(rootSlot))
  const bytes = keccak_256(input)
  return Buffer.from(bytes).toString('hex')
}

/**
 * Golden-vector self-check (Task 9): asserts `leafHex` above produces the
 * exact same hex as the Rust `leaf_and_pad_golden_vectors` unit test
 * (`programs/dexxer_core/src/state/balances_root.rs`) and the TS reference
 * (`tests/er/lib/hashes.selftest.ts`) for the same fixed inputs — so a
 * layout/byte-order mistake here would be caught immediately rather than
 * silently producing wrong Receipt verdicts. Not a test-runner test (none is
 * wired up for this app package, mirroring `tests/er`'s standalone
 * `hashes.selftest.ts`) — call once, e.g. from `__DEV__` startup logging.
 * Throws on mismatch.
 */
export function assertLeafGolden(): void {
  const owner = new PublicKey(new Uint8Array(32).fill(3))
  const exitSalt = new Uint8Array(32).fill(4)
  const got = leafHex(owner, 42n, exitSalt, 99n)
  const expected = '79107674f9ef863f98a85fdbc056ddf1121f71870dffb8628f206b6c82f31572'
  if (got !== expected) {
    throw new Error(`assertLeafGolden: leafHex mismatch — got ${got}, expected ${expected}`)
  }
}

/**
 * Mirrors `DisclosureArgs`/`state::disclosure::commitment_hash` field-for-field
 * (`programs/dexxer_core/src/state/disclosure.rs`, `tests/er/lib/program.ts`'s
 * `DisclosureArgsBytes`). Task 8b: History matches an L1 `Disclosure` to this
 * device's own closed trade by this hash, not by `nonce` — `nonce` is
 * `UserAccount.nonce`, a per-user counter, so two different traders' revealed
 * `Disclosure.nonce` values can collide (ruling 9's whole point). `side`/
 * `reason` take the decoded name (`SideName`/`CloseReasonName`) rather than a
 * raw index, since that is what `DecodedClosedRecord` already carries.
 */
export interface CommitmentArgs {
  market: PublicKey
  side: SideName
  size: bigint
  entry: bigint
  exit: bigint
  pnl: bigint
  fees: bigint
  reason: CloseReasonName
  openedSlot: bigint
  closedSlot: bigint
  nonce: bigint
  revealAfterSlot: bigint
}

/**
 * `commitment_hash(a, salt) = keccak256(market(32) ‖ side:u8(1) ‖ size:u64le(8)
 * ‖ entry:u64le(8) ‖ exit:u64le(8) ‖ pnl:i64le(8) ‖ fees:u64le(8) ‖
 * reason:u8(1) ‖ opened_slot:u64le(8) ‖ closed_slot:u64le(8) ‖ nonce:u64le(8)
 * ‖ reveal_after_slot:u64le(8) ‖ salt(32))` — byte-for-byte
 * `programs/dexxer_core/src/state/disclosure.rs::commitment_hash` /
 * `tests/er/lib/program.ts::commitmentHash`. Returns raw bytes (32); a caller
 * needing a PDA seed or a persisted key converts with
 * `Buffer.from(...).toString('hex')` (see `pdas.commitment`/`pdas.disclosure`,
 * which also accept the hex form directly).
 */
export function commitmentHash(a: CommitmentArgs, salt: Uint8Array): Uint8Array {
  const input = concatBytes(
    a.market.toBytes(),
    Uint8Array.of(SIDES.indexOf(a.side)),
    u64leBytes(a.size),
    u64leBytes(a.entry),
    u64leBytes(a.exit),
    i64leBytes(a.pnl),
    u64leBytes(a.fees),
    Uint8Array.of(CLOSE_REASONS.indexOf(a.reason)),
    u64leBytes(a.openedSlot),
    u64leBytes(a.closedSlot),
    u64leBytes(a.nonce),
    u64leBytes(a.revealAfterSlot),
    salt,
  )
  return keccak_256(input)
}

/**
 * Golden-vector self-check (Task 8b), same pattern as `assertLeafGolden`:
 * asserts `commitmentHash` above produces the exact same hex as the Rust
 * `commitment_hash_golden_vector` unit test
 * (`programs/dexxer_core/src/state/disclosure.rs`) and the TS reference
 * (`tests/er/lib/hashes.selftest.ts`) for the same fixed inputs. Throws on
 * mismatch.
 */
export function assertCommitmentGolden(): void {
  const args: CommitmentArgs = {
    market: new PublicKey(new Uint8Array(32).fill(1)),
    side: 'Long',
    size: 1_000_000n,
    entry: 150_000_000n,
    exit: 151_000_000n,
    pnl: -5n,
    fees: 7n,
    reason: 'User',
    openedSlot: 10n,
    closedSlot: 20n,
    nonce: 3n,
    revealAfterSlot: 25n,
  }
  const salt = new Uint8Array(32).fill(2)
  const got = Buffer.from(commitmentHash(args, salt)).toString('hex')
  const expected = '26e982cc691717451020afc4cb1146e7489b0953c9b26b3ad589f19741c4103f'
  if (got !== expected) {
    throw new Error(`assertCommitmentGolden: hash mismatch — got ${got}, expected ${expected}`)
  }
}

if (__DEV__) {
  try {
    assertLeafGolden()
    console.log('[dexxer] assertLeafGolden: keccak leaf hash OK (golden vector matched)')
  } catch (e) {
    console.error('[dexxer] assertLeafGolden FAILED', e)
  }
  try {
    assertCommitmentGolden()
    console.log('[dexxer] assertCommitmentGolden: keccak commitment hash OK (golden vector matched)')
  } catch (e) {
    console.error('[dexxer] assertCommitmentGolden FAILED', e)
  }
}
