// app/src/features/trade/TradingRulesPanel.tsx
//
// C.7 "Trading rules" tab next to the chart: `tradingRules.ts`'s groups as
// label / value rows. Everything here is public `Market` state (and the
// public `Pool` snapshot); the tab has nothing private to show.
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Row } from '@/src/ui/Row'
import { Skeleton } from '@/src/ui/Skeleton'
import { type TicketMarket } from './marketLimits'
import { tradingRules } from './tradingRules'

export function TradingRulesPanel({
  market,
  poolCapital,
}: {
  market: TicketMarket | null
  poolCapital: bigint | null
}) {
  const { colors, space } = useTheme()
  const micro = useTextStyle('micro')
  const caption = useTextStyle('caption')

  if (!market) return <Skeleton lines={6} />

  return (
    <View style={{ gap: space.lg }}>
      {tradingRules(market, poolCapital).map((g) => (
        <View key={g.title} style={{ gap: space.xs }}>
          <Text style={[micro, { color: colors.textTertiary }]}>{g.title}</Text>
          {g.rows.map((r) => (
            <Row key={r.label} label={r.label} value={r.value} />
          ))}
        </View>
      ))}
      <Text style={[caption, { color: colors.textTertiary }]}>
        Read live from the on-chain market. Current open interest is private and not shown.
      </Text>
    </View>
  )
}
