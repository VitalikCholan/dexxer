// app/src/features/trade/TradeActivity.tsx
//
// C.6-A "Positions (n) / Open Orders (n)" under the ticket: the selected
// market's open position (its `Positions` slot) at a glance without leaving Trade, with a jump to the Positions
// tab for Increase / Decrease / Add margin. Open Orders is always 0 — the
// program has no conditional orders yet (limit / TP / SL are backlog B);
// the tab is here so the layout does not change when they land.
import { useState } from 'react'
import { router } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { formatUsd2 } from '@/src/lib/status'
import { type PositionSlot } from '@/src/lib/positions'
import { computeUpnl } from '@/src/lib/trade'

function sol(raw: bigint): string {
  return (Number(raw) / 1e9).toFixed(4)
}
function signedUsd(raw: bigint): string {
  return `${raw >= 0n ? '+' : '−'}$${formatUsd2(raw >= 0n ? raw : -raw)}`
}

export function TradeActivity({
  symbol,
  position: open,
  markUsd,
}: {
  symbol: string
  position: PositionSlot | null
  markUsd: bigint | null
}) {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')
  const link = useTextStyle('bodyStrong')
  const [tab, setTab] = useState<'positions' | 'orders'>('positions')

  const upnl = open && markUsd !== null ? computeUpnl(open.side, open.size, open.entry, markUsd) : null

  return (
    <Card>
      <Segment
        compact
        value={tab}
        onChange={setTab}
        options={[
          { value: 'positions', label: `Positions (${open ? 1 : 0})` },
          { value: 'orders', label: 'Open Orders (0)' },
        ]}
      />
      {tab === 'orders' ? (
        <Text style={[caption, { color: colors.textSecondary }]}>
          No open orders. Limit, take-profit and stop-loss orders are coming — today every trade executes at the oracle
          price right away.
        </Text>
      ) : !open ? (
        <Text style={[caption, { color: colors.textSecondary }]}>No open position.</Text>
      ) : (
        <View style={{ gap: space.xs }}>
          <Row
            label={`${symbol}-PERP`}
            value={`${open.side} ${sol(open.size)} ${symbol}`}
            tone={open.side === 'Long' ? 'success' : 'danger'}
          />
          <Row label="Entry" value={`$${formatUsd2(open.entry)}`} mono />
          <Row label="Mark" value={markUsd !== null ? `$${formatUsd2(markUsd)}` : '—'} mono />
          <Row
            label="Unrealized PnL"
            value={upnl !== null ? signedUsd(upnl) : '—'}
            tone={upnl === null ? undefined : upnl >= 0n ? 'success' : 'danger'}
          />
          <Row label="Liq. price" value={`$${formatUsd2(open.liqPrice)}`} />
          <Pressable
            accessibilityRole="link"
            onPress={() => router.push('/positions')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              justifyContent: 'space-between',
              paddingTop: space.sm,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={[link, { color: colors.accent }]}>Manage in Positions</Text>
            <Text style={[link, { color: colors.accent }]}>›</Text>
          </Pressable>
        </View>
      )}
    </Card>
  )
}
