// app/src/lib/anchor.ts
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
import { Connection, PublicKey, Transaction, type VersionedTransaction } from '@solana/web3.js'
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
