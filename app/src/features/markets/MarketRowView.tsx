// app/src/features/markets/MarketRowView.tsx — one market in the markets screen's list.
import { memo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { AssetIcon } from '@/src/ui/AssetIcon'
import { formatUsd2 } from '@/src/lib/status'
import { QK, getJson } from '@/src/lib/indexer'
import { parseMark } from '@/src/lib/indexerCodec'
import { displayPrice, formatChange, rowAccessibilityLabel, type MarketRow } from './marketList'

export interface MarketRowViewProps {
  row: MarketRow
  onSelect: (symbol: string) => void
  onToggleFavorite: (symbol: string) => void
}

/**
 * Observes its own market's WS mark (`enabled: false`: never fetches) so a
 * price tick re-renders this row only, not the whole list.
 */
function useLiveMark(symbol: string) {
  return useQuery({
    queryKey: QK.mark(symbol),
    queryFn: () => getJson(`/mark?market=${encodeURIComponent(symbol)}`, parseMark),
    enabled: false,
    select: (m) => ({ price: m.price, stale: m.stale }),
  }).data
}

export const MarketRowView = memo(function MarketRowView({ row, onSelect, onToggleFavorite }: MarketRowViewProps) {
  const { colors, space, radius, border, control } = useTheme()
  const symbol = useTextStyle('bodyStrong')
  const name = useTextStyle('caption')
  const value = useTextStyle('bodyStrong', { mono: true })
  const change = useTextStyle('caption', { mono: true })
  const star = useTextStyle('heading')
  const price = displayPrice(useLiveMark(row.symbol), row.price)
  const changeColor = row.change24h === null ? colors.textSecondary : row.change24h >= 0 ? colors.long : colors.short
  // Two sibling buttons in one row: an accessible parent would swallow a nested
  // star for TalkBack (Android merges an accessible element's children).
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: row.selected ? colors.accent : 'transparent',
        backgroundColor: colors.surface,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: row.selected }}
        accessibilityLabel={rowAccessibilityLabel(row, price)}
        onPress={() => onSelect(row.symbol)}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          padding: space.md,
          backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
        })}
      >
        <AssetIcon symbol={row.symbol} size={36} />
        <View style={{ flex: 1, gap: space.xs }}>
          <Text style={[symbol, { color: colors.textPrimary }]}>{row.symbol}</Text>
          {row.name ? <Text style={[name, { color: colors.textSecondary }]}>{row.name}</Text> : null}
          <View style={{ flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' }}>
            {row.maxLeverage !== null ? <Badge tone="neutral">{`${row.maxLeverage}×`}</Badge> : null}
            {row.hasPosition ? <Badge tone="pending">Position</Badge> : null}
            {row.hasOrders ? <Badge tone="pending">Orders</Badge> : null}
            {row.paused ? <Badge tone="warning">Paused</Badge> : null}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: space.xs }}>
          <Text style={[value, { color: colors.textPrimary }]}>{price !== null ? `$${formatUsd2(price)}` : '—'}</Text>
          <Text style={[change, { color: changeColor }]}>{formatChange(row.change24h)}</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.favorite ? `Remove ${row.symbol} from favorites` : `Add ${row.symbol} to favorites`}
        accessibilityState={{ selected: row.favorite }}
        onPress={() => onToggleFavorite(row.symbol)}
        hitSlop={{ top: space.md, bottom: space.md, left: space.sm, right: space.sm }}
        style={({ pressed }) => ({
          minWidth: control.minHitTarget,
          alignSelf: 'stretch',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={[star, { color: row.favorite ? colors.warning : colors.textTertiary }]}>
          {row.favorite ? '★' : '☆'}
        </Text>
      </Pressable>
    </View>
  )
})
