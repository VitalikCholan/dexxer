// test/trade.test.ts — the session-signed trade instructions (`src/lib/trade.ts`)
// take RAW program units (bigint: 1e9 size, 1e6 price/USD) and encode them
// exactly. Before week 6 they took floating `number`s and re-scaled inside,
// so a price that started as a bigint (mark, slippage limit, U64_MAX) went
// bigint -> number -> bigint on the way to the wire.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshInstructionCoder } from '@coral-xyz/anchor'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import {
  addMargin,
  decreasePosition,
  increasePosition,
  openPosition,
  U64_MAX,
  type TradeAccounts,
} from '../src/lib/trade'

const ixCoder = new BorshInstructionCoder(DEXXER_CORE_IDL)

/** Fake `Connection`: hands out a blockhash, captures the raw tx, confirms immediately. */
function fakeConn() {
  const sent: Buffer[] = []
  return {
    sent,
    conn: {
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
      sendRawTransaction: async (raw: Buffer) => {
        sent.push(Buffer.from(raw))
        return 'sig'
      },
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
      getAccountInfo: async () => null,
    },
  }
}

const accounts: TradeAccounts = Object.fromEntries(
  [
    'config',
    'market',
    'marketRisk',
    'poolLive',
    'userAccount',
    'position',
    'feed',
    'disclosureQueue',
    'feeEscrow',
    'taskContext',
    'magicProgram',
    'liqCrankSigner',
  ].map((k) => [k, PublicKey.unique()]),
) as unknown as TradeAccounts

/** Decode the only instruction of the last sent tx: `{ name, data }` with BN args as bigint. */
function lastIx(sent: Buffer[]) {
  const tx = Transaction.from(sent[sent.length - 1])
  assert.equal(tx.instructions.length, 1)
  const decoded = ixCoder.decode(tx.instructions[0].data)
  assert.ok(decoded, 'instruction decodes against the IDL')
  const args = Object.fromEntries(
    Object.entries(decoded.data as Record<string, unknown>).map(([k, v]) => [
      k,
      BN.isBN(v) ? BigInt((v as BN).toString()) : v,
    ]),
  )
  return { name: decoded.name, args }
}

test('openPosition encodes bigint size/margin/limit exactly', async () => {
  const { conn, sent } = fakeConn()
  await openPosition(conn as never, Keypair.generate(), accounts, 'long', 1_500_000_000n, 20_000_000n, 151_234_567n)
  const ix = lastIx(sent)
  assert.equal(ix.name, 'open_position')
  assert.equal(ix.args.size, 1_500_000_000n)
  assert.equal(ix.args.margin, 20_000_000n)
  assert.equal(ix.args.limit_price, 151_234_567n)
})

test('increasePosition encodes bigint args exactly', async () => {
  const { conn, sent } = fakeConn()
  await increasePosition(conn as never, Keypair.generate(), accounts, 250_000_000n, 5_000_001n, 149_999_999n)
  const ix = lastIx(sent)
  assert.equal(ix.name, 'increase_position')
  assert.equal(ix.args.add_size, 250_000_000n)
  assert.equal(ix.args.add_margin, 5_000_001n)
  assert.equal(ix.args.limit_price, 149_999_999n)
})

test('decreasePosition with the permissive Short limit encodes U64_MAX itself, not 2^64', async () => {
  // Through `Number(U64_MAX) / 1e6` and back, u64::MAX became 2^64 (one
  // past the largest u64) — the Short-decrease-without-mark path.
  const { conn, sent } = fakeConn()
  await decreasePosition(conn as never, Keypair.generate(), accounts, 100_000_000n, U64_MAX)
  const ix = lastIx(sent)
  assert.equal(ix.name, 'decrease_position')
  assert.equal(ix.args.close_size, 100_000_000n)
  assert.equal(ix.args.limit_price, U64_MAX)
})

test('addMargin encodes the bigint amount exactly', async () => {
  const { conn, sent } = fakeConn()
  await addMargin(conn as never, Keypair.generate(), accounts, 12_345_678n)
  const ix = lastIx(sent)
  assert.equal(ix.name, 'add_margin')
  assert.equal(ix.args.amount, 12_345_678n)
})
