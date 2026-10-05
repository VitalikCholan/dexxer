// test/ticketMath.test.ts — pure Trade-ticket math (`src/features/trade/ticketMath.ts`),
// extracted from the TradeTicket component so it runs without React Native.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertDeriveTicketSelfCheck,
  closeBlock,
  closePreview,
  deriveTicket,
  impliedLeverage,
  clampLeverage,
  liqAfterAddMargin,
  safeLiq,
  submitLabel,
} from '../src/features/trade/ticketMath'

test('deriveTicket vectors (the live-observed 00.00 repro and its neighbours)', () => assertDeriveTicketSelfCheck())

test('deriveTicket: available unknown never blocks; margin still derived', () => {
  const d = deriveTicket({ sizeSol: 1, leverage: 2, markUsd: 100_000_000n, available: null })
  assert.deepEqual(d, { marginUsd: '50.00', insufficient: false })
})

// MAX button: margin = everything available -> the smallest integer leverage
// (1..10) whose derived margin does not exceed it. Ceil so the pool-favouring
// round-up in `marginForLeverage` lands at-or-under `available`, not over.
test('impliedLeverage: exact division', () => {
  assert.equal(impliedLeverage(200_000_000n, 100_000_000n), 2)
})
test('impliedLeverage: any remainder rounds up', () => {
  assert.equal(impliedLeverage(200_000_001n, 100_000_000n), 3)
})
test('impliedLeverage clamps to [1, 10]', () => {
  assert.equal(impliedLeverage(50_000_000n, 100_000_000n), 1)
  assert.equal(impliedLeverage(5_000_000_000n, 100_000_000n), 10)
})
test('impliedLeverage with nothing available is 1, not a division by zero', () => {
  assert.equal(impliedLeverage(200_000_000n, 0n), 1)
})

test('safeLiq returns null instead of throwing when leverage is below 1x', () => {
  // margin > notional: math.liqPrice throws InvalidInput; the ticket shows '—'.
  assert.equal(safeLiq('Long', 100_000_000n, 1_000_000_000n, 200_000_000n, 500n), null)
  assert.equal(safeLiq('Long', 150_000_000n, 10_000_000_000n, 150_000_000n, 500n), 142_500_000n)
})

test('closeBlock: decrease_position requires, incl. the min_size remainder', () => {
  const MIN = 10_000_000n
  assert.equal(closeBlock(0n, 1_000_000_000n, MIN), 'no_size')
  assert.equal(closeBlock(1_000_000_001n, 1_000_000_000n, MIN), 'exceeds')
  assert.equal(closeBlock(995_000_000n, 1_000_000_000n, MIN), 'remainder_below_min')
  assert.equal(closeBlock(990_000_000n, 1_000_000_000n, MIN), null)
  assert.equal(closeBlock(1_000_000_000n, 1_000_000_000n, MIN), null, 'a full close has no remainder')
})

test('closePreview: PnL truncates like math.rs::upnl, margin released floors', () => {
  const MARK = 150_000_000n
  assert.deepEqual(closePreview('Long', 1_000_000_000n, 2_000_000_000n, MARK, 30_000_001n, 160_000_000n, 6n), {
    pnl: 10_000_000n,
    fee: 96_000n,
    released: 15_000_000n,
  })
  assert.equal(closePreview('Short', 1_000_000_000n, 1_000_000_000n, MARK, 1n, 160_000_000n, 6n).pnl, -10_000_000n)
  assert.equal(closePreview('Long', 1n, 1n, MARK, 1n, MARK + 999_999n, 0n).pnl, 0n)
})

test('liqAfterAddMargin moves a Long liq down, and has none at or below 1x', () => {
  const MARK = 150_000_000n
  const size = 10_000_000_000n // 10 SOL @ $150 = $1500
  const after = liqAfterAddMargin('Long', MARK, size, 150_000_000n, 150_000_000n, 500n)!
  assert.ok(after < 142_500_000n)
  assert.equal(liqAfterAddMargin('Long', MARK, size, 150_000_000n, 1_400_000_000n, 500n), null)
})

// Plan-4 smoke (01.10.2026): HYPE/ZEC allow 5×, the slider offered 7–10× and the
// program answered InsufficientMargin (6010). MAX and the slider must respect the
// market's cap.
test('impliedLeverage clamps to the market cap when one is given', () => {
  assert.equal(impliedLeverage(5_000_000_000n, 100_000_000n, 5), 5)
  assert.equal(impliedLeverage(300_000_000n, 100_000_000n, 5), 3)
  assert.equal(impliedLeverage(5_000_000_000n, 100_000_000n, 10), 10)
})
test('clampLeverage keeps a picked leverage inside [1, maxLev]', () => {
  assert.equal(clampLeverage(7, 5), 5)
  assert.equal(clampLeverage(3, 5), 3)
  assert.equal(clampLeverage(0, 5), 1)
  assert.equal(clampLeverage(10, 10), 10)
  assert.equal(clampLeverage(4.6, 10), 5)
})

test('submitLabel: names the market on every entry; busy wins', () => {
  assert.equal(submitLabel({ busy: false, orderType: 'market', side: 'long', symbol: 'ETH' }), 'Open Long ETH')
  assert.equal(submitLabel({ busy: false, orderType: 'market', side: 'short', symbol: 'BTC' }), 'Open Short BTC')
  assert.equal(submitLabel({ busy: false, orderType: 'limit', side: 'short', symbol: 'BTC' }), 'Place Limit Short BTC')
  assert.equal(submitLabel({ busy: false, orderType: 'stop', side: 'long', symbol: 'SOL' }), 'Place Stop Long SOL')
  assert.equal(
    submitLabel({ busy: true, orderType: 'market', side: 'long', symbol: 'ETH' }),
    'Signing with session key…',
  )
})
