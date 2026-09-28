// test/marketLimits.test.ts — `decodeTicketMarket` reads a `Market` encoded
// by the IDL's own Borsh coder, so its fixed `min_size` offset tracks the IDL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import { decodeTicketMarket } from '../src/features/trade/marketLimits'

test('decodeTicketMarket: min_size, liq_fee_bps plus the shared decodeMarket fields', async () => {
  const data = await new BorshAccountsCoder(DEXXER_CORE_IDL).encode('Market', {
    version: 1,
    symbol: [...Buffer.from('SOL-PERP')],
    feed: PublicKey.unique(),
    max_lev_bps: 100_000,
    imr_bps: 1_000,
    mmr_bps: 500,
    open_fee_bps: 6,
    close_fee_bps: 7,
    liq_fee_bps: 123,
    oi_cap: new BN(0),
    max_position: new BN('100000000000'),
    min_size: new BN(10_000_000),
    max_staleness_secs: new BN(2),
    max_conf_bps: 50,
    max_deviation_bps: 200,
    mark: new BN(151_234_567),
    mark_slot: new BN(42),
    ema_alpha_bps: 3_000,
    liq_hysteresis_ticks: 3,
    max_stale_ticks: 30,
    paused_open: false,
    stale_ticks: 0,
    bump: 255,
  })
  const m = decodeTicketMarket(data)
  assert.equal(m.minSize, 10_000_000n)
  assert.equal(m.liqFeeBps, 123)
  assert.equal(m.mark, 151_234_567n)
  assert.equal(m.mmrBps, 500)
  assert.equal(m.closeFeeBps, 7)
})
