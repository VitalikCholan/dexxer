// app/src/features/trade/ChartSection.tsx
//
// C.6-A "Perpetual Chart · Show/Hide": the chart (C.5 `TradingChart`, with
// its own timeframe / type toolbar) behind a one-line toggle, so the ticket
// can sit higher on the screen when the chart is not needed. Open by
// default — the screen looked like that before; collapsing is per visit
// (plain state, not persisted). C.7: a Chart / Token information / Trading
// rules switch in the same row (`/assets/:symbol` feeds the middle tab).
import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { linkPressStyle, useTextLinkHitSlop, useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { type PositionSlot } from '@/src/lib/positions'
import { type TicketMarket } from './marketLimits'
import { TokenInfoPanel } from './TokenInfoPanel'
import { TradingRulesPanel } from './TradingRulesPanel'
import { TradingChart } from '../chart/TradingChart'
import { type Tf } from '../chart/chartData'

export type { Tf }

export interface ChartSectionProps {
  /** Selected market symbol — the chart's candles. */
  symbol: string
  tf: Tf
  onTfChange: (tf: Tf) => void
  /** The selected market's slot, for the entry / liq lines. */
  position: PositionSlot | null
  market: TicketMarket | null
  /** Latest public `Pool.capital_total`, raw 1e6 — for the default OI cap. */
  poolCapital: bigint | null
}

export function ChartSection({ symbol, tf, onTfChange, position, market, poolCapital }: ChartSectionProps) {
  const { colors, space } = useTheme()
  const micro = useTextStyle('micro')
  const toggleHitSlop = useTextLinkHitSlop(micro)
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'chart' | 'token' | 'rules'>('chart')

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {/* Scrolls instead of pushing the Hide/Show toggle off-screen on narrow phones. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
          <Segment
            compact
            value={tab}
            onChange={(t) => {
              setTab(t)
              setOpen(true)
            }}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'token', label: 'Token info' },
              { value: 'rules', label: 'Trading rules' },
            ]}
          />
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          hitSlop={toggleHitSlop}
          style={linkPressStyle}
        >
          <Text style={[micro, { color: colors.accent }]}>{open ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      {!open ? null : tab === 'chart' ? (
        <TradingChart symbol={symbol} tf={tf} onTfChange={onTfChange} position={position} />
      ) : tab === 'token' ? (
        // Re-keyed per market: a switch never shows the previous asset's text.
        <TokenInfoPanel key={symbol} symbol={symbol} />
      ) : (
        <TradingRulesPanel market={market} poolCapital={poolCapital} />
      )}
    </View>
  )
}
