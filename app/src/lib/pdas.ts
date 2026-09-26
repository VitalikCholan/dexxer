// app/src/lib/pdas.ts
//
// PDA derivation for `dexxer_core`, seeds copied verbatim from
// `tests/er/lib/program.ts` / `programs/dexxer_core/src/state/mod.rs` — do
// not guess these (CLAUDE.md). Plus `delegationTriple`, the
// buffer/record/metadata triple `#[delegate]` generates for a PDA owned by
// `dexxer_core`, needed by `delegate_user`'s accounts.
import { PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { DEXXER_CORE_PROGRAM_ID } from './anchor'
import { config } from './config'

const CONFIG_SEED = Buffer.from('config')
const MARKET_SEED = Buffer.from('market')
const RISK_SEED = Buffer.from('risk')
const POOL_SEED = Buffer.from('pool')
const USER_SEED = Buffer.from('user')
const POSITION_SEED = Buffer.from('position')
const DQ_SEED = Buffer.from('dq')
const FAUCET_SEED = Buffer.from('faucet')
const MINT_AUTH_SEED = Buffer.from('mint_auth')
const FEE_ESCROW_SEED = Buffer.from('fee_escrow')
// Week 4 (Task 1): private live pool counters — see programs/dexxer_core/src/state/pool_live.rs.
const POOL_LIVE_SEED = Buffer.from('pool_live')
// Week 3 (Task 9): seeds for the 13F/BalancesRoot pipeline, matching
// `programs/dexxer_core/src/state/mod.rs` and `tests/er/lib/program.ts`'s
// `pdas` verbatim.
const COMMIT_SEED = Buffer.from('commit')
const DISCLOSURE_SEED = Buffer.from('disclosure')
const BALANCES_ROOT_SEED = Buffer.from('balances_root')
// Week 5, Task 3: the MagicBlock Crank program's per-authority executor PDA.
// Pinned validator source is cited in `tests/er/lib/crank-signer.ts`.
const CRANK_EXECUTOR_SEED = Buffer.from('crank-executor')
const CRANK_PROGRAM_ID = new PublicKey('Crank11111111111111111111111111111111111111')
export const SOL_SYMBOL = Buffer.from([83, 79, 76, 0, 0, 0, 0, 0]) // b"SOL\0\0\0\0\0"

// mock_oracle / Pricing Oracle feed seeds, matching tests/er/lib/program.ts
// verbatim (both the local mock_oracle program and the real devnet Pricing
// Oracle derive their feed PDA the same way: [FEED_SEED, LAZER_SEED, id]).
const FEED_SEED = Buffer.from('price_feed')
const LAZER_SEED = Buffer.from('pyth-lazer')
/** SOL/USD Lazer feed id the devnet market was `init_market`'d with — matches `tests/er/lib/admin.ts`'s `LAZER_FEED_ID`. */
export const LAZER_FEED_ID = config.lazerFeedId

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/** Accepts either a 32-byte `Uint8Array`/`Buffer` or a hex string (with or without `0x`) — mirrors `tests/er/lib/program.ts`'s `hashSeed`. */
function hashSeed(hash: Uint8Array | string): Buffer {
  if (typeof hash === 'string') {
    const hex = hash.startsWith('0x') ? hash.slice(2) : hash
    const b = Buffer.from(hex, 'hex')
    if (b.length !== 32) throw new Error(`commitment hash must be 32 bytes, got ${b.length}`)
    return b
  }
  if (hash.length !== 32) throw new Error(`commitment hash must be 32 bytes, got ${hash.length}`)
  return Buffer.from(hash)
}

export const pdas = {
  config: () => pda([CONFIG_SEED], DEXXER_CORE_PROGRAM_ID),
  mintAuth: () => pda([MINT_AUTH_SEED], DEXXER_CORE_PROGRAM_ID),
  feeEscrow: () => pda([FEE_ESCROW_SEED], DEXXER_CORE_PROGRAM_ID),
  /**
   * `crank_signer_pda(feeEscrow)` — the signer the MagicBlock scheduler gives a
   * per-position `liquidation_check` tick (week 5, Task 3). Derived from the
   * task AUTHORITY, which is the `ScheduleTask` CPI payer: the `FeeEscrow` PDA.
   * Mirrors `tests/er/lib/crank-signer.ts` (which cites the pinned validator
   * source) and the program's own `liq_crank_signer`.
   */
  liqCrankSigner: () =>
    pda([CRANK_EXECUTOR_SEED, pdas.feeEscrow().toBuffer()], CRANK_PROGRAM_ID),
  market: () => pda([MARKET_SEED, SOL_SYMBOL], DEXXER_CORE_PROGRAM_ID),
  marketRisk: (market: PublicKey) => pda([RISK_SEED, market.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  pool: (mint: PublicKey) => pda([POOL_SEED, mint.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  /** Private live pool counters (week 4, Task 1) — every trading/money instruction writes here; `pool` above is a step-rounded snapshot written only by `commit_aggregate`. */
  poolLive: (mint: PublicKey) => pda([POOL_LIVE_SEED, mint.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  poolAta: (mint: PublicKey) => {
    const pool = pdas.pool(mint)
    return pda([pool.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)
  },
  faucet: (owner: PublicKey) => pda([FAUCET_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  userAccount: (owner: PublicKey) => pda([USER_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  position: (owner: PublicKey, market: PublicKey) =>
    pda([POSITION_SEED, owner.toBuffer(), market.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  disclosureQueue: (owner: PublicKey) => pda([DQ_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  /** Oracle feed PDA, derived under `oracleProgram` (`Config.oracle_program` — the real devnet Pricing Oracle, not `dexxer_core`). */
  feedUnder: (oracleProgram: PublicKey, lazerFeedId: string = LAZER_FEED_ID) =>
    pda([FEED_SEED, LAZER_SEED, Buffer.from(lazerFeedId)], oracleProgram),
  // Week 3 (Task 9/8b): 13F/BalancesRoot pipeline PDAs — History reads
  // `Disclosure`, Receipt reads `BalancesRoot`. Hash-seeded, not
  // nonce-seeded (ruling 9, Task 8b) — see tests/er/lib/program.ts's pdas.
  commitment: (hash: Uint8Array | string) => pda([COMMIT_SEED, hashSeed(hash)], DEXXER_CORE_PROGRAM_ID),
  disclosure: (hash: Uint8Array | string) => pda([DISCLOSURE_SEED, hashSeed(hash)], DEXXER_CORE_PROGRAM_ID),
  balancesRoot: () => pda([BALANCES_ROOT_SEED], DEXXER_CORE_PROGRAM_ID),
}

/** `#[delegate]`-generated buffer/record/metadata triple for a PDA owned by `dexxer_core`. */
export function delegationTriple(delegatedAccount: PublicKey) {
  return {
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(delegatedAccount, DEXXER_CORE_PROGRAM_ID),
    record: delegationRecordPdaFromDelegatedAccount(delegatedAccount),
    metadata: delegationMetadataPdaFromDelegatedAccount(delegatedAccount),
  }
}
