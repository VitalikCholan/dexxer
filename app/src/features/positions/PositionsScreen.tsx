// app/src/features/positions/PositionsScreen.tsx
//
// Task 10: one open-position card (design: "one market, one position") with
// Close/Increase/Decrease, driven by `useTradeSession`'s session key — same
// no-MWA-prompt signing Trade already uses. `close_position`'s limit price
// uses the permissive sentinel (mirrors `TradeScreen`'s old inline Close);
// increase/decrease use `math.ts`'s slippage-limit helpers off the live mark.
import { useCallback, useState } from 'react'
import { router } from 'expo-router'
import { ScrollView } from 'react-native'
import { Page } from '@/src/ui/Page'
import { useTheme } from '@/src/theme'
import { Skeleton } from '@/src/ui/Skeleton'
import { EmptyState } from '@/src/ui/EmptyState'
import { showToast } from '@/src/ui/Toast'
import { useLiveAccount } from '@/src/lib/live'
import { decodeMarket, decodePosition } from '@/src/lib/codecs'
import { describeTxError } from '@/src/lib/errors'
import {
  cancelOrder,
  closePosition,
  decreasePosition,
  increasePosition,
  placeOrder,
  solSize,
  U64_MAX,
  usdAmount,
  type OrderParams,
} from '@/src/lib/trade'
import * as math from '@/src/lib/math'
import { PositionCard } from './PositionCard'
import { IncreaseSheet } from './IncreaseSheet'
import { DecreaseSheet } from './DecreaseSheet'
import { OrderSheet } from './OrderSheet'
import { OrdersCard } from './OrdersCard'
import { useTradeSession } from '../trade/useTradeSession'
import { useOnboardingGate } from '../onboard/useOnboardingGate'

export function PositionsScreen() {
  const { space } = useTheme()
  const { session, conn, accounts, loading, error: sessionError } = useTradeSession()
  const gate = useOnboardingGate()

  const positionLive = useLiveAccount(conn, accounts?.position ?? null, decodePosition)
  const marketLive = useLiveAccount(conn, accounts?.market ?? null, decodeMarket)

  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<'increase' | 'decrease' | 'order' | null>(null)

  const position = positionLive.value
  const mark = marketLive.value?.mark ?? null
  const mmrBps = marketLive.value ? BigInt(marketLive.value.mmrBps) : 500n

  const run = useCallback(async (label: string, fn: () => Promise<string>) => {
    setBusy(true)
    try {
      await fn()
      showToast({ tone: 'success', text: `${label} confirmed` })
      setSheet(null)
    } catch (e) {
      showToast({ tone: 'danger', text: describeTxError(e) })
    } finally {
      setBusy(false)
    }
  }, [])

  const handleClose = useCallback(() => {
    if (!conn || !session || !accounts) return
    void run('Close', () => closePosition(conn, session, accounts))
  }, [conn, session, accounts, run])

  const handleIncrease = useCallback(
    (addSizeSol: number, addMarginUsd: number) => {
      if (!conn || !session || !accounts || !position || mark === null) return Promise.resolve()
      const limit = math.openSlippageLimit(position.side, mark)
      return run('Increase', () =>
        increasePosition(conn, session, accounts, solSize(addSizeSol), usdAmount(addMarginUsd), limit),
      )
    },
    [conn, session, accounts, position, mark, run],
  )

  const handleDecrease = useCallback(
    (closeSizeSol: number) => {
      if (!conn || !session || !accounts || !position) return Promise.resolve()
      // Raw price units end to end — `Number(U64_MAX) / 1e6` used to come back as 2^64 (see trade.ts).
      const limitPrice =
        mark !== null ? math.closeSlippageLimit(position.side, mark) : position.side === 'Long' ? 0n : U64_MAX
      return run('Decrease', () => decreasePosition(conn, session, accounts, solSize(closeSizeSol), limitPrice))
    },
    [conn, session, accounts, position, mark, run],
  )

  const handlePlaceOrder = useCallback(
    (p: OrderParams) => {
      if (!conn || !session || !accounts) return Promise.resolve()
      return run('Order', () => placeOrder(conn, session, accounts, p))
    },
    [conn, session, accounts, run],
  )

  const handleCancelOrder = useCallback(
    (slot: number) => {
      if (!conn || !session || !accounts) return
      void run('Cancel', () => cancelOrder(conn, session, accounts, slot))
    },
    [conn, session, accounts, run],
  )

  const orders = position?.orders ?? []

  return (
    <Page>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        {loading ? (
          <Skeleton lines={5} />
        ) : gate.status === 'needs_setup' ? (
          <EmptyState
            text="Your private account isn't set up on this device yet."
            action={{ label: 'Set up private account', onPress: () => router.push('/onboard') }}
          />
        ) : sessionError ? (
          <EmptyState text={sessionError} />
        ) : !position || position.state !== 'Open' ? (
          orders.length === 0 ? (
            <EmptyState
              text="No open position"
              action={{ label: 'Go to Trade', onPress: () => router.push('/trade') }}
            />
          ) : null
        ) : (
          <PositionCard
            position={position}
            mark={mark}
            busy={busy}
            onClose={handleClose}
            onIncrease={() => setSheet('increase')}
            onDecrease={() => setSheet('decrease')}
          />
        )}

        {gate.status !== 'needs_setup' && !sessionError && (orders.length > 0 || position?.state === 'Open') ? (
          <OrdersCard
            orders={orders}
            busy={busy}
            onAdd={position?.state === 'Open' ? () => setSheet('order') : undefined}
            onCancel={handleCancelOrder}
          />
        ) : null}

        {position && position.state === 'Open' ? (
          <>
            <OrderSheet
              open={sheet === 'order'}
              onClose={() => setSheet(null)}
              position={position}
              markUsd={mark}
              busy={busy}
              onSubmit={handlePlaceOrder}
            />
            <IncreaseSheet
              open={sheet === 'increase'}
              onClose={() => setSheet(null)}
              position={position}
              markUsd={mark}
              mmrBps={mmrBps}
              busy={busy}
              onSubmit={handleIncrease}
            />
            <DecreaseSheet
              open={sheet === 'decrease'}
              onClose={() => setSheet(null)}
              position={position}
              markUsd={mark}
              busy={busy}
              onSubmit={handleDecrease}
            />
          </>
        ) : null}
      </ScrollView>
    </Page>
  )
}
