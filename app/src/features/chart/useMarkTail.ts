// app/src/features/chart/useMarkTail.ts
//
// Marks seen since the last `/prices` fetch (spec §2.10.5). `useMark` holds
// only the LATEST mark; the chart needs every one of them between two
// candle fetches to keep `1s` (and the current bucket of any tf) live
// without hammering `/prices`. `resetStamp` is the candles query's
// `dataUpdatedAt`: a new fetch already contains these marks, so the tail
// restarts empty.
import { useEffect, useRef, useState } from 'react'
import type { Mark } from '@/src/lib/indexer'
import { appendMark, type MarkPoint } from './chartData'

export function useMarkTail(mark: Mark | undefined, resetStamp: number): readonly MarkPoint[] {
  const [tail, setTail] = useState<readonly MarkPoint[]>([])
  const stamp = useRef(resetStamp)
  useEffect(() => {
    // Reconcile with the external fetch clock, same justification as
    // `indexer.ts`'s `useIndexerWs` for this lint rule.
    if (stamp.current !== resetStamp) {
      stamp.current = resetStamp
      setTail([])
    }
  }, [resetStamp])
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setTail((prev) => appendMark(prev, mark))
  }, [mark])
  return tail
}
