// app/src/lib/marketStore.tsx
//
// `SelectedMarketProvider`: the state behind `markets.ts`'s
// `useSelectedMarket`. The symbol is persisted in AsyncStorage under
// `dexxer.market` — a viewer convenience only: a failed read or write keeps
// SOL and never blocks trading. A stored symbol the loaded registry does not
// list falls back to SOL (`resolveSymbol`). Must sit inside
// `QueryClientProvider` (it reads `useMarkets`).
import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_SYMBOL, resolveSymbol, SelectedMarketContext, useMarkets } from './markets'

const KEY = 'dexxer.market'

export function SelectedMarketProvider({ children }: PropsWithChildren) {
  const [stored, setStored] = useState<string>(DEFAULT_SYMBOL)
  const markets = useMarkets()

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!cancelled && raw) setStored(raw)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const setSymbol = useCallback((s: string) => {
    setStored(s)
    AsyncStorage.setItem(KEY, s).catch(() => {})
  }, [])

  const symbol = resolveSymbol(stored, markets.data)
  const value = useMemo(() => ({ symbol, setSymbol }), [symbol, setSymbol])
  return <SelectedMarketContext.Provider value={value}>{children}</SelectedMarketContext.Provider>
}
