// app/src/features/chart/useMarkTail.ts
//
// Marks seen since the last `/prices` fetch (spec §2.10.5). `useMark` holds
// only the LATEST mark; the chart needs every one of them between two
// candle fetches to keep `1s` (and the current bucket of any tf) live
// without hammering `/prices`. The tail is keyed by `symbol|resetStamp`
// (`resetStamp` = the candles query's `dataUpdatedAt`): a new fetch already
// contains these marks and another market's marks never belong, so a tail
// collected under a different key reads as empty in the same render.
import { useEffect, useState } from 'react'
import type { Mark } from '@/src/lib/indexer'
import { appendMark, tailForKey, type KeyedTail, type MarkPoint } from './chartData'

export function useMarkTail(mark: Mark | undefined, resetStamp: number, symbol: string): readonly MarkPoint[] {
  const key = `${symbol}|${resetStamp}`
  const [state, setState] = useState<KeyedTail>({ key, marks: [] })
  useEffect(() => {
    // Reconcile with the external mark stream / fetch clock, same
    // justification as `indexer.ts`'s `useIndexerWs` for this lint rule.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setState((prev) => ({ key, marks: appendMark(tailForKey(prev, key), mark, symbol) }))
  }, [mark, key, symbol])
  return tailForKey(state, key)
}
