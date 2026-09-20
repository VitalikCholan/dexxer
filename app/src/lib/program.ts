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
import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor'
import { Connection, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js'
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
