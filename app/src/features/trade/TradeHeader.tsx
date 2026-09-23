// app/src/features/trade/TradeHeader.tsx
//
// Fix round 1: split out of TradeScreen.tsx to keep it under the
// ~200-line guideline. SOL-PERP + big mark price on the left, 24h change
// above a bordered "Pyth Lazer" freshness pill on the right — matches the
// mockup's "01 · Trade" header row.
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export interface TradeHeaderProps {
  markUsdNum: number | null
  pctChange: number | null
  dotColor: string
}

export function TradeHeader({ markUsdNum, pctChange, dotColor }: TradeHeaderProps) {
  const { colors, space, radius } = useTheme()
  const display = useTextStyle('display', { mono: true })
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <Text style={[caption, { color: colors.textSecondary }]}>SOL-PERP</Text>
        <Text style={[display, { color: colors.textPrimary }]}>
          {markUsdNum !== null ? `$${fmtUsd(markUsdNum)}` : '—'}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: space.sm }}>
        {pctChange !== null ? (
          <Text style={[body, { color: pctChange >= 0 ? colors.long : colors.short }]}>
            {pctChange >= 0 ? '+' : ''}
            {pctChange.toFixed(1)}%
          </Text>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.pill,
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />
          <Text style={[caption, { color: colors.textSecondary }]}>Pyth Lazer</Text>
        </View>
      </View>
    </View>
  )
}
