// app/src/features/trade/ChartSection.tsx
//
// C.6-A "Perpetual Chart · Show/Hide": the price chart and its timeframe
// row behind a one-line toggle, so the ticket can sit higher on the screen
// when the chart is not needed. Open by default — the screen looked like
// that before; collapsing is per visit (plain state, not persisted).
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { PriceChart } from './PriceChart'

export type Tf = '1m' | '5m' | '15m'

export interface ChartSectionProps {
  tf: Tf
  onTfChange: (tf: Tf) => void
  markUsd: number | null
}

export function ChartSection({ tf, onTfChange, markUsd }: ChartSectionProps) {
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
      {open ? (
        <>
          <PriceChart tf={tf} markUsd={markUsd} />
          <Segment
            compact
            value={tf}
            onChange={onTfChange}
            options={[
              { value: '1m', label: '1m' },
              { value: '5m', label: '5m' },
              { value: '15m', label: '15m' },
            ]}
          />
        </>
      ) : null}
    </View>
  )
}
