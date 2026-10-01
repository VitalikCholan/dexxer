// app/src/features/trade/ChartSection.tsx
//
// C.6-A "Perpetual Chart · Show/Hide": the chart (C.5 `TradingChart`, with
// its own timeframe / type toolbar) behind a one-line toggle, so the ticket
// can sit higher on the screen when the chart is not needed. Open by
// default — the screen looked like that before; collapsing is per visit
// (plain state, not persisted). C.7: a Chart / Trading rules switch in the
// same row; Token information joins it once the relayer serves `/assets`.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { type PositionSlot } from '@/src/lib/positions'
import { type TicketMarket } from './marketLimits'
import { TradingRulesPanel } from './TradingRulesPanel'
import { TradingChart } from '../chart/TradingChart'
import { type Tf } from '../chart/chartData'

export type { Tf }

export interface ChartSectionProps {
  /** Selected market symbol — the chart's candles. */
  symbol: string
  tf: Tf
  onTfChange: (tf: Tf) => void
  /** Live mark, raw 1e6. */
  markUsd: bigint | null
  /** The selected market's slot, for the entry / liq lines. */
  position: PositionSlot | null
  market: TicketMarket | null
  /** Latest public `Pool.capital_total`, raw 1e6 — for the default OI cap. */
  poolCapital: bigint | null
}

export function ChartSection({ symbol, tf, onTfChange, markUsd, position, market, poolCapital }: ChartSectionProps) {
  const { colors, space } = useTheme()
  const micro = useTextStyle('micro')
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'chart' | 'rules'>('chart')

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Segment
          compact
          value={tab}
          onChange={(t) => {
            setTab(t)
            setOpen(true)
          }}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'rules', label: 'Trading rules' },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          hitSlop={space.sm}
        >
          <Text style={[micro, { color: colors.accent }]}>{open ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      {!open ? null : tab === 'chart' ? (
        <TradingChart symbol={symbol} tf={tf} onTfChange={onTfChange} markUsd={markUsd} position={position} />
      ) : (
        <TradingRulesPanel market={market} poolCapital={poolCapital} />
      )}
    </View>
  )
}
