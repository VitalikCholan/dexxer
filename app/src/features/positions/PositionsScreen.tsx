// app/src/features/positions/PositionsScreen.tsx
//
// Position slots: one `PositionCard` per OPEN slot of `Positions` (one live
// subscription for the screen). Only the selected card's public `Market` is
// subscribed (`mark`); actions/sheets act on that card, signed by the session key.
import { useMemo, useState } from 'react'
import { router } from 'expo-router'
import { Pressable, ScrollView } from 'react-native'
import { Page } from '@/src/ui/Page'
import { useTheme } from '@/src/theme'
import { Skeleton } from '@/src/ui/Skeleton'
import { EmptyState } from '@/src/ui/EmptyState'
import { useLiveAccount } from '@/src/lib/live'
import { decodeMarket, decodeUserAccount } from '@/src/lib/codecs'
import { decodePositions, ordersFor } from '@/src/lib/positions'
import { useMarkets } from '@/src/lib/markets'
import { PositionCard } from './PositionCard'
import { IncreaseSheet } from './IncreaseSheet'
import { DecreaseSheet } from './DecreaseSheet'
import { AddMarginSheet } from './AddMarginSheet'
import { OrderSheet } from './OrderSheet'
import { OrdersCard } from './OrdersCard'
import { displaySymbol, marketMatches, positionRows } from './positionRows'
import { usePositionActions } from './usePositionActions'
import { useTradeSession } from '../trade/useTradeSession'
import { useOnboardingGate } from '../onboard/useOnboardingGate'

export function PositionsScreen() {
  const { space } = useTheme()
  const { session, conn, base, loading, error: sessionError } = useTradeSession()
  const gate = useOnboardingGate()
  const markets = useMarkets()

  const positionsLive = useLiveAccount(conn, base?.positions ?? null, decodePositions)
  const userLive = useLiveAccount(conn, base?.userAccount ?? null, decodeUserAccount)
  const rows = useMemo(() => positionRows(positionsLive.value, markets.data ?? []), [positionsLive.value, markets.data])

  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [sheet, setSheet] = useState<'increase' | 'decrease' | 'margin' | 'order' | null>(null)
  const active = rows.find((r) => r.slot.index === activeIndex) ?? null

  // The active card's public `Market`, read live at the slot's own key (one subscriber; the registry is not involved).
  const marketLive = useLiveAccount(conn, active ? active.slot.market : null, decodeMarket)
  const liveMarket = active && marketMatches(active.slot.market, marketLive.value) ? marketLive.value : null
  const mark = liveMarket?.mark ?? null
  const mmrBps = BigInt(liveMarket?.mmrBps ?? active?.market?.params.mmrBps ?? 500)

  const actions = usePositionActions(base, conn, session, active, liveMarket)
  const submit =
    <A extends unknown[]>(fn: (...a: A) => Promise<boolean>) =>
    async (...a: A): Promise<void> => {
      if (await fn(...a)) setSheet(null)
    }

  let body
  if (loading) body = <Skeleton lines={5} />
  else if (gate.status === 'needs_setup')
    body = (
      <EmptyState
        text="Your private account isn't set up on this device yet."
        action={{ label: 'Set up private account', onPress: () => router.push('/onboard') }}
      />
    )
  else if (sessionError) body = <EmptyState text={sessionError} />
  else if (positionsLive.error) body = <EmptyState text={`Couldn't read your positions: ${positionsLive.error}`} />
  else if (positionsLive.missing)
    body = (
      <EmptyState
        text="Positions account not found for this wallet."
        action={{ label: 'Go to Onboarding', onPress: () => router.push('/onboard') }}
      />
    )
  else if (!positionsLive.value) body = <Skeleton lines={5} />
  else if (rows.length === 0)
    body = (
      <EmptyState text="No open positions" action={{ label: 'Go to Trade', onPress: () => router.push('/trade') }} />
    )
  else
    body = rows.map((r) => {
      const isActive = active?.slot.index === r.slot.index
      const choose = (s: typeof sheet) => {
        setActiveIndex(r.slot.index)
        setSheet(s)
      }
      return (
        <Pressable key={r.slot.index} onPress={() => setActiveIndex(r.slot.index)}>
          <PositionCard
            position={r.slot}
            symbol={displaySymbol(r, isActive ? liveMarket : null)}
            mark={isActive ? mark : null}
            busy={actions.busy}
            note={r.market || !markets.isSuccess ? undefined : 'Market not in the registry yet'}
            onClose={() => {
              setActiveIndex(r.slot.index)
              actions.requestClose(r)
            }}
            onIncrease={() => choose('increase')}
            onDecrease={() => choose('decrease')}
            onAddMargin={() => choose('margin')}
          />
          {isActive ? (
            <OrdersCard
              orders={ordersFor(positionsLive.value, r.slot.market)}
              busy={actions.busy}
              onAdd={() => setSheet('order')}
              onCancel={(slot) => void actions.cancel(slot)}
            />
          ) : null}
        </Pressable>
      )
    })

  return (
    <Page>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        {body}

        {active ? (
          <>
            <IncreaseSheet
              open={sheet === 'increase'}
              onClose={() => setSheet(null)}
              position={active.slot}
              symbol={displaySymbol(active, liveMarket)}
              markUsd={mark}
              mmrBps={mmrBps}
              busy={actions.busy}
              onSubmit={submit(actions.increase)}
            />
            <DecreaseSheet
              open={sheet === 'decrease'}
              onClose={() => setSheet(null)}
              position={active.slot}
              symbol={displaySymbol(active, liveMarket)}
              markUsd={mark}
              busy={actions.busy}
              onSubmit={submit(actions.decrease)}
            />
            <OrderSheet
              open={sheet === 'order'}
              onClose={() => setSheet(null)}
              position={active.slot}
              symbol={displaySymbol(active, liveMarket)}
              markUsd={mark}
              busy={actions.busy}
              onSubmit={submit(actions.place)}
            />
            <AddMarginSheet
              open={sheet === 'margin'}
              onClose={() => setSheet(null)}
              position={active.slot}
              symbol={displaySymbol(active, liveMarket)}
              freeMarginUsd={userLive.value?.freeMargin ?? null}
              mmrBps={mmrBps}
              busy={actions.busy}
              ready={liveMarket !== null}
              onSubmit={submit(actions.addMargin)}
            />
          </>
        ) : null}
      </ScrollView>
    </Page>
  )
}
