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
import { decodePositions } from '@/src/lib/positions'
import { useMarkets } from '@/src/lib/markets'
import { PositionCard } from './PositionCard'
import { IncreaseSheet } from './IncreaseSheet'
import { DecreaseSheet } from './DecreaseSheet'
import { AddMarginSheet } from './AddMarginSheet'
import { positionRows } from './positionRows'
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

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [sheet, setSheet] = useState<'increase' | 'decrease' | 'margin' | null>(null)
  const selected = rows.find((r) => r.slot.index === selectedIndex) ?? null

  // The selected card's market, read live for `mark` (one subscriber, not one per card).
  const marketLive = useLiveAccount(conn, selected?.market ? selected.slot.market : null, decodeMarket)
  const mark = marketLive.value?.mark ?? null
  const mmrBps = BigInt(marketLive.value?.mmrBps ?? selected?.market?.params.mmrBps ?? 500)

  const actions = usePositionActions(base, conn, session, selected?.market ?? null, selected?.slot ?? null, mark, () =>
    setSheet(null),
  )

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
        ) : rows.length === 0 ? (
          <EmptyState text="No open positions" action={{ label: 'Go to Trade', onPress: () => router.push('/trade') }} />
        ) : (
          rows.map((r) => {
            const isSel = selected?.slot.index === r.slot.index
            const choose = (s: typeof sheet) => {
              setSelectedIndex(r.slot.index)
              setSheet(s)
            }
            return (
              <Pressable key={r.slot.index} onPress={() => setSelectedIndex(r.slot.index)}>
                <PositionCard
                  position={r.slot}
                  symbol={r.symbol}
                  mark={isSel && r.market ? mark : null}
                  busy={actions.busy}
                  note={r.market ? undefined : 'Market not in the registry yet'}
                  // A card is closed only once expanded (mark visible); the first tap selects it.
                  onClose={() => (isSel ? actions.close() : choose(null))}
                  onIncrease={() => choose('increase')}
                  onDecrease={() => choose('decrease')}
                  onAddMargin={() => choose('margin')}
                />
              </Pressable>
            )
          })
        )}

        {selected?.market ? (
          <>
            <IncreaseSheet
              open={sheet === 'increase'}
              onClose={() => setSheet(null)}
              position={selected.slot}
              symbol={selected.symbol}
              markUsd={mark}
              mmrBps={mmrBps}
              busy={actions.busy}
              onSubmit={actions.increase}
            />
            <DecreaseSheet
              open={sheet === 'decrease'}
              onClose={() => setSheet(null)}
              position={selected.slot}
              symbol={selected.symbol}
              markUsd={mark}
              busy={actions.busy}
              onSubmit={actions.decrease}
            />
            <AddMarginSheet
              open={sheet === 'margin'}
              onClose={() => setSheet(null)}
              position={selected.slot}
              symbol={selected.symbol}
              freeMarginUsd={userLive.value?.freeMargin ?? null}
              mmrBps={mmrBps}
              busy={actions.busy}
              onSubmit={actions.addMargin}
            />
          </>
        ) : null}
      </ScrollView>
    </Page>
  )
}
