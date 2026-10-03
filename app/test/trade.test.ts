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
import { MAGIC_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { pdas } from '../src/lib/pdas'
import { POSITIONS_DISC, POSITIONS_SIZE } from '../src/lib/positions'
import {
  addMargin,
  cancelOrder,
  closePosition,
  decreasePosition,
  increasePosition,
  openPosition,
  placeOrder,
  tradeAccountsFor,
  U64_MAX,
  type TradeAccounts,
} from '../src/lib/trade'
import { assertIxKeysMatchIdl, type ExpectedKeys } from './ixAccounts.test'

const ixCoder = new BorshInstructionCoder(DEXXER_CORE_IDL)

/** Fake `Connection`: hands out a blockhash, captures the raw tx, confirms immediately; `getAccountInfo` serves `accountData`. */
function fakeConn(accountData: Buffer | null = null) {
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
      getAccountInfo: async () => (accountData ? { data: accountData } : null),
    },
  }
}

const owner = Keypair.generate().publicKey
const btc = pdas.marketFor('BTC')
const btcFeed = PublicKey.unique()
const base = {
  config: pdas.config(),
  poolLive: PublicKey.unique(),
  userAccount: pdas.userAccount(owner),
  positions: pdas.positions(owner),
  feeEscrow: pdas.feeEscrow(),
  magicProgram: MAGIC_PROGRAM_ID,
  liqCrankSigner: pdas.liqCrankSigner(),
}
const accounts: TradeAccounts = tradeAccountsFor(base, { market: btc, feed: btcFeed })

/** `Positions` bytes with one open slot on `market` (offsets: test/positions.test.ts). */
function positionsWith(market: PublicKey, side: 0 | 1): Buffer {
  const b = Buffer.alloc(POSITIONS_SIZE)
  Buffer.from(POSITIONS_DISC).copy(b, 0)
  owner.toBuffer().copy(b, 8)
  const at = 8 + 32 + 2 * 96 // slot index 2: the market is a field of the slot, not its index
  market.toBuffer().copy(b, at)
  b.writeBigUInt64LE(1_000_000_000n, at + 32)
  b.writeUInt8(1, at + 88)
  b.writeUInt8(side, at + 89)
  return b
}

test('tradeAccountsFor: market, its risk PDA and feed come from the market; taskContext is the Positions PDA', () => {
  assert.ok(accounts.market.equals(btc))
  assert.ok(accounts.marketRisk.equals(pdas.marketRisk(btc)))
  assert.ok(accounts.feed.equals(btcFeed))
  assert.ok(accounts.taskContext.equals(base.positions))
  assert.equal(Object.keys(accounts).length, 11, '11 accounts + signer = 12')
})

test('every trade instruction carries exactly the 12 IDL accounts, positions at 6 and taskContext = positions at 9', async () => {
  const session = Keypair.generate()
  const keys = {
    signer: session.publicKey,
    config: accounts.config,
    market: btc,
    market_risk: pdas.marketRisk(btc),
    pool_live: base.poolLive,
    user_account: base.userAccount,
    positions: base.positions,
    feed: btcFeed,
    fee_escrow: base.feeEscrow,
    task_context: base.positions,
    magic_program: MAGIC_PROGRAM_ID,
    liq_crank_signer: base.liqCrankSigner,
  }
  const names = ['open_position', 'close_position', 'increase_position', 'decrease_position', 'add_margin']
  const expected: ExpectedKeys = Object.fromEntries(names.map((n) => [n, keys]))
  const { conn, sent } = fakeConn(positionsWith(btc, 0))
  await openPosition(conn as never, session, accounts, 'long', 1n, 1n, 1n)
  await closePosition(conn as never, session, accounts)
  await increasePosition(conn as never, session, accounts, 1n, 1n, 1n)
  await decreasePosition(conn as never, session, accounts, 1n, 1n)
  await addMargin(conn as never, session, accounts, 1n)
  assert.equal(sent.length, 5)
  const seen = new Set<string>()
  for (const raw of sent) {
    const tx = Transaction.from(raw)
    assertIxKeysMatchIdl(tx, expected)
    const ix = tx.instructions[0]
    seen.add(ixCoder.decode(ix.data)!.name)
    assert.equal(ix.keys.length, 12)
    assert.ok(ix.keys[6].pubkey.equals(base.positions))
    assert.ok(ix.keys[9].pubkey.equals(base.positions))
  }
  assert.deepEqual([...seen].sort(), [...names].sort())
})

test("closePosition reads the side from THIS market's slot: a Short close gets the U64_MAX limit, a Long close 0", async () => {
  const short = fakeConn(positionsWith(btc, 1))
  await closePosition(short.conn as never, Keypair.generate(), accounts)
  assert.equal(lastIx(short.sent).args.limit_price, U64_MAX)
  const long = fakeConn(positionsWith(btc, 0))
  await closePosition(long.conn as never, Keypair.generate(), accounts)
  assert.equal(lastIx(long.sent).args.limit_price, 0n)
})

test("closePosition refuses a market without an open slot (another market's slot does not count)", async () => {
  const other = fakeConn(positionsWith(pdas.marketFor('ETH'), 1))
  await assert.rejects(() => closePosition(other.conn as never, Keypair.generate(), accounts), /no open position/)
  assert.equal(other.sent.length, 0)
})

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

test('placeOrder encodes an entry order with attached TP/SL, on the same 12 accounts as every trade ix', async () => {
  const { conn, sent } = fakeConn()
  await placeOrder(conn as never, Keypair.generate(), accounts, {
    kind: 'Limit',
    side: 'short',
    size: 1_250_000_000n,
    margin: 25_000_000n,
    trigger: 152_500_000n,
    tp: 140_000_000n,
    sl: 160_000_000n,
  })
  const ix = lastIx(sent)
  assert.equal(ix.name, 'place_order')
  assert.deepEqual(ix.args.kind, { Limit: {} })
  assert.deepEqual(ix.args.side, { Short: {} })
  assert.equal(ix.args.size, 1_250_000_000n)
  assert.equal(ix.args.margin, 25_000_000n)
  assert.equal(ix.args.trigger, 152_500_000n)
  assert.equal(ix.args.trail_bps, 0)
  assert.equal(ix.args.tp, 140_000_000n)
  assert.equal(ix.args.sl, 160_000_000n)
  const tx = Transaction.from(sent[sent.length - 1])
  assert.equal(tx.instructions[0].keys.length, 12)
  assert.ok(tx.instructions[0].keys[2].pubkey.equals(btc), 'the order is for the market in `accounts`')
})

test('placeOrder encodes a trailing stop by distance, not price', async () => {
  const { conn, sent } = fakeConn()
  await placeOrder(conn as never, Keypair.generate(), accounts, { kind: 'TrailingStop', trailBps: 300 })
  const ix = lastIx(sent)
  assert.deepEqual(ix.args.kind, { TrailingStop: {} })
  assert.equal(ix.args.trail_bps, 300)
  assert.equal(ix.args.trigger, 0n)
})

test('cancelOrder encodes the slot', async () => {
  const { conn, sent } = fakeConn()
  await cancelOrder(conn as never, Keypair.generate(), accounts, 2)
  const ix = lastIx(sent)
  assert.equal(ix.name, 'cancel_order')
  assert.equal(ix.args.slot, 2)
})
