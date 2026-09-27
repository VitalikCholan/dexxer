// app/src/lib/codecs.ts
//
// Manual Borsh/zero-copy decoders for every `dexxer_core` account the app
// reads, plus the `read*` helpers that fetch-and-decode over a `Connection`.
// Split out of `program.ts` (week 6). Why the offsets are hand-written
// instead of `program.account.<name>.fetch()` is explained in the first
// comment block below (an Anchor + Hermes decode bug, found on-device).
import { BorshAccountsCoder } from '@coral-xyz/anchor'
import { Connection, PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL, DEXXER_CORE_PROGRAM_ID } from './anchor'

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
 * `batchOnboarding.ts`'s batched flow sets `tx.feePayer` to this for the two
 * L1 legs it hands to the relayer's `POST /sponsor` (`faucet_init`/`init_user`
 * and `delegateSpl`). The ER leg (`init_permissions`/`set_session`) stays
 * owner-paid, `tx.feePayer = owner` — real devnet-tee rejects `fee_payer` as
 * an ER transaction's fee payer (`InvalidAccountForFee`) unless `fee_payer`
 * itself originated the tx (fix round 1, finding A.3; see
 * `services/relayer/README.md`'s Sponsor section for the full rationale).
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
// `opened_slot`(8), `liq_ticks`(1), `oi_notional`(8) and
// `closed: Option<ClosedRecord>` follow `liq_price`(8) in that order — none
// of them is decoded here (see `DecodedPosition`'s doc comment below), so no
// offset constants are declared for them.

export const POSITION_STATES = ['Empty', 'Open', 'Closed'] as const
export type PositionStateName = (typeof POSITION_STATES)[number]
export const SIDES = ['Long', 'Short'] as const
export type SideName = (typeof SIDES)[number]

/**
 * `Position.closed: Option<ClosedRecord>` still exists in the Rust struct
 * (right after `oi_notional`) but is always `None` since week-5 Task 1:
 * `finalize_close` pushes the `ClosedRecord` straight into `DisclosureQueue`
 * and resets `Position` to `Empty` in the same instruction — a close no
 * longer leaves a trade sitting in `Position.closed` even momentarily. This
 * file no longer decodes it (nothing reads past it), and `DecodedPosition`
 * carries no `closed` field — History's only sources are `DisclosureQueue`
 * and the L1 `Disclosure` feed (see `HistoryScreen.tsx`/`useHistoryRows.ts`).
 */
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
 * `Market` field offsets (`programs/dexxer_core/src/state/market.rs`,
 * verified 23-Sep-2026), decomposed one field at a time (not a single
 * collapsed sum) so Task 10's ticket-math fields (`imr_bps`/`mmr_bps`/
 * `open_fee_bps`) can each get their own named offset:
 * disc(8) + version(1) + symbol(8) + feed(32) + max_lev_bps(4) + imr_bps(4)
 * + mmr_bps(4) + open_fee_bps(2) + close_fee_bps(2) + liq_fee_bps(2) +
 * oi_cap(8) + max_position(8) + min_size(8) + max_staleness_secs(8) +
 * max_conf_bps(2) + max_deviation_bps(2) -> mark.
 */
const MARKET_FEED_OFFSET = DISCRIMINATOR_LEN + 1 + 8
const MARKET_MAX_LEV_BPS_OFFSET = MARKET_FEED_OFFSET + 32
const MARKET_IMR_BPS_OFFSET = MARKET_MAX_LEV_BPS_OFFSET + 4
const MARKET_MMR_BPS_OFFSET = MARKET_IMR_BPS_OFFSET + 4
const MARKET_OPEN_FEE_BPS_OFFSET = MARKET_MMR_BPS_OFFSET + 4
const MARKET_CLOSE_FEE_BPS_OFFSET = MARKET_OPEN_FEE_BPS_OFFSET + 2
const MARKET_LIQ_FEE_BPS_OFFSET = MARKET_CLOSE_FEE_BPS_OFFSET + 2
const MARKET_OI_CAP_OFFSET = MARKET_LIQ_FEE_BPS_OFFSET + 2
const MARKET_MAX_POSITION_OFFSET = MARKET_OI_CAP_OFFSET + 8
const MARKET_MIN_SIZE_OFFSET = MARKET_MAX_POSITION_OFFSET + 8
const MARKET_MAX_STALENESS_SECS_OFFSET = MARKET_MIN_SIZE_OFFSET + 8
const MARKET_MAX_CONF_BPS_OFFSET = MARKET_MAX_STALENESS_SECS_OFFSET + 8
const MARKET_MAX_DEVIATION_BPS_OFFSET = MARKET_MAX_CONF_BPS_OFFSET + 2
const MARKET_MARK_OFFSET = MARKET_MAX_DEVIATION_BPS_OFFSET + 2

export interface DecodedMarket {
  mark: bigint
  /** Task 10: ticket-math params (`app/src/lib/math.ts`'s `fee`/`liqPrice`/`requiredMargin`) — bps values fit comfortably in `number`. */
  maxLevBps: number
  imrBps: number
  mmrBps: number
  openFeeBps: number
  closeFeeBps: number
}

