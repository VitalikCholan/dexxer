// app/src/features/trade/TradingRulesPanel.tsx
//
// The "Trading rules" section of the Info tab next to the chart:
// `tradingRules.ts`'s groups as label / value rows. Everything here is public
// `Market` state; the section has nothing private to show.
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Row } from '@/src/ui/Row'
import { Skeleton } from '@/src/ui/Skeleton'
import { type TicketMarket } from './marketLimits'
import { tradingRules } from './tradingRules'

export function TradingRulesPanel({ market }: { market: TicketMarket | null }) {
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const micro = useTextStyle('micro')

  if (!market) return <Skeleton lines={6} />

  return (
    <View style={{ gap: space.lg }}>
      <Text style={[heading, { color: colors.textPrimary }]}>Trading rules</Text>
      {tradingRules(market).map((g) => (
        <View key={g.title} style={{ gap: space.xs }}>
          <Text style={[micro, { color: colors.textTertiary }]}>{g.title}</Text>
          {g.rows.map((r) => (
            <Row key={r.label} label={r.label} value={r.value} />
          ))}
        </View>
      ))}
    </View>
  )
}
