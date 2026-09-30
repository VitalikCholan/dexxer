// tests/er/lib/program.ts
//
// Anchor `Program` construction for `dexxer_core`/`mock_oracle` plus PDA
// derivation helpers that mirror `programs/dexxer_core/src/state/mod.rs`
// (seeds) exactly, so this file is the single source of truth for account
// addresses used across `admin.ts`, `q1-deposit.ts`, and `q2-permissions.ts`.

import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { symbolBytes } from "./symbol.js";

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { Idl } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  deriveEphemeralAta,
  deriveVault,
  deriveVaultAta,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

// Task 4 (week 4, services/relayer): overridable so the relayer's Docker
// image — built from a fresh git checkout, where `target/idl/` (gitignored,
// `anchor build` output) does not exist — can point this at the one IDL
// asset actually committed to git, `app/src/idl/dexxer_core.json` (kept in
// sync with `target/idl/dexxer_core.json` by CI's `cmp` step). Default is
// unchanged for every existing caller (tests/er, scripts, app scripts run
// from a full local checkout with `target/idl/` present).
const IDL_DIR = process.env.DEXXER_IDL_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "target", "idl");

function loadIdl(name: string): Idl {
  return JSON.parse(readFileSync(resolve(IDL_DIR, `${name}.json`), "utf8"));
}

/**
 * `mock_oracle.json` is NOT committed to git (target/idl/ is fully
 * gitignored) and is local/LiteSVM-only — the relayer's minimal
 * `DEXXER_IDL_DIR` (see above) never has it, since the relayer runs
 * exclusively against `DEXXER_NET=devnet`'s real Pricing Oracle and never
 * calls `mockOracleProgram()`/`pdas.feed()`. Tolerate its absence here
 * instead of crashing this module's import for every caller.
 */
function loadIdlOptional(name: string): Idl | null {
  try {
    return loadIdl(name);
  } catch {
    return null;
  }
}

export const DEXXER_CORE_IDL = loadIdl("dexxer_core");
export const MOCK_ORACLE_IDL = loadIdlOptional("mock_oracle");
export const DEXXER_CORE_PROGRAM_ID = new PublicKey((DEXXER_CORE_IDL as { address: string }).address);
export const MOCK_ORACLE_PROGRAM_ID = MOCK_ORACLE_IDL ? new PublicKey((MOCK_ORACLE_IDL as { address: string }).address) : PublicKey.default;

const coder = new BorshAccountsCoder(DEXXER_CORE_IDL);
/** `Positions` is bytemuck/zero-copy: the coder gives its discriminator, never its body (see positions.ts). */
export const POSITIONS_DISC_BYTES: Buffer = Buffer.from(coder.accountDiscriminator("Positions"));
export const POSITIONS_DISC = bs58.encode(POSITIONS_DISC_BYTES);
export const USER_DISC = bs58.encode(coder.accountDiscriminator("UserAccount"));
export const MARKET_DISC = bs58.encode(coder.accountDiscriminator("Market"));

export function anchorProvider(conn: Connection, wallet: Keypair): AnchorProvider {
  return new AnchorProvider(conn, new Wallet(wallet), { commitment: "confirmed", skipPreflight: true });
}

// These IDLs are loaded as plain JSON (not `anchor build`-generated TS
// types), so `Program`'s generic account namespace can't statically know
// field names like `.account.pool` — callers cast those specific accesses
// with `accountNs()` below. `.methods`/`.accounts({...})` stay fully typed
// against the real (untyped-generic) IDL shape and get full runtime
// checking from Anchor's coder either way.
export function dexxerCoreProgram(conn: Connection, wallet: Keypair): Program {
  return new Program(DEXXER_CORE_IDL, anchorProvider(conn, wallet));
}

export function mockOracleProgram(conn: Connection, wallet: Keypair): Program {
  if (!MOCK_ORACLE_IDL) throw new Error("mock_oracle.json not found in IDL_DIR (local/LiteSVM-dev only — see loadIdlOptional above)");
  return new Program(MOCK_ORACLE_IDL, anchorProvider(conn, wallet));
}

