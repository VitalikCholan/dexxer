// test/tradingRules.test.ts — the Trading rules rows (`src/features/trade/tradingRules.ts`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { SLOTS_FULL_TEXT, slotGate, tradingRules } from '../src/features/trade/tradingRules'
import { MAX_SLOTS, type DecodedPositions, type PositionSlot } from '../src/lib/positions'
import { DEXXER_ERROR_MESSAGES } from '../src/lib/errors'
import type { TicketMarket } from '../src/features/trade/marketLimits'

// `MarketParams::sol_perp_defaults()` (tests/er/lib/admin.ts's MARKET_DEFAULTS), hysteresis 2 (position slots).
const DEVNET: TicketMarket = {
  mark: 118_000_000n,
  maxLevBps: 100_000,
  imrBps: 1_000,
  mmrBps: 500,
  openFeeBps: 6,
  closeFeeBps: 6,
  symbol: 'SOL',
  feed: PublicKey.default,
  minSize: 10_000_000n,
  maxPosition: 100_000_000_000n,
  oiCap: 0n,
  liqFeeBps: 100,
  maxStalenessSecs: 2,
  maxConfBps: 50,
  maxDeviationBps: 200,
  emaAlphaBps: 3_000,
  liqHysteresisTicks: 2,
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
  assert.equal(r['Liquidation'], 'At mark, 2 checks in a row')
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

// --- the selected market's slot and the 16-slot gate (Review Focus 2 and 3) ---

const key = () => PublicKey.unique()
const slotOn = (market: PublicKey, index: number): PositionSlot => ({
  index,
  market,
  size: 1_000_000_000n,
  entry: 150_000_000n,
  margin: 20_000_000n,
  liqPrice: 140_000_000n,
  openedSlot: 1n,
  oiNotional: 150_000_000n,
  lastLiqSample: 0n,
  side: 'Long',
  liqTicks: 0,
})
const positionsWith = (slots: PositionSlot[]): DecodedPositions => ({
  owner: key(),
  slots,
  history: [],
  version: 1,
  bump: 1,
})

test('slotGate: a market without a slot gets no slot (Open, no Close), and switching markets never mixes slots', () => {
  const sol = key()
  const btc = key()
  const p = positionsWith([slotOn(sol, 3)])
  const onSol = slotGate(p, sol)
  assert.equal(onSol.slot?.index, 3)
  assert.equal(onSol.openBlocked, null)
  const onBtc = slotGate(p, btc)
  assert.equal(onBtc.slot, null, 'BTC must not show the SOL slot')
  assert.equal(onBtc.openCount, 1)
  assert.equal(onBtc.openBlocked, null)
  assert.deepEqual(slotGate(null, sol), { slot: null, openCount: 0, openBlocked: null })
})

test('slotGate: all 16 slots open blocks a new market before sending, with the 6049 text', () => {
  const markets = Array.from({ length: MAX_SLOTS }, key)
  const p = positionsWith(markets.map((m, i) => slotOn(m, i)))
  const fresh = slotGate(p, key())
  assert.equal(fresh.slot, null)
  assert.equal(fresh.openCount, 16)
  assert.equal(fresh.openBlocked, SLOTS_FULL_TEXT)
  assert.ok(SLOTS_FULL_TEXT.startsWith('All 16 position slots are in use'))
  assert.equal(SLOTS_FULL_TEXT, DEXXER_ERROR_MESSAGES[6049], 'same copy as the on-chain NoFreeSlot error')
  // A market that already has its slot is not blocked by the cap: Close and Positions still work.
  assert.equal(slotGate(p, markets[5]).openBlocked, null)
  assert.equal(slotGate(p, markets[5]).slot?.index, 5)
})

test('tradingRules: the size row uses the market symbol and the 16-market cap is listed', () => {
  const r = flat(tradingRules({ ...DEVNET, symbol: 'BTC', minSize: 100_000n }, null))
  assert.equal(r['Min position size'], '0.0001 BTC')
  assert.equal(r['Open markets at once'], '16')
})
