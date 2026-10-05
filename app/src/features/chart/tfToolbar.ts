// app/src/features/chart/tfToolbar.ts
//
// The chart toolbar's one row (05.10.2026): up to five pinned timeframes,
// a More button that opens all 16, and one chart-type button. Replaces the
// horizontally scrolled strip of all 16 + type chips, which ran off the
// screen. Pure, so it runs under `npm test`.
import { TIMEFRAMES, type Tf } from './timeframes'
import type { ChartType } from './chartData'

/** Five pins fit a 360 dp phone next to More and the chart-type button. */
export const MAX_PINNED_TFS = 5
export const DEFAULT_PINNED_TFS: Tf[] = ['1m', '15m', '1h', '4h', '24h']

function isTf(v: unknown): v is Tf {
  return typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v)
}

/** Canonical order (as in `TIMEFRAMES`), no repeats, at most five. */
function canonical(tfs: readonly Tf[]): Tf[] {
  return TIMEFRAMES.filter((t) => tfs.includes(t)).slice(0, MAX_PINNED_TFS)
}

/** Stored value → pins; anything that is not an array falls back to the defaults. */
export function parsePinnedTfs(v: unknown): Tf[] {
  if (!Array.isArray(v)) return DEFAULT_PINNED_TFS
  return canonical(v.filter(isTf))
}

/** Unpins a pinned timeframe; pins another one unless five are pinned already. */
export function togglePinnedTf(pinned: readonly Tf[], tf: Tf): Tf[] {
  if (pinned.includes(tf)) return pinned.filter((t) => t !== tf)
  if (pinned.length >= MAX_PINNED_TFS) return [...pinned]
  return canonical([...pinned, tf])
}

export interface TfRow {
  pills: readonly Tf[]
  /** An unpinned current timeframe is shown on the More button itself. */
  more: { label: string; active: boolean }
}

export function tfRow(pinned: readonly Tf[], current: Tf): TfRow {
  return {
    pills: pinned,
    more: pinned.includes(current) ? { label: 'More', active: false } : { label: current, active: true },
  }
}

export type ChartTypeGlyph = 'candles' | 'line' | 'area'

/** The chart-type button's icon: one of three shapes for the 12 types. */
export function chartTypeGlyph(t: ChartType): ChartTypeGlyph {
  switch (t) {
    case 'line':
    case 'lineMarkers':
    case 'step':
      return 'line'
    case 'area':
    case 'hlcArea':
    case 'baseline':
      return 'area'
    default:
      return 'candles'
  }
}
