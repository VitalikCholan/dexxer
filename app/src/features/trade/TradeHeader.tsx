// app/src/features/trade/TradeHeader.tsx
//
// Fix round 1: split out of TradeScreen.tsx to keep it under the
// ~200-line guideline. Week 6 (C.6-A) market header: SOL mark + SOL-PERP +
// max-leverage badge and the "Pyth Lazer" freshness pill on top, the big
// mark price with its 24h change, then a stats row — High / Low over the
// fetched candles and the pool's liquidity from the public 5-min `Pool`
// snapshot (rounded to 100 dUSDC). Open interest is deliberately absent: it
// lives in the private `MarketRisk` and servers never serve it.
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { SolIcon } from '@/src/ui/SolIcon'
import { formatCompactUsd, type RangeStats } from './headerStats'

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export interface TradeHeaderProps {
  markUsdNum: number | null
  pctChange: number | null
  dotColor: string
  /** Integer max leverage for the badge; null while the market loads. */
  maxLeverage: number | null
  range: RangeStats | null
  /** `Pool.capital_total` from the latest public snapshot, raw 1e6. */
  poolLiquidity: bigint | null
}

export function TradeHeader({ markUsdNum, pctChange, dotColor, maxLeverage, range, poolLiquidity }: TradeHeaderProps) {
  const { colors, space, radius, border } = useTheme()
  const display = useTextStyle('display', { mono: true })
  const heading = useTextStyle('heading')
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')
  const micro = useTextStyle('micro')
  const statValue = useTextStyle('caption', { mono: true })

  const stats: { label: string; value: string }[] = [
    { label: `${range?.label ?? '24H'} High`, value: range ? `$${fmtUsd(range.high / 1e6)}` : '—' },
    { label: `${range?.label ?? '24H'} Low`, value: range ? `$${fmtUsd(range.low / 1e6)}` : '—' },
    { label: 'Pool liq.', value: poolLiquidity !== null ? formatCompactUsd(poolLiquidity) : '—' },
  ]

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <SolIcon />
          <Text style={[heading, { color: colors.textPrimary }]}>SOL-PERP</Text>
          {maxLeverage !== null ? (
            // `Badge` pins itself to `flex-start`; the wrapper re-centres it on the row.
            <View style={{ justifyContent: 'center' }}>
              <Badge tone="pending">{`${maxLeverage}×`}</Badge>
            </View>
          ) : null}
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
            borderWidth: border.hairline,
            borderColor: colors.border,
            borderRadius: radius.pill,
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />
          <Text style={[caption, { color: colors.textSecondary }]}>Pyth Lazer</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
        <Text style={[display, { color: colors.textPrimary }]}>
          {markUsdNum !== null ? `$${fmtUsd(markUsdNum)}` : '—'}
        </Text>
        {pctChange !== null ? (
          <Text style={[body, { color: pctChange >= 0 ? colors.long : colors.short }]}>
            {pctChange >= 0 ? '+' : ''}
            {pctChange.toFixed(1)}%
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: space.lg }}>
        {stats.map((s) => (
          <View key={s.label} style={{ flex: 1, gap: 2 }}>
            <Text style={[micro, { color: colors.textTertiary }]}>{s.label}</Text>
            <Text style={[statValue, { color: colors.textPrimary }]}>{s.value}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}
