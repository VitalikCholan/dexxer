// test/codecs.test.ts — hand-written decoders (`src/lib/codecs.ts`) against
// accounts encoded by Anchor's own coder from the IDL (snake_case field
// names — the coder silently zero-fills unknown keys, see onboarding.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import { decodePosition, decodeUserAccount, ORDER_SLOTS } from '../src/lib/codecs'

const coder = new BorshAccountsCoder(DEXXER_CORE_IDL)

test('decodeUserAccount reads actions_left (u32) — the session budget set_session hands out', async () => {
  const buf = await coder.encode('UserAccount', {
    version: 2,
    owner: PublicKey.unique(),
    session_key: PublicKey.unique(),
    session_expiry: new BN(1_700_000_000),
    actions_left: 17,
    free_margin: new BN(5),
    locked_margin: new BN(0),
    nonce: new BN(0),
    last_withdraw_slot: new BN(0),
    exit_salt: Array(32).fill(1),
    bump: 255,
    exited: false,
  })
  const d = decodeUserAccount(buf)
  assert.equal(d.actionsLeft, 17)
  assert.equal(d.sessionExpiry, 1_700_000_000n)
  assert.equal(d.freeMargin, 5n)
})

const emptyOrder: Record<string, unknown> = {
  kind: { None: {} },
  side: { Long: {} },
  trigger: new BN(0),
  size: new BN(0),
  margin: new BN(0),
  trail_bps: 0,
  extreme: new BN(0),
  tp: new BN(0),
  sl: new BN(0),
}

test('decodePosition reads conditional orders at the offset Borsh actually writes them', async () => {
  const orders = Array.from({ length: ORDER_SLOTS }, () => ({ ...emptyOrder }))
  orders[1] = {
    ...emptyOrder,
    kind: { Limit: {} },
    side: { Short: {} },
    trigger: new BN(151_000_000),
    size: new BN(2_000_000_000),
    margin: new BN(30_000_000),
    tp: new BN(140_000_000),
    sl: new BN(160_000_000),
  }
  orders[3] = { ...emptyOrder, kind: { TrailingStop: {} }, trail_bps: 250, extreme: new BN(155_000_000) }
  const buf = await coder.encode('Position', {
    version: 1,
    owner: PublicKey.unique(),
    market: PublicKey.unique(),
    state: { Open: {} },
    side: { Long: {} },
    size: new BN(1_000_000_000),
    entry: new BN(150_000_000),
    margin: new BN(15_000_000),
    liq_price: new BN(142_000_000),
    opened_slot: new BN(77),
    liq_ticks: 0,
    oi_notional: new BN(150_000_000),
    closed: null,
    bump: 254,
    orders,
  })
  const d = decodePosition(buf)
  // Fields before the orders are unaffected by the appended array.
  assert.equal(d.state, 'Open')
  assert.equal(d.size, 1_000_000_000n)
  assert.equal(d.liqPrice, 142_000_000n)
  assert.equal(d.orders.length, 2)
  assert.deepEqual(d.orders[0], {
    slot: 1,
    kind: 'Limit',
    side: 'Short',
    trigger: 151_000_000n,
    size: 2_000_000_000n,
    margin: 30_000_000n,
    trailBps: 0,
    extreme: 0n,
    tp: 140_000_000n,
    sl: 160_000_000n,
  })
  assert.equal(d.orders[1].slot, 3)
  assert.equal(d.orders[1].kind, 'TrailingStop')
  assert.equal(d.orders[1].trailBps, 250)
  assert.equal(d.orders[1].extreme, 155_000_000n)
})

test('decodePosition tolerates a legacy Position without the orders array', async () => {
  const full = await coder.encode('Position', {
    version: 1,
    owner: PublicKey.unique(),
    market: PublicKey.unique(),
    state: { Open: {} },
    side: { Long: {} },
    size: new BN(0),
    entry: new BN(0),
    margin: new BN(0),
    liq_price: new BN(0),
    opened_slot: new BN(0),
    liq_ticks: 0,
    oi_notional: new BN(0),
    closed: null,
    bump: 1,
    orders: Array.from({ length: ORDER_SLOTS }, () => ({ ...emptyOrder })),
  })
  const legacy = full.subarray(0, full.length - ORDER_SLOTS * 52)
  assert.deepEqual(decodePosition(legacy).orders, [])
})
