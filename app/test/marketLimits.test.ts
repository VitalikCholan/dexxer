// test/marketLimits.test.ts — `decodeTicketMarket` reads a `Market` encoded
// by the IDL's own Borsh coder, so its fixed offsets track the IDL. Every
// field gets a distinct value, so a shifted offset reads the wrong one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { DEXXER_CORE_IDL } from '../src/lib/anchor'
import { decodeTicketMarket } from '../src/features/trade/marketLimits'

test('decodeTicketMarket: every public Market parameter, plus the shared decodeMarket fields', async () => {
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
    oi_cap: new BN(5_000_000_000),
    max_position: new BN('100000000000'),
    min_size: new BN(10_000_000),
    max_staleness_secs: new BN(7),
    max_conf_bps: 51,
    max_deviation_bps: 202,
    mark: new BN(151_234_567),
    mark_slot: new BN(42),
    last_print: new BN(9),
    sample_seq: new BN(4),
    ema_alpha_bps: 3_003,
    liq_hysteresis_ticks: 3,
    max_stale_ticks: 30,
    paused_open: true,
    stale_ticks: 0,
    bump: 255,
  })
  const m = decodeTicketMarket(data)
  assert.equal(m.minSize, 10_000_000n)
  assert.equal(m.liqFeeBps, 123)
  assert.equal(m.maxPosition, 100_000_000_000n)
  assert.equal(m.oiCap, 5_000_000_000n)
  assert.equal(m.maxStalenessSecs, 7)
  assert.equal(m.maxConfBps, 51)
  assert.equal(m.maxDeviationBps, 202)
  assert.equal(m.emaAlphaBps, 3_003)
  assert.equal(m.liqHysteresisTicks, 3)
  assert.equal(m.pausedOpen, true)
  assert.equal(m.mark, 151_234_567n)
  assert.equal(m.mmrBps, 500)
  assert.equal(m.closeFeeBps, 7)
})
