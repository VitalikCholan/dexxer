// app/src/features/markets/MarketRowView.tsx — one market in the markets screen's list.
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { AssetIcon } from '@/src/ui/AssetIcon'
import { formatUsd2 } from '@/src/lib/status'
import { formatChange, type MarketRow } from './marketList'

export interface MarketRowViewProps {
  row: MarketRow
  onSelect: () => void
  onToggleFavorite: () => void
}

export function MarketRowView({ row, onSelect, onToggleFavorite }: MarketRowViewProps) {
  const { colors, space, radius, border, control } = useTheme()
  const symbol = useTextStyle('bodyStrong')
  const name = useTextStyle('caption')
  const value = useTextStyle('bodyStrong', { mono: true })
  const change = useTextStyle('caption', { mono: true })
  const star = useTextStyle('heading')
  const changeColor = row.change24h === null ? colors.textSecondary : row.change24h >= 0 ? colors.long : colors.short
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: row.selected }}
      accessibilityLabel={`${row.symbol}${row.name ? `, ${row.name}` : ''}`}
      onPress={onSelect}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        borderWidth: border.hairline,
        borderColor: row.selected ? colors.accent : 'transparent',
        backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
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
        <Text style={[value, { color: colors.textPrimary }]}>
          {row.price !== null ? `$${formatUsd2(row.price)}` : '—'}
        </Text>
        <Text style={[change, { color: changeColor }]}>{formatChange(row.change24h)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.favorite ? `Remove ${row.symbol} from favorites` : `Add ${row.symbol} to favorites`}
        accessibilityState={{ selected: row.favorite }}
        onPress={onToggleFavorite}
        hitSlop={{ top: space.md, bottom: space.md, left: space.sm, right: space.sm }}
        style={({ pressed }) => ({ minWidth: control.minHitTarget, alignItems: 'center', opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={[star, { color: row.favorite ? colors.warning : colors.textTertiary }]}>
          {row.favorite ? '★' : '☆'}
        </Text>
      </Pressable>
    </Pressable>
  )
}
