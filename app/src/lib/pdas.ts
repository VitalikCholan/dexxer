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
import { DEXXER_CORE_PROGRAM_ID } from './program'

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
export const SOL_SYMBOL = Buffer.from([83, 79, 76, 0, 0, 0, 0, 0]) // b"SOL\0\0\0\0\0"

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

export const pdas = {
  config: () => pda([CONFIG_SEED], DEXXER_CORE_PROGRAM_ID),
  mintAuth: () => pda([MINT_AUTH_SEED], DEXXER_CORE_PROGRAM_ID),
  feeEscrow: () => pda([FEE_ESCROW_SEED], DEXXER_CORE_PROGRAM_ID),
  market: () => pda([MARKET_SEED, SOL_SYMBOL], DEXXER_CORE_PROGRAM_ID),
  marketRisk: (market: PublicKey) => pda([RISK_SEED, market.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  pool: (mint: PublicKey) => pda([POOL_SEED, mint.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  poolAta: (mint: PublicKey) => {
    const pool = pdas.pool(mint)
    return pda([pool.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)
  },
  faucet: (owner: PublicKey) => pda([FAUCET_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  userAccount: (owner: PublicKey) => pda([USER_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  position: (owner: PublicKey, market: PublicKey) =>
    pda([POSITION_SEED, owner.toBuffer(), market.toBuffer()], DEXXER_CORE_PROGRAM_ID),
  disclosureQueue: (owner: PublicKey) => pda([DQ_SEED, owner.toBuffer()], DEXXER_CORE_PROGRAM_ID),
}

/** `#[delegate]`-generated buffer/record/metadata triple for a PDA owned by `dexxer_core`. */
export function delegationTriple(delegatedAccount: PublicKey) {
  return {
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(delegatedAccount, DEXXER_CORE_PROGRAM_ID),
    record: delegationRecordPdaFromDelegatedAccount(delegatedAccount),
    metadata: delegationMetadataPdaFromDelegatedAccount(delegatedAccount),
  }
}
