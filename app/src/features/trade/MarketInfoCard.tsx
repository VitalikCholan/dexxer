// app/src/features/trade/MarketInfoCard.tsx
//
// C.6-A "Info / About / Risk disclosure", Telegram-Wallet style: one line on
// what the market is, its public risk parameters straight from `Market`,
// and links to the in-app explainer and risk disclosure (`app/(tabs)/info`).
// No 24h volume, open interest or funding here: volume and OI are private
// (`MarketRisk`, week 6 rule), and there is no funding or borrow rate.
import { router } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { formatBps, maxLeverage } from './headerStats'
import { type TicketMarket } from './marketLimits'

export function MarketInfoCard({ symbol, market }: { symbol: string; market: TicketMarket | null }) {
  const { colors, space, border } = useTheme()
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')
  const link = useTextStyle('bodyStrong')
  const lev = market ? maxLeverage(market.maxLevBps, market.imrBps) : null

  const links = [
    { label: 'Learn more about Perpetuals', href: '/info/perpetuals' as const },
    { label: 'View risk disclosure', href: '/info/risk' as const },
  ]

  return (
    <Card title={`About ${symbol}-PERP`}>
      <Text style={[body, { color: colors.textSecondary }]}>
        {`Trade ${symbol} price movements with up to ${lev ?? '—'}× leverage, settled in dUSDC. Only you can see your open position.`}
      </Text>
      <View style={{ gap: space.xs }}>
        <Row label="Max leverage" value={lev !== null ? `${lev}×` : '—'} />
        <Row
          label="Open / close fee"
          value={market ? `${formatBps(market.openFeeBps)} / ${formatBps(market.closeFeeBps)}` : '—'}
        />
        <Row label="Maintenance margin" value={market ? formatBps(market.mmrBps) : '—'} />
        <Row label="Liquidation fee" value={market ? formatBps(market.liqFeeBps) : '—'} />
        <Row label="Price" value="Pyth Lazer, mark = EMA" />
        <Row label="Counterparty" value="Protocol pool" />
      </View>
      <View>
        {links.map((l) => (
          <Pressable
            key={l.href}
            accessibilityRole="link"
            onPress={() => router.push(l.href)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              justifyContent: 'space-between',
              paddingVertical: space.md,
              borderTopWidth: border.hairline,
              borderTopColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={[link, { color: colors.accent }]}>{l.label}</Text>
            <Text style={[link, { color: colors.accent }]}>›</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[caption, { color: colors.textTertiary }]}>Devnet: dUSDC is a test token with no value.</Text>
    </Card>
  )
}
