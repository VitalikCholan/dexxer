// app/src/lib/codecs.ts
//
// Manual Borsh/zero-copy decoders for the `dexxer_core` accounts the app
// reads (`Config`, `UserAccount`, `Market`, `BalancesRoot`; `Positions` lives in
// `positions.ts`), plus the `read*` helpers that fetch-and-decode over a `Connection`.
// Split out of `program.ts` (week 6). Why the offsets are hand-written
// instead of `program.account.<name>.fetch()` is explained in the first
// comment block below (an Anchor + Hermes decode bug, found on-device).
import { Connection, PublicKey } from '@solana/web3.js'
export { SIDES, type SideName } from './positions'

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
// `idl/dexxer_core.json` lists them for that account (verified
// against the IDL, not guessed; mirrors CLAUDE.md's seed-mirroring rule).
// Sources: `state/user.rs`, `state/market.rs`, `state/config.rs`,
// `state/balances_root.rs` (checked 01.10.2026).
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
 * `Config.fee_payer` offset: `CONFIG_DUSDC_MINT_OFFSET` + dusdc_mint(32) +
 * scheduler_signer(32) (position slots dropped `disclosure_delay_slots`;
 * matches `idl/dexxer_core.json`'s `Config` field order: `version, admin,
 * crank, paused, oracle_program, tee_validator, dusdc_mint, scheduler_signer,
 * fee_payer, magic_fee_vault, ...`). The old offset (210) would now read
 * `magic_fee_vault` without any error — `codecs.test.ts` pins it.
 * `batchOnboarding.ts`'s batched flow sets `tx.feePayer` to this for the L1
 * legs it hands to the relayer's `POST /sponsor`. The ER leg stays
 * owner-paid, `tx.feePayer = owner` — real devnet-tee rejects `fee_payer` as
 * an ER transaction's fee payer (`InvalidAccountForFee`) unless `fee_payer`
 * itself originated the tx (see `services/relayer/README.md`'s Sponsor
 * section).
 */
const CONFIG_FEE_PAYER_OFFSET = CONFIG_DUSDC_MINT_OFFSET + 32 + 32

export function readConfigFeePayer(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(CONFIG_FEE_PAYER_OFFSET, CONFIG_FEE_PAYER_OFFSET + 32))
}

// --- Market (public, Borsh) ---
//
// Offsets verified against `programs/dexxer_core/src/state/market.rs` and
// `idl/dexxer_core.json`'s `Market` type (declared field order = Borsh order).

/**
 * `Market` field offsets (`programs/dexxer_core/src/state/market.rs`,
 * verified 01-Oct-2026), decomposed one field at a time (not a single
 * collapsed sum) so Task 10's ticket-math fields (`imr_bps`/`mmr_bps`/
 * `open_fee_bps`) can each get their own named offset:
 * disc(8) + version(1) + symbol(8) + feed(32) + max_lev_bps(4) + imr_bps(4)
 * + mmr_bps(4) + open_fee_bps(2) + close_fee_bps(2) + liq_fee_bps(2) +
 * oi_cap(8) + max_position(8) + min_size(8) + max_staleness_secs(8) +
 * max_conf_bps(2) + max_deviation_bps(2) -> mark(8) + mark_slot(8) +
 * last_print(8) + sample_seq(8) + ema_alpha_bps(2) + ...
 */
const MARKET_SYMBOL_OFFSET = DISCRIMINATOR_LEN + 1
const MARKET_FEED_OFFSET = MARKET_SYMBOL_OFFSET + 8
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
  /** Market symbol (`SOL`, `BTC`, ...) — the 8-byte field trimmed of NUL padding. */
  symbol: string
}

export function decodeMarket(data: Buffer): DecodedMarket {
  return {
    mark: data.readBigUInt64LE(MARKET_MARK_OFFSET),
    maxLevBps: data.readUInt32LE(MARKET_MAX_LEV_BPS_OFFSET),
    imrBps: data.readUInt32LE(MARKET_IMR_BPS_OFFSET),
    mmrBps: data.readUInt32LE(MARKET_MMR_BPS_OFFSET),
    openFeeBps: data.readUInt16LE(MARKET_OPEN_FEE_BPS_OFFSET),
    closeFeeBps: data.readUInt16LE(MARKET_CLOSE_FEE_BPS_OFFSET),
    symbol: data.subarray(MARKET_SYMBOL_OFFSET, MARKET_SYMBOL_OFFSET + 8).toString('utf8').replace(/\0+$/, ''),
  }
}

/** Read+decode `Market` off `conn`. `null` if the account doesn't exist. */
export async function readMarket(conn: Connection, market: PublicKey): Promise<DecodedMarket | null> {
  const info = await conn.getAccountInfo(market, 'confirmed')
  if (!info) return null
  return decodeMarket(info.data)
}

// --- UserAccount tail, BalancesRoot ---
//
// Same manual fixed-offset approach as the block above (Anchor's Borsh
// decoder is broken on-device for `Program.account.<name>.fetch()` — see
// file header). `UserAccount` (`state/user.rs`, v3, 207 B) has a fixed layout.

/**
 * `UserAccount.exit_salt` offset: disc(8) + version(1) + owner(32) +
 * session_key(32) + session_expiry(8) + actions_left(4) + free_margin(8) +
 * locked_margin(8) + last_withdraw_slot(8) = 109 (v3 dropped `nonce`).
 */
const USER_ACCOUNT_EXIT_SALT_OFFSET =
  USER_ACCOUNT_FREE_MARGIN_OFFSET +
  8 /* free_margin */ +
  8 /* locked_margin */ +
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
 * `UserAccount.exited` offset: `USER_ACCOUNT_EXIT_SALT_OFFSET` + exit_salt(32)
 * + bump(1) = 142. Set by `undelegate_user`; `batchOnboarding.ts` reads it to
 * tell a returning owner (must be cleaned up by the janitor first) from a
 * fresh one.
 */
const USER_ACCOUNT_EXITED_OFFSET = USER_ACCOUNT_EXIT_SALT_OFFSET + 32 + 1
/** `UserAccount.rent_payer` offset: right after `exited`(1) = 143. Who gets the rent back on `close_exited_user`. */
const USER_ACCOUNT_RENT_PAYER_OFFSET = USER_ACCOUNT_EXITED_OFFSET + 1

export function readUserAccountExited(data: Buffer): boolean {
  return data.readUInt8(USER_ACCOUNT_EXITED_OFFSET) !== 0
}

export function readUserAccountRentPayer(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(USER_ACCOUNT_RENT_PAYER_OFFSET, USER_ACCOUNT_RENT_PAYER_OFFSET + 32))
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
  rentPayer: PublicKey
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
    rentPayer: readUserAccountRentPayer(data),
  }
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
