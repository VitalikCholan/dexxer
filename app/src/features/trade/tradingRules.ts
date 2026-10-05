// app/src/features/trade/tradingRules.ts
//
// C.7 "Trading rules": the rules of this market a trader acts on, read from
// the public `Market`. Grouped rows, pure so they run under `npm test`.
// Trimmed 05.10.2026: no pool figures (OI cap as a share of the pool), no
// oracle vendor or tuning (EMA α, staleness, confidence, deviation) — the
// program still enforces them, the trader does not act on them. Current open
// interest is not here either — it lives in the private `MarketRisk`.
import { type PublicKey } from '@solana/web3.js'
import { DEXXER_ERROR_MESSAGES } from '@/src/lib/errors'
import { MAX_SLOTS, slotFor, type DecodedPositions, type PositionSlot } from '@/src/lib/positions'
import { formatBps, maxLeverage } from './headerStats'
import { type TicketMarket } from './marketLimits'

export interface RuleRow {
  label: string
  value: string
}
export interface RuleGroup {
  title: string
  rows: RuleRow[]
}

/** Raw 1e6 -> `$100,000` (whole dollars, grouped). */
function usd(raw: bigint): string {
  return `$${(Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function size(raw: bigint, symbol: string): string {
  return `${(Number(raw) / 1e9).toString()} ${symbol}`
}

/** What Trade shows instead of sending an open that would fail: the same copy as the on-chain `NoFreeSlot` (6049). */
export const SLOTS_FULL_TEXT = DEXXER_ERROR_MESSAGES[6049]

export interface SlotGate {
  /** The selected market's own slot — never another market's. */
  slot: PositionSlot | null
  /** Open slots across all markets. */
  openCount: number
  /** Why Open is blocked BEFORE sending, or null: all 16 slots are taken and none is this market's. */
  openBlocked: string | null
}

/** The selected market's slot and the 16-slot gate — `open_position` takes the first empty slot and fails with 6049 when none is left. */
export function slotGate(p: DecodedPositions | null, market: PublicKey): SlotGate {
  const slot = slotFor(p, market)
  const openCount = p?.slots.length ?? 0
  const full = openCount >= MAX_SLOTS && slot === null
  return { slot, openCount, openBlocked: full ? SLOTS_FULL_TEXT : null }
}

export function tradingRules(m: TicketMarket): RuleGroup[] {
  const lev = maxLeverage(m.maxLevBps, m.imrBps)
  return [
    {
      title: 'Leverage and margin',
      rows: [
        { label: 'Max leverage', value: `${lev}×` },
        { label: 'Initial margin (IMR)', value: formatBps(m.imrBps) },
        { label: 'Maintenance margin (MMR)', value: formatBps(m.mmrBps) },
        { label: 'Margin mode', value: 'Isolated' },
        { label: 'Collateral', value: 'dUSDC' },
      ],
    },
    {
      title: 'Position limits',
      rows: [
        { label: 'Min position size', value: size(m.minSize, m.symbol) },
        { label: 'Max position size', value: `${usd(m.maxPosition)} notional` },
        { label: 'Open markets at once', value: String(MAX_SLOTS) },
      ],
    },
    {
      title: 'Fees and liquidation',
      rows: [
        { label: 'Open fee', value: formatBps(m.openFeeBps) },
        { label: 'Close fee', value: formatBps(m.closeFeeBps) },
        { label: 'Liquidation fee', value: formatBps(m.liqFeeBps) },
        { label: 'Funding / borrow rate', value: 'None' },
        { label: 'Liquidation', value: 'At mark price' },
      ],
    },
  ]
}
