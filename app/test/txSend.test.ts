// test/txSend.test.ts — owner-signed L1/ER send primitives (`src/lib/txSend.ts`),
// extracted from batchOnboarding.ts. The two behaviours measured on a live
// Phantom (24.09) had no test until now: a wallet prompt can outlive a
// blockhash (re-sign), and the durable-nonce path falls back to a live
// blockhash when the relayer cannot hand one out.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { baseConn } from '../src/lib/solana'
import { signOwnerL1, signWithLiveBlockhash, waitDelegated } from '../src/lib/txSend'

const BH = '11111111111111111111111111111111'
const owner = Keypair.generate()
const ix = () => SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: PublicKey.unique(), lamports: 1 })
/** Wallet stand-in: signs with `owner` and records how many prompts it took. */
function wallet() {
  let prompts = 0
  return {
    prompts: () => prompts,
    sign: async (tx: Transaction) => {
      prompts++
      tx.sign(owner)
      return tx
    },
  }
}

const originalFetch = globalThis.fetch
const originalGetAccountInfo = baseConn.getAccountInfo
afterEach(() => {
  globalThis.fetch = originalFetch
  ;(baseConn as { getAccountInfo: unknown }).getAccountInfo = originalGetAccountInfo
})

test('signWithLiveBlockhash: re-signs while the blockhash the wallet returned has expired, then succeeds', async () => {
  const validity = [false, false, true] // first two prompts outlive their blockhash
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: BH, lastValidBlockHeight: 1 }),
    isBlockhashValid: async () => ({ context: { slot: 1 }, value: validity.shift() ?? true }),
  }
  const w = wallet()
  const log: string[] = []
  const signed = await signWithLiveBlockhash(conn as never, owner.publicKey, [ix()], w.sign, (s) => log.push(s))
  assert.equal(w.prompts(), 3)
  assert.equal(signed.recentBlockhash, BH)
  assert.equal(log.filter((s) => s.includes('re-signing')).length, 2)
})

test('signWithLiveBlockhash: gives up after `attempts` expired signatures', async () => {
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: BH, lastValidBlockHeight: 1 }),
    isBlockhashValid: async () => ({ context: { slot: 1 }, value: false }),
  }
  const w = wallet()
  await assert.rejects(
    () => signWithLiveBlockhash(conn as never, owner.publicKey, [ix()], w.sign, undefined, 2),
    /kept expiring/,
  )
  assert.equal(w.prompts(), 2)
})

test('signOwnerL1: relayer nonce unavailable -> falls back to a live blockhash instead of failing the leg', async () => {
  globalThis.fetch = (async () => {
    throw new Error('relayer down')
  }) as typeof fetch
  ;(baseConn as { getLatestBlockhash: unknown }).getLatestBlockhash = async () => ({
    blockhash: BH,
    lastValidBlockHeight: 1,
  })
  ;(baseConn as { isBlockhashValid: unknown }).isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  const w = wallet()
  const signed = await signOwnerL1(owner.publicKey, owner.publicKey, [ix()], w.sign)
  assert.equal(signed.recentBlockhash, BH, 'signed on a live blockhash, not a nonce')
  assert.equal(signed.instructions.length, 1, 'no AdvanceNonceAccount prepended')
  assert.equal(w.prompts(), 1)
})

test('waitDelegated resolves once the account sits under the Delegation Program, and times out otherwise', async () => {
  const owners = [PublicKey.default, PublicKey.default, DELEGATION_PROGRAM_ID]
  ;(baseConn as { getAccountInfo: unknown }).getAccountInfo = async () => ({
    owner: owners.shift() ?? DELEGATION_PROGRAM_ID,
    data: Buffer.alloc(0),
    lamports: 1,
    executable: false,
  })
  const log: string[] = []
  await waitDelegated(PublicKey.unique(), 'UserAccount', (s) => log.push(s), 10, 1)
  assert.deepEqual(log, ['UserAccount delegated'])
  ;(baseConn as { getAccountInfo: unknown }).getAccountInfo = async () => null
  await assert.rejects(
    () => waitDelegated(PublicKey.unique(), 'Position', () => {}, 2, 1),
    /timeout waiting for Position/,
  )
})
