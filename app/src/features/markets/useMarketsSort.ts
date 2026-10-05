// app/src/features/markets/useMarketsSort.ts — the markets screen's sort, remembered on the device.
import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { parseSort, type MarketSort } from './marketList'

const KEY = 'dexxer.marketsSort'

export function useMarketsSort(): [MarketSort, (s: MarketSort) => void] {
  const [sort, setSort] = useState<MarketSort>('az')
  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => setSort(parseSort(raw)))
      .catch(() => {})
  }, [])
  const set = useCallback((s: MarketSort) => {
    setSort(s)
    AsyncStorage.setItem(KEY, s).catch(() => {})
  }, [])
  return [sort, set]
}
