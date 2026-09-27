// test/ticketMath.test.ts — pure Trade-ticket math (`src/features/trade/ticketMath.ts`),
// extracted from the TradeTicket component so it runs without React Native.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertDeriveTicketSelfCheck, deriveTicket, impliedLeverage, safeLiq } from '../src/features/trade/ticketMath'

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