/** Escape hatch for `program.account.<name>.fetch(...)` when the IDL is untyped JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function accountNs(program: Program): any {
  return program.account;
}

// --- seeds, matching programs/dexxer_core/src/state/mod.rs verbatim ---
const CONFIG_SEED = Buffer.from("config");
const MARKET_SEED = Buffer.from("market");
const RISK_SEED = Buffer.from("risk");
const POOL_SEED = Buffer.from("pool");
const USER_SEED = Buffer.from("user");
const POSITIONS_SEED = Buffer.from("positions");
const FAUCET_SEED = Buffer.from("faucet");
const MINT_AUTH_SEED = Buffer.from("mint_auth");
const FEE_ESCROW_SEED = Buffer.from("fee_escrow");
// Week 4 (Task 1): private live pool counters — see programs/dexxer_core/src/state/pool_live.rs.
const POOL_LIVE_SEED = Buffer.from("pool_live");
// Week 3 (Task 7): programs/dexxer_core/src/state/mod.rs seeds/consts.
const BALANCES_ROOT_SEED = Buffer.from("balances_root");
export const ROOT_LEAVES = 64;
export const ROOT_BATCH = 16;
export const SOL_SYMBOL = Buffer.from([83, 79, 76, 0, 0, 0, 0, 0]); // b"SOL\0\0\0\0\0"

// mock_oracle seeds, matching programs/mock_oracle/src/lib.rs
const FEED_SEED = Buffer.from("price_feed");
const LAZER_SEED = Buffer.from("pyth-lazer");

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export const pdas = {
  config: () => pda([CONFIG_SEED], DEXXER_CORE_PROGRAM_ID),
  mintAuth: () => pda([MINT_AUTH_SEED], DEXXER_CORE_PROGRAM_ID),
  feeEscrow: () => pda([FEE_ESCROW_SEED], DEXXER_CORE_PROGRAM_ID),
  market: () => pda([MARKET_SEED, SOL_SYMBOL], DEXXER_CORE_PROGRAM_ID),
  marketRisk: (market: PublicKey) => pda([RISK_SEED, market.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  pool: (mint: PublicKey) => pda([POOL_SEED, mint.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  /** Private live pool counters (week 4, Task 1) — every trading/money instruction writes here; `pool` above is a step-rounded snapshot written only by `commit_aggregate`. */
  poolLive: (mint: PublicKey) => pda([POOL_LIVE_SEED, mint.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  poolAta: (mint: PublicKey) => {
    const pool = pdas.pool(mint);
    return pda(
      [pool.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  },
  faucet: (owner: PublicKey) => pda([FAUCET_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  userAccount: (owner: PublicKey) => pda([USER_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  marketFor: (symbol: string) => pda([MARKET_SEED, symbolBytes(symbol)], DEXXER_CORE_PROGRAM_ID),
  /** A trader's positions on every market and their private history ring — one account per owner (spec §2.9.1). */
  positions: (owner: PublicKey) => pda([POSITIONS_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  feed: (lazerFeedId: string) => pda([FEED_SEED, LAZER_SEED, Buffer.from(lazerFeedId)], MOCK_ORACLE_PROGRAM_ID),
  /** Same feed PDA derivation as `feed`, but under an arbitrary oracle program (Task 0: the real devnet Pricing Oracle, not `mock_oracle`). */
  feedUnder: (oracleProgram: PublicKey, lazerFeedId: string) => pda([FEED_SEED, LAZER_SEED, Buffer.from(lazerFeedId)], oracleProgram),
  balancesRoot: () => pda([BALANCES_ROOT_SEED], DEXXER_CORE_PROGRAM_ID),
};

/** `#[delegate]`-generated buffer/record/metadata triple for a PDA owned by `ownerProgramId`. */
export function delegationTriple(delegatedAccount: PublicKey, ownerProgramId: PublicKey) {
  return {
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(delegatedAccount, ownerProgramId),
    record: delegationRecordPdaFromDelegatedAccount(delegatedAccount),
    metadata: delegationMetadataPdaFromDelegatedAccount(delegatedAccount),
  };
}

export const espl = {
  /** Ephemeral ATA PDA (eSPL program) for (owner, mint). */
  eata: (owner: PublicKey, mint: PublicKey) => deriveEphemeralAta(owner, mint)[0],
  /** Global per-mint vault PDA (eSPL program). */
  vault: (mint: PublicKey) => deriveVault(mint)[0],
  /** Vault's real SPL token account (ATA of vault, mint). */
  vaultAta: (mint: PublicKey, vault: PublicKey) => deriveVaultAta(mint, vault),
  /** Delegation buffer/record/metadata for an eATA, owned by the eSPL program. */
  eataDelegation: (eata: PublicKey) => delegationTriple(eata, EPHEMERAL_SPL_TOKEN_PROGRAM_ID),
};

export const permissionPda = permissionPdaFromAccount;
export { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID };

// --- Week 3 (Task 7): keccak256 hash helpers, byte-for-byte matching
// `leaf`/`pad` in programs/dexxer_core/src/state/{disclosure,balances_root}.rs
// (Global Constraints §"Канонічні байти commitment-у"/"Лист root-у"). Golden
// vectors for both live in `tests/er/lib/hashes.selftest.ts`
// (`npm run selftest:hashes`), asserted against the Rust unit tests
// `commitment_hash_golden_vector` / `leaf_and_pad_golden_vectors`.

// Hash canon lives in ./hashes.ts (IDL-free) — re-exported here for callers.
export { leaf, pad, u64le } from "./hashes.js";
export { symbolBytes, symbolString } from "./symbol.js";

/**
 * `BalancesRoot` is `#[account(zero_copy)]` with `bytemuck` serialization
 * (task-5 controller ruling 5 — see `state/balances_root.rs` doc comment), a
 * layout Anchor's Borsh `BorshAccountsCoder` does not decode. Manual `repr(C)`
 * offset decode instead: `disc(8) | root_slot:u64le(8) | leaves:[[u8;32];64]
 * (2048) | version:u8(1) | filled:u8(1) | bump:u8(1) | _pad[5]`.
 */
export interface DecodedBalancesRoot {
  rootSlot: bigint;
  leaves: Uint8Array[];
  version: number;
  filled: number;
  bump: number;
}

export function decodeBalancesRoot(data: Buffer): DecodedBalancesRoot {
  let o = 8; // discriminator
  const rootSlot = data.readBigUInt64LE(o);
  o += 8;
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < ROOT_LEAVES; i++) {
    leaves.push(Uint8Array.from(data.subarray(o, o + 32)));
    o += 32;
  }
  const version = data.readUInt8(o);
  o += 1;
  const filled = data.readUInt8(o);
  o += 1;
  const bump = data.readUInt8(o);
  return { rootSlot, leaves, version, filled, bump };
}
