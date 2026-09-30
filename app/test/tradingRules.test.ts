// test/tradingRules.test.ts — the Trading rules rows (`src/features/trade/tradingRules.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tradingRules } from '../src/features/trade/tradingRules'
import type { TicketMarket } from '../src/features/trade/marketLimits'

// `MarketParams::sol_perp_defaults()` (tests/er/lib/admin.ts's MARKET_DEFAULTS), hysteresis 3 as on devnet.
const DEVNET: TicketMarket = {
  mark: 118_000_000n,
  maxLevBps: 100_000,
  imrBps: 1_000,
  mmrBps: 500,
  openFeeBps: 6,
  closeFeeBps: 6,
  minSize: 10_000_000n,
  maxPosition: 100_000_000_000n,
  oiCap: 0n,
  liqFeeBps: 100,
  maxStalenessSecs: 2,
  maxConfBps: 50,
  maxDeviationBps: 200,
  emaAlphaBps: 3_000,
  liqHysteresisTicks: 3,
  pausedOpen: false,
}

function flat(groups: ReturnType<typeof tradingRules>): Record<string, string> {
  return Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.label, r.value])))
}

test('tradingRules: devnet SOL-PERP parameters', () => {
  const r = flat(tradingRules(DEVNET, 38_700_000_000n))
  assert.equal(r['Max leverage'], '10×')
  assert.equal(r['Initial margin (IMR)'], '10%')
  assert.equal(r['Maintenance margin (MMR)'], '5%')
  assert.equal(r['Min position size'], '0.01 SOL')
  assert.equal(r['Max position size'], '$100,000 notional')
  assert.equal(r['OI cap, per side'], '30% of pool ≈ $11.6K')
  assert.equal(r['Open fee'], '0.06%')
  assert.equal(r['Liquidation fee'], '1%')
  assert.equal(r['Mark price'], 'EMA of index, α 30%')
  assert.equal(r['Liquidation'], 'At mark, 3 checks in a row')
  assert.equal(r['Max oracle staleness'], '2 s')
  assert.equal(r['Max oracle confidence'], '0.5%')
  assert.equal(r['Max mark–index deviation'], '2%')
  assert.equal(r['Opening'], 'Open')
  assert.equal(r['Pool snapshot rounding'], '100 dUSDC')
})

test('tradingRules: explicit OI cap, no snapshot yet, paused, confidence off', () => {
  const r = flat(tradingRules({ ...DEVNET, oiCap: 5_000_000_000n, pausedOpen: true, maxConfBps: 0 }, null))
  assert.equal(r['OI cap, per side'], '$5,000')
  assert.equal(r['Opening'], 'Paused')
  assert.equal(r['Max oracle confidence'], 'Not checked')
  assert.equal(flat(tradingRules(DEVNET, null))['OI cap, per side'], '30% of pool')
})
