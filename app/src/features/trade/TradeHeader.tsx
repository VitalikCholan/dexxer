// app/src/features/trade/TradeHeader.tsx
//
// Fix round 1: split out of TradeScreen.tsx to keep it under the
// ~200-line guideline. Week 6 (C.6-A) market header: the market switch
// (header button → `/markets`, favourite chips), then the mark + `<SYMBOL>-PERP` +
// max-leverage badge and the "Pyth Lazer" freshness pill on top, the big
// mark price with its 24h change, then a stats row — High / Low over the
// fetched candles and the pool's liquidity from the public 5-min `Pool`
// snapshot (rounded to 100 dUSDC). Open interest is deliberately absent: it
// lives in the private `MarketRisk` and servers never serve it.
import { Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { AssetIcon } from '@/src/ui/AssetIcon'
import { formatCompactUsd, type RangeStats } from './headerStats'
import { useFavorites } from '@/src/lib/favoritesStore'
import { chipSymbols } from '@/src/lib/favorites'
import { useMarkets, useSelectedMarket } from '@/src/lib/markets'

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export interface TradeHeaderProps {
  /** Selected market symbol (`SOL`, `BTC`, ...). */
  symbol: string
  markUsdNum: number | null
  pctChange: number | null
  dotColor: string
  /** Integer max leverage for the badge; null while the market loads. */
  maxLeverage: number | null
  range: RangeStats | null
  /** `Pool.capital_total` from the latest public snapshot, raw 1e6. */
  poolLiquidity: bigint | null
}

export function TradeHeader({
  symbol,
  markUsdNum,
  pctChange,
  dotColor,
  maxLeverage,
  range,
  poolLiquidity,
}: TradeHeaderProps) {
  const { colors, space, radius, border, control } = useTheme()
  const chip = useTextStyle('body', { mono: true })
  const display = useTextStyle('display', { mono: true })
  const heading = useTextStyle('heading')
  const change = useTextStyle('body', { mono: true })
  const caption = useTextStyle('caption')
  const micro = useTextStyle('micro')
  const statValue = useTextStyle('caption', { mono: true })
  const markets = useMarkets()
  const favorites = useFavorites()
  const { setSymbol } = useSelectedMarket()
  const registry = markets.data?.length ? markets.data.map((m) => m.symbol) : [symbol]
  const chips = chipSymbols(favorites.list, registry)
  const paused = markets.data?.find((m) => m.symbol === symbol)?.params.pausedOpen ?? false

  const stats: { label: string; value: string }[] = [
    { label: `${range?.label ?? '24H'} High`, value: range ? `$${fmtUsd(range.high / 1e6)}` : '—' },
    { label: `${range?.label ?? '24H'} Low`, value: range ? `$${fmtUsd(range.low / 1e6)}` : '—' },
    { label: 'Pool liq.', value: poolLiquidity !== null ? formatCompactUsd(poolLiquidity) : '—' },
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

      {chips.length > 0 ? (
        // Wraps instead of scrolling: five 8-character symbols at a large font still fit and stay tappable.
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {chips.map((s) => {
            const selected = s === symbol
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Switch to ${s}-PERP`}
                onPress={() => setSymbol(s)}
                style={({ pressed }) => ({
                  minHeight: control.minHitTarget,
                  paddingHorizontal: space.md,
                  justifyContent: 'center',
                  borderRadius: radius.md,
                  borderWidth: border.hairline,
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: selected ? colors.accentSubtle : pressed ? colors.surfaceAlt : colors.bgElevated,
                })}
              >
                <Text style={[chip, { color: selected ? colors.textPrimary : colors.textSecondary }]}>{s}</Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}
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
