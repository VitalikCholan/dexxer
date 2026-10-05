// app/src/features/trade/TradeHeader.tsx
//
// Fix round 1: split out of TradeScreen.tsx to keep it under the
// ~200-line guideline. Week 6 (C.6-A) market header: the market switch
// (header button → `/markets`), then the mark + `<SYMBOL>-PERP` +
// max-leverage badge on top (oracle freshness is shown only when it matters:
// TradeScreen's stale/disconnected warning), the big
// mark price with its 24h change, then a stats row — High / Low over the
// fetched candles. Pool liquidity was removed from the UI (05.10.2026); open
// interest is deliberately absent: it lives in the private `MarketRisk`.
import { Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { AssetIcon } from '@/src/ui/AssetIcon'
import { type RangeStats } from './headerStats'
import { useMarkets } from '@/src/lib/markets'

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export interface TradeHeaderProps {
  /** Selected market symbol (`SOL`, `BTC`, ...). */
  symbol: string
  markUsdNum: number | null
  pctChange: number | null
  /** Integer max leverage for the badge; null while the market loads. */
  maxLeverage: number | null
  range: RangeStats | null
}

export function TradeHeader({ symbol, markUsdNum, pctChange, maxLeverage, range }: TradeHeaderProps) {
  const { colors, space } = useTheme()
  const display = useTextStyle('display', { mono: true })
  const heading = useTextStyle('heading')
  const change = useTextStyle('body', { mono: true })
  const micro = useTextStyle('micro')
  const statValue = useTextStyle('caption', { mono: true })
  const markets = useMarkets()
  const paused = markets.data?.find((m) => m.symbol === symbol)?.params.pausedOpen ?? false

  const stats: { label: string; value: string }[] = [
    { label: `${range?.label ?? '24H'} High`, value: range ? `$${fmtUsd(range.high / 1e6)}` : '—' },
    { label: `${range?.label ?? '24H'} Low`, value: range ? `$${fmtUsd(range.low / 1e6)}` : '—' },
  ]

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Market ${symbol}-PERP, change market`}
          onPress={() => router.push('/markets')}
          hitSlop={space.sm}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <AssetIcon symbol={symbol} />
          <Text style={[heading, { color: colors.textPrimary }]}>{`${symbol}-PERP`}</Text>
          <Text style={[heading, { color: colors.textSecondary }]}>▾</Text>
          {maxLeverage !== null ? (
            // `Badge` pins itself to `flex-start`; the wrapper re-centres it on the row.
            <View style={{ justifyContent: 'center' }}>
              <Badge tone="pending">{`${maxLeverage}×`}</Badge>
            </View>
          ) : null}
        </Pressable>
      </View>

      {paused ? <Badge tone="warning">{`Opening paused on ${symbol}-PERP`}</Badge> : null}

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
        <Text style={[display, { color: colors.textPrimary }]}>
          {markUsdNum !== null ? `$${fmtUsd(markUsdNum)}` : '—'}
        </Text>
        {pctChange !== null ? (
          <Text style={[change, { color: pctChange >= 0 ? colors.long : colors.short }]}>
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
