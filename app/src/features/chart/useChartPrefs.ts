// app/src/features/chart/useChartPrefs.ts
//
// The chart's per-device preferences — chart type, pinned timeframes, log scale, EMA, positions on chart — in AsyncStorage. A viewer
// convenience only: a failed read or write falls back to the defaults and
// never blocks the chart.
import { useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { isChartType, type ChartType } from './chartData'
import { DEFAULT_PINNED_TFS, parsePinnedTfs } from './tfToolbar'
import type { Tf } from './timeframes'

const KEY = 'dexxer.chart.prefs.v1'

export interface ChartPrefs {
  type: ChartType
  /** Timeframes on the toolbar row; the rest are behind More. */
  pinnedTfs: Tf[]
  log: boolean
  ema: boolean
  positions: boolean
}

export const DEFAULT_PREFS: ChartPrefs = {
  type: 'candles',
  pinnedTfs: DEFAULT_PINNED_TFS,
  log: false,
  ema: false,
  positions: true,
}

/** Tolerant parse: anything unreadable or out of range falls back per field. */
export function parsePrefs(raw: string | null): ChartPrefs {
  if (!raw) return DEFAULT_PREFS
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof ChartPrefs, unknown>>
    return {
      type: isChartType(v.type) ? v.type : DEFAULT_PREFS.type,
      pinnedTfs: v.pinnedTfs === undefined ? DEFAULT_PREFS.pinnedTfs : parsePinnedTfs(v.pinnedTfs),
      log: typeof v.log === 'boolean' ? v.log : DEFAULT_PREFS.log,
      ema: typeof v.ema === 'boolean' ? v.ema : DEFAULT_PREFS.ema,
      positions: typeof v.positions === 'boolean' ? v.positions : DEFAULT_PREFS.positions,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function useChartPrefs(): [ChartPrefs, (patch: Partial<ChartPrefs>) => void] {
  const [prefs, setPrefs] = useState<ChartPrefs>(DEFAULT_PREFS)

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!cancelled) setPrefs(parsePrefs(raw))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  function update(patch: Partial<ChartPrefs>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
      return next
    })
  }

  return [prefs, update]
}
