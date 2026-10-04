import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  magicFeeVaultPdaFromValidator,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk'
import { exitMarkets, exitIx, type AccountPdas } from '../src/features/account/accountTx'
import type { DecodedPositions, HistoryRecord, PositionSlot } from '../src/lib/positions'
import { pdas } from '../src/lib/pdas'
import { baseConn, ER_VALIDATOR } from '../src/lib/solana'
import { assertIxKeysMatchIdl } from './ixAccounts.test'

const k = () => Keypair.generate().publicKey
const rec = (market: PublicKey): HistoryRecord => ({
  market,
  size: 1n,
  entry: 1n,
  exit: 1n,
  pnl: 0n,
  fees: 0n,
  openedSlot: 1n,
  closedSlot: 2n,
  side: 'Long',
  reason: 'User',
})
const slot = (market: PublicKey): PositionSlot => ({
  index: 0,
  market,
  size: 1n,
  entry: 1n,
  margin: 1n,
  liqPrice: 1n,
  openedSlot: 1n,
  oiNotional: 1n,
  lastLiqSample: 0n,
  side: 'Long',
  liqTicks: 0,
})

test('exitMarkets: SOL always, history and open-slot markets once each, at most 16', () => {
  const sol = k()
  const btc = k()
  const eth = k()
  const p: DecodedPositions = {
    owner: k(),
    slots: [slot(eth)],
    history: [rec(btc), rec(btc), rec(sol)],
    orders: [],
    ordersSupported: true,
    version: 1,
    bump: 1,
  }
  const out = exitMarkets(p, sol).map((m) => m.toBase58())
  assert.deepEqual(new Set(out), new Set([sol, btc, eth].map((m) => m.toBase58())))
  assert.equal(out.length, 3)
  assert.deepEqual(
    exitMarkets(null, sol).map((m) => m.toBase58()),
    [sol.toBase58()],
  )
  const many: DecodedPositions = {
    owner: k(),
    slots: [],
    history: Array.from({ length: 16 }, () => rec(k())),
    orders: [],
    ordersSupported: true,
    version: 1,
    bump: 1,
  }
  assert.equal(exitMarkets(many, sol).length, 16)
  assert.equal(exitMarkets(many, sol)[0].toBase58(), sol.toBase58(), 'SOL is never the one dropped')
})

test('exitMarkets: open slots first, then history newest first', () => {
  const sol = k()
  const open = k()
  const oldM = k()
  const newM = k()
  const p: DecodedPositions = {
    owner: k(),
    slots: [slot(open)],
    history: [rec(oldM), rec(newM)],
    orders: [],
    ordersSupported: true,
    version: 1,
    bump: 1,
  }
  assert.deepEqual(
    exitMarkets(p, sol).map((m) => m.toBase58()),
    [sol, open, newM, oldM].map((m) => m.toBase58()),
  )
})

test('exitIx: undelegate_user carries the 12 named accounts and the markets read-only after them', async () => {
  const owner = k()
  const userAccount = pdas.userAccount(owner)
  const positions = pdas.positions(owner)
  const feeEscrow = pdas.feeEscrow()
  const p = { owner, config: pdas.config(), userAccount, feeEscrow } as AccountPdas
  const markets = [k(), k(), k()]
  const ix = await exitIx(p, baseConn, positions, markets)
  // The helper compares exactly the IDL-named accounts, so check those on a markets-free build.
  const tx = new Transaction().add(await exitIx(p, baseConn, positions, []))
  assertIxKeysMatchIdl(tx, {
    undelegate_user: {
      owner,
      config: p.config,
      user_account: userAccount,
      positions,
      user_permission: permissionPdaFromAccount(userAccount),
      positions_permission: permissionPdaFromAccount(positions),
      ephemeral_vault: EPHEMERAL_VAULT_ID,
      permission_program: PERMISSION_PROGRAM_ID,
      fee_escrow: feeEscrow,
      magic_fee_vault: magicFeeVaultPdaFromValidator(ER_VALIDATOR),
      magic_context: MAGIC_CONTEXT_ID,
      magic_program: MAGIC_PROGRAM_ID,
    },
  })
  assert.equal(ix.keys.length, 12 + markets.length)
  assert.deepEqual(
    ix.keys.slice(0, 12).map((x) => x.pubkey.toBase58()),
    tx.instructions[0].keys.map((x) => x.pubkey.toBase58()),
  )
  ix.keys.slice(12).forEach((key, i) => {
    assert.ok(key.pubkey.equals(markets[i]))
    assert.equal(key.isWritable, false)
    assert.equal(key.isSigner, false)
  })
})

test('exitIx builds with no session: Positions PDA from the owner alone, markets from exitMarkets(null) = [SOL]', async () => {
  // AccountScreen's no-session-key path: no TEE read of `Positions` (value null),
  // the PDA derived from the owner — undelegate_user is owner-signed.
  const owner = k()
  const positions = pdas.positions(owner)
  const p = {
    owner,
    config: pdas.config(),
    userAccount: pdas.userAccount(owner),
    feeEscrow: pdas.feeEscrow(),
  } as AccountPdas
  const markets = exitMarkets(null, pdas.market())
  const ix = await exitIx(p, baseConn, positions, markets)
  assert.equal(ix.keys.length, 12 + 1)
  assert.ok(ix.keys[0].pubkey.equals(owner))
  assert.ok(ix.keys[3].pubkey.equals(positions))
  assert.ok(ix.keys[12].pubkey.equals(pdas.market()))
})

test('exitMarkets also names markets that only hold a pending order', () => {
  const sol = k()
  const orderOnly = k()
  const p: DecodedPositions = {
    owner: k(),
    slots: [],
    history: [],
    orders: [
      {
        slot: 0,
        market: orderOnly,
        kind: 'Limit',
        side: 'Long',
        trigger: 1n,
        size: 1n,
        margin: 1n,
        trailBps: 0,
        extreme: 0n,
        tp: 0n,
        sl: 0n,
      },
    ],
    ordersSupported: true,
    version: 1,
    bump: 1,
  }
  assert.deepEqual(
    exitMarkets(p, sol).map((m) => m.toBase58()),
    [sol, orderOnly].map((m) => m.toBase58()),
  )
})
