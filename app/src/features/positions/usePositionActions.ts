// app/src/features/positions/usePositionActions.ts
//
// Session-key actions (no MWA prompt) for ONE market's slot. `market` is the
// registry entry of the selected card; `null` (unknown market, or nothing
// selected) makes every action a no-op. `mark` comes from the selected card's
// live public `Market` — the caller owns that single subscription.
import { useCallback, useMemo, useState } from 'react'
import { type Connection, type Keypair } from '@solana/web3.js'
import { showToast } from '@/src/ui/Toast'
import { describeTxError } from '@/src/lib/errors'
import * as math from '@/src/lib/math'
import { type MarketInfo } from '@/src/lib/markets'
import { type PositionSlot } from '@/src/lib/positions'
import {
  addMargin,
  closePosition,
  decreasePosition,
  increasePosition,
  solSize,
  tradeAccountsFor,
  U64_MAX,
  usdAmount,
  type BaseTradeAccounts,
} from '@/src/lib/trade'

export function usePositionActions(
  base: BaseTradeAccounts | null,
  conn: Connection | null,
  session: Keypair | null,
  market: MarketInfo | null,
  slot: PositionSlot | null,
  mark: bigint | null,
  onDone?: () => void,
) {
  const [busy, setBusy] = useState(false)
  const accounts = useMemo(() => (base && market ? tradeAccountsFor(base, market) : null), [base, market])

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(true)
      try {
        await fn()
        showToast({ tone: 'success', text: `${label} confirmed` })
        onDone?.()
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [onDone],
  )

  const close = useCallback(() => {
    if (!conn || !session || !accounts) return
    void run('Close', () => closePosition(conn, session, accounts))
  }, [conn, session, accounts, run])

  const increase = useCallback(
    (addSizeSol: number, addMarginUsd: number) => {
      if (!conn || !session || !accounts || !slot || mark === null) return Promise.resolve()
      const limit = math.openSlippageLimit(slot.side, mark)
      return run('Increase', () =>
        increasePosition(conn, session, accounts, solSize(addSizeSol), usdAmount(addMarginUsd), limit),
      )
    },
    [conn, session, accounts, slot, mark, run],
  )

  const decrease = useCallback(
    (closeSizeSol: number) => {
      if (!conn || !session || !accounts || !slot) return Promise.resolve()
      // Raw price units end to end (see trade.ts).
      const limitPrice =
        mark !== null ? math.closeSlippageLimit(slot.side, mark) : slot.side === 'Long' ? 0n : U64_MAX
      return run('Decrease', () => decreasePosition(conn, session, accounts, solSize(closeSizeSol), limitPrice))
    },
    [conn, session, accounts, slot, mark, run],
  )

  const addMarginTo = useCallback(
    (amount: bigint) => {
      if (!conn || !session || !accounts) return Promise.resolve()
      return run('Add margin', () => addMargin(conn, session, accounts, amount))
    },
    [conn, session, accounts, run],
  )

  return { close, increase, decrease, addMargin: addMarginTo, busy }
}
