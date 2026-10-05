// app/src/features/trade/ChartSection.tsx
//
// C.6-A "Perpetual Chart · Show/Hide": the chart (C.5 `TradingChart`, with
// its own timeframe / type toolbar) behind a one-line toggle, so the ticket
// can sit higher on the screen when the chart is not needed. Open by
// default — the screen looked like that before; collapsing is per visit
// (plain state, not persisted). C.7: a Chart / Info switch in the same row —
// Info is the asset's token information (`/assets/:symbol`), then the
// market's trading rules; one tab since 05.10.2026, so the switch fits the row.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
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
}

export function ChartSection({ symbol, tf, onTfChange, position, market }: ChartSectionProps) {
  const { colors, space } = useTheme()
  const micro = useTextStyle('micro')
  const toggleHitSlop = useTextLinkHitSlop(micro)
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'chart' | 'info'>('chart')

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Segment
            compact
            value={tab}
            onChange={(t) => {
              setTab(t)
              setOpen(true)
            }}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'info', label: 'Info' },
            ]}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          hitSlop={toggleHitSlop}
          style={linkPressStyle}
        >
          <Text style={[micro, { color: colors.accentText }]}>{open ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      {!open ? null : tab === 'chart' ? (
        <TradingChart symbol={symbol} tf={tf} onTfChange={onTfChange} position={position} />
      ) : (
        <View style={{ gap: space.xl }}>
          {/* Re-keyed per market: a switch never shows the previous asset's text. */}
          <TokenInfoPanel key={symbol} symbol={symbol} />
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <TradingRulesPanel market={market} />
        </View>
      )}
    </View>
  )
}
