import { Connection } from '@solana/web3.js'

/**
 * Base L1 devnet connection (web3.js v1). Used for anything that reads or
 * writes L1 state directly (wallet balance, airdrops, settlement txs).
 *
 * Do not use this for ER/PER reads or writes — those go through the
 * MagicBlock Oracle / TEE RPC (see TEE_RPC below).
 */
export const baseConn = new Connection('https://rpc.magicblock.app/devnet', 'confirmed')

/**
 * MagicBlock PER (Intel TDX) TEE RPC endpoint for devnet. Ephemeral
 * position accounts live here, not on L1 — see docs/dexxer-architecture.md.
 */
export const TEE_RPC = 'https://devnet-tee.magicblock.app'
