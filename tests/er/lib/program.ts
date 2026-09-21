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

const IDL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "target", "idl");

function loadIdl(name: string): Idl {
  return JSON.parse(readFileSync(resolve(IDL_DIR, `${name}.json`), "utf8"));
}

export const DEXXER_CORE_IDL = loadIdl("dexxer_core");
export const MOCK_ORACLE_IDL = loadIdl("mock_oracle");
export const DEXXER_CORE_PROGRAM_ID = new PublicKey((DEXXER_CORE_IDL as { address: string }).address);
export const MOCK_ORACLE_PROGRAM_ID = new PublicKey((MOCK_ORACLE_IDL as { address: string }).address);

// Task 14 (crank-fallback): base58 `getProgramAccounts` memcmp filter value
// for the 8-byte Anchor discriminator of the `Position` account, computed
// from the same IDL used to build `dexxerCoreProgram` above (not hardcoded,
// so it stays correct if the account layout ever changes).
export const POSITION_DISC = bs58.encode(new BorshAccountsCoder(DEXXER_CORE_IDL).accountDiscriminator("Position"));

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
const POSITION_SEED = Buffer.from("position");
const DQ_SEED = Buffer.from("dq");
const FAUCET_SEED = Buffer.from("faucet");
const MINT_AUTH_SEED = Buffer.from("mint_auth");
const FEE_ESCROW_SEED = Buffer.from("fee_escrow");
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
  poolAta: (mint: PublicKey) => {
    const pool = pdas.pool(mint);
    return pda(
      [pool.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  },
  faucet: (owner: PublicKey) => pda([FAUCET_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  userAccount: (owner: PublicKey) => pda([USER_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  position: (owner: PublicKey, market: PublicKey) =>
    pda([POSITION_SEED, owner.toBuffer(), market.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  disclosureQueue: (owner: PublicKey) => pda([DQ_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  feed: (lazerFeedId: string) => pda([FEED_SEED, LAZER_SEED, Buffer.from(lazerFeedId)], MOCK_ORACLE_PROGRAM_ID),
  /** Same feed PDA derivation as `feed`, but under an arbitrary oracle program (Task 0: the real devnet Pricing Oracle, not `mock_oracle`). */
  feedUnder: (oracleProgram: PublicKey, lazerFeedId: string) => pda([FEED_SEED, LAZER_SEED, Buffer.from(lazerFeedId)], oracleProgram),
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