export function decodeMarket(data: Buffer): DecodedMarket {
  return {
    mark: data.readBigUInt64LE(MARKET_MARK_OFFSET),
    maxLevBps: data.readUInt32LE(MARKET_MAX_LEV_BPS_OFFSET),
    imrBps: data.readUInt32LE(MARKET_IMR_BPS_OFFSET),
    mmrBps: data.readUInt32LE(MARKET_MMR_BPS_OFFSET),
    openFeeBps: data.readUInt16LE(MARKET_OPEN_FEE_BPS_OFFSET),
    closeFeeBps: data.readUInt16LE(MARKET_CLOSE_FEE_BPS_OFFSET),
  }
}

/** Read+decode `Market` off `conn`. `null` if the account doesn't exist. */
export async function readMarket(conn: Connection, market: PublicKey): Promise<DecodedMarket | null> {
  const info = await conn.getAccountInfo(market, 'confirmed')
  if (!info) return null
  return decodeMarket(info.data)
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
 * Task 10: `UserAccount.session_expiry` (i64 — signed, unlike every other
 * field this file reads off `UserAccount`) and `.locked_margin`, plus a
 * `decodeUserAccount` aggregate for the Account/Trade screens (Available =
 * `free_margin`, Locked = `locked_margin`, "session active/expired" =
 * `session_expiry` vs. wall-clock `now`). Offsets: `session_expiry` sits
 * right after `session_key`(32); `locked_margin` right after `free_margin`(8)
 * — both already fixed-offset per the block above.
 */
const USER_ACCOUNT_SESSION_EXPIRY_OFFSET = USER_ACCOUNT_SESSION_KEY_OFFSET + 32
/** `UserAccount.actions_left` (u32): right after `session_expiry`(8) — the session-signed action budget `set_session` hands out. */
const USER_ACCOUNT_ACTIONS_LEFT_OFFSET = USER_ACCOUNT_SESSION_EXPIRY_OFFSET + 8
const USER_ACCOUNT_LOCKED_MARGIN_OFFSET = USER_ACCOUNT_FREE_MARGIN_OFFSET + 8

export function readUserAccountSessionExpiry(data: Buffer): bigint {
  return data.readBigInt64LE(USER_ACCOUNT_SESSION_EXPIRY_OFFSET)
}

export function readUserAccountActionsLeft(data: Buffer): number {
  return data.readUInt32LE(USER_ACCOUNT_ACTIONS_LEFT_OFFSET)
}

export function readUserAccountLockedMargin(data: Buffer): bigint {
  return data.readBigUInt64LE(USER_ACCOUNT_LOCKED_MARGIN_OFFSET)
}

/**
 * `UserAccount.exited` offset (week-5 Task 2, `UserAccount` v2): appended at
 * the END of the struct, after `bump` — `USER_ACCOUNT_EXIT_SALT_OFFSET` +
 * exit_salt(32) + bump(1). Set by `undelegate_user`, cleared by
 * `init_user_reuse_queue` — `batchOnboarding.ts`'s `collectBatchLegs` reads
 * this to choose `init_user` (fresh owner) vs `init_user_reuse_queue`
 * (returning owner whose PDAs survived their exit).
 */
const USER_ACCOUNT_EXITED_OFFSET = USER_ACCOUNT_EXIT_SALT_OFFSET + 32 + 1

/**
 * Bounds-checked: a v1 `UserAccount` (`programs/dexxer_core/src/state/
 * user.rs`'s doc comment — pre-week-5-Task-2, one byte shorter, no `exited`
 * field at all) is a real thing that can still be sitting on devnet from
 * before that upgrade, and `Buffer.readUInt8` throws "Trying to access
 * beyond buffer length" past the end rather than returning `undefined` —
 * caught live in emulator smoke testing (week 5, Task 6): an old test wallet
 * onboarded weeks earlier hit exactly this on the Account screen. Treated as
 * `false` — a v1 account was never able to set this flag in the first
 * place, so "not exited" is the correct read, not a crash. Also protects
 * `batchOnboarding.ts`'s `collectBatchLegs`, which calls this to choose
 * `init_user` vs `init_user_reuse_queue` — an unhandled throw there would
 * have blocked re-onboarding entirely for any such stale account.
 */
export function readUserAccountExited(data: Buffer): boolean {
  if (data.length <= USER_ACCOUNT_EXITED_OFFSET) return false
  return data.readUInt8(USER_ACCOUNT_EXITED_OFFSET) !== 0
}

export interface DecodedUserAccount {
  sessionKey: PublicKey
  /** Unix seconds — compare against `Math.floor(Date.now() / 1000)`. */
  sessionExpiry: bigint
  /** Session-signed actions remaining — `set_session` grants `SESSION_ACTIONS`, every trade spends one (week 6: surfaced so the app can warn before error 6021). */
  actionsLeft: number
  freeMargin: bigint
  lockedMargin: bigint
  exitSalt: Uint8Array
  exited: boolean
}

export function decodeUserAccount(data: Buffer): DecodedUserAccount {
  return {
    sessionKey: readUserAccountSessionKey(data),
    sessionExpiry: readUserAccountSessionExpiry(data),
    actionsLeft: readUserAccountActionsLeft(data),
    freeMargin: readUserAccountFreeMargin(data),
    lockedMargin: readUserAccountLockedMargin(data),
    exitSalt: readUserAccountExitSalt(data),
    exited: readUserAccountExited(data),
  }
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

export const CLOSE_REASONS = ['User', 'Liquidated'] as const
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
