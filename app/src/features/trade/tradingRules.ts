// app/src/features/trade/tradingRules.ts
//
// C.7 "Trading rules": the rules of this market as the program enforces
// them, read from the public `Market` (plus the public `Pool` snapshot for
// the default OI cap). Grouped rows, pure so they run under `npm test`.
// Current open interest is not here — it lives in the private `MarketRisk`.
import { formatBps, formatCompactUsd, maxLeverage } from './headerStats'
import { type TicketMarket } from './marketLimits'

/** `state/mod.rs::SNAPSHOT_STEP` — the public `Pool` snapshot is rounded to this (100 dUSDC). */
export const SNAPSHOT_STEP = 100_000_000n
/** `risk::effective_oi_cap` when `Market.oi_cap == 0`: 30% of pool capital, per side. */
const DEFAULT_OI_CAP_BPS = 3_000n

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

function sol(raw: bigint): string {
  return `${(Number(raw) / 1e9).toString()} SOL`
}

export function tradingRules(m: TicketMarket, poolCapital: bigint | null): RuleGroup[] {
  const lev = maxLeverage(m.maxLevBps, m.imrBps)
  const oiCap =
    m.oiCap > 0n
      ? usd(m.oiCap)
      : poolCapital !== null
        ? `30% of pool ≈ ${formatCompactUsd((poolCapital * DEFAULT_OI_CAP_BPS) / 10_000n)}`
        : '30% of pool'
  return [
    {
      title: 'Leverage and margin',
      rows: [
        { label: 'Max leverage', value: `${lev}×` },
        { label: 'Initial margin (IMR)', value: formatBps(m.imrBps) },
        { label: 'Maintenance margin (MMR)', value: formatBps(m.mmrBps) },
        { label: 'Margin mode', value: 'Isolated' },
      ],
    },
    {
      title: 'Position limits',
      rows: [
        { label: 'Min position size', value: sol(m.minSize) },
        { label: 'Max position size', value: `${usd(m.maxPosition)} notional` },
        { label: 'OI cap, per side', value: oiCap },
        { label: 'Positions per market', value: '1' },
      ],
    },
    {
      title: 'Fees',
      rows: [
        { label: 'Open fee', value: formatBps(m.openFeeBps) },
        { label: 'Close fee', value: formatBps(m.closeFeeBps) },
        { label: 'Liquidation fee', value: formatBps(m.liqFeeBps) },
        { label: 'Funding / borrow rate', value: 'None' },
      ],
    },
    {
      title: 'Price and liquidation',
      rows: [
        { label: 'Index', value: 'Pyth Lazer' },
        { label: 'Mark price', value: `EMA of index, α ${formatBps(m.emaAlphaBps)}` },
        { label: 'Liquidation', value: `At mark, ${m.liqHysteresisTicks} checks in a row` },
        { label: 'Max oracle staleness', value: `${m.maxStalenessSecs} s` },
        { label: 'Max oracle confidence', value: m.maxConfBps > 0 ? formatBps(m.maxConfBps) : 'Not checked' },
        { label: 'Max mark–index deviation', value: formatBps(m.maxDeviationBps) },
      ],
    },
    {
      title: 'Market',
      rows: [
        { label: 'Opening', value: m.pausedOpen ? 'Paused' : 'Open' },
        { label: 'Settlement', value: 'dUSDC' },
        { label: 'Pool snapshot rounding', value: `${usd(SNAPSHOT_STEP).slice(1)} dUSDC` },
      ],
    },
  ]
}
