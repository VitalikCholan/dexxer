// app/src/features/trade/ChartSection.tsx
//
// C.6-A "Perpetual Chart · Show/Hide": the chart (C.5 `TradingChart`, with
// its own timeframe / type toolbar) behind a one-line toggle, so the ticket
// can sit higher on the screen when the chart is not needed. Open by
// default — the screen looked like that before; collapsing is per visit
// (plain state, not persisted).
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { type DecodedPosition } from '@/src/lib/codecs'
import { TradingChart } from '../chart/TradingChart'
import { type Tf } from '../chart/chartData'

export type { Tf }

export interface ChartSectionProps {
  tf: Tf
  onTfChange: (tf: Tf) => void
  /** Live mark, raw 1e6. */
  markUsd: bigint | null
  position: DecodedPosition | null
}

export function ChartSection({ tf, onTfChange, markUsd, position }: ChartSectionProps) {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')
  const micro = useTextStyle('micro')
  const [open, setOpen] = useState(true)

  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        hitSlop={space.sm}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <Text style={[caption, { color: colors.textSecondary }]}>Perpetual Chart</Text>
        <Text style={[micro, { color: colors.accent }]}>{open ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {open ? <TradingChart tf={tf} onTfChange={onTfChange} markUsd={markUsd} position={position} /> : null}
    </View>
  )
}
