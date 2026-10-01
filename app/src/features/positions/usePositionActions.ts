// app/src/features/positions/usePositionActions.ts
//
// Session-key actions (no MWA prompt) on ONE row (the active card). Accounts
// come from the row's own live public `Market` (`controlTarget`) — the relayer
// registry is not involved, so every open slot is controllable. `close` is a
// pending action: it runs as soon as the active row's Market has delivered.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Connection, type Keypair } from '@solana/web3.js'
import { showToast } from '@/src/ui/Toast'
import { describeTxError } from '@/src/lib/errors'
import * as math from '@/src/lib/math'
import { type DecodedMarket } from '@/src/lib/codecs'
import {
  addMargin,
  closePosition,
  decreasePosition,
  increasePosition,
  solSize,
  tradeAccountsFor,
  usdAmount,
  type BaseTradeAccounts,
} from '@/src/lib/trade'
import { controlTarget, isCloseStale, shouldFireClose, type PendingClose, type PositionRow } from './positionRows'

export function usePositionActions(
  base: BaseTradeAccounts | null,
  conn: Connection | null,
  session: Keypair | null,
  row: PositionRow | null,
  market: DecodedMarket | null,
) {
  const [busy, setBusy] = useState(false)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const accounts = useMemo(() => {
    const target = row ? controlTarget(row, market) : null
    return base && target ? tradeAccountsFor(base, target) : null
  }, [base, row, market])
  const mark = accounts && market ? market.mark : null
  const side = row?.slot.side ?? null

  /** Resolves `true` when the transaction confirmed (errors are toasted, not thrown). */
  const run = useCallback(async (label: string, fn: () => Promise<string>): Promise<boolean> => {
    setBusy(true)
    try {
      await fn()
      showToast({ tone: 'success', text: `${label} confirmed` })
      return true
    } catch (e) {
      showToast({ tone: 'danger', text: describeTxError(e) })
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (pendingClose === null) return
    if (isCloseStale(pendingClose, row)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingClose(null)
      return
    }
    if (busy || !conn || !session || !accounts || !shouldFireClose(pendingClose, row, market)) return
    setPendingClose(null)
    void run('Close', () => closePosition(conn, session, accounts))
  }, [pendingClose, row, market, busy, conn, session, accounts, run])

  const requestClose = useCallback(
    (target: PositionRow) => setPendingClose({ index: target.slot.index, market: target.slot.market }),
    [],
  )

  const increase = useCallback(
    async (addSizeSol: number, addMarginUsd: number) => {
      if (!conn || !session || !accounts || !side || mark === null) return false
      const limit = math.openSlippageLimit(side, mark)
      return run('Increase', () =>
        increasePosition(conn, session, accounts, solSize(addSizeSol), usdAmount(addMarginUsd), limit),
      )
    },
    [conn, session, accounts, side, mark, run],
  )

  const decrease = useCallback(
    async (closeSizeSol: number) => {
      if (!conn || !session || !accounts || !side || mark === null) return false
      const limitPrice = math.closeSlippageLimit(side, mark)
      return run('Decrease', () => decreasePosition(conn, session, accounts, solSize(closeSizeSol), limitPrice))
    },
    [conn, session, accounts, side, mark, run],
  )

  const addMarginTo = useCallback(
    async (amount: bigint) => {
      if (!conn || !session || !accounts) return false
      return run('Add margin', () => addMargin(conn, session, accounts, amount))
    },
    [conn, session, accounts, run],
  )

  return { requestClose, increase, decrease, addMargin: addMarginTo, busy, ready: accounts !== null }
}
