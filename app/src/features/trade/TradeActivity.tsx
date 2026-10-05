// app/src/features/trade/TradeActivity.tsx
//
// C.6-A "Positions (n) / Open Orders (n)" under the ticket: the selected
// market's open position (its `Positions` slot) at a glance without leaving Trade, with a jump to the Positions
// tab for Increase / Decrease / Add margin. Open Orders lists the market's
// pending conditional orders (limit / stop / TP / SL / trailing), each with a
// Cancel.
import { useState } from 'react'
import { router } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { formatSignedDusdc, formatUsd2 } from '@/src/lib/status'
import { type DecodedOrder, type PositionSlot } from '@/src/lib/positions'
import { describeOrder } from '@/src/lib/orders'
import { Button } from '@/src/ui/Button'
import { computeUpnl } from '@/src/lib/trade'

function sol(raw: bigint): string {
  return (Number(raw) / 1e9).toFixed(4)
}

export function TradeActivity({
  symbol,
  position: open,
  markUsd,
  orders,
  busy,
  onCancel,
}: {
  symbol: string
  position: PositionSlot | null
  markUsd: bigint | null
  orders: DecodedOrder[]
  busy: boolean
  onCancel: (slot: number) => void
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
          { value: 'orders', label: `Open Orders (${orders.length})` },
        ]}
      />
      {tab === 'orders' ? (
        orders.length === 0 ? (
          <Text style={[caption, { color: colors.textSecondary }]}>
            No open orders. Place a Limit or Stop in the ticket, or add a take-profit / stop-loss to a position.
          </Text>
        ) : (
          <View style={{ gap: space.sm }}>
            {orders.map((o) => {
              const d = describeOrder(o)
              return (
                <View key={o.slot} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[link, { color: colors.textPrimary }]}>{d.title}</Text>
                    <Text style={[caption, { color: colors.textSecondary }]}>{d.detail}</Text>
                  </View>
                  <Button variant="ghost" disabled={busy} onPress={() => onCancel(o.slot)}>
                    Cancel
                  </Button>
                </View>
              )
            })}
          </View>
        )
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
            value={upnl !== null ? formatSignedDusdc(upnl) : '—'}
            tone={upnl === null ? undefined : upnl >= 0n ? 'success' : 'danger'}
            mono
          />
          <Row label="Liq. price" value={`$${formatUsd2(open.liqPrice)}`} mono />
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
            <Text style={[link, { color: colors.accentText }]}>Manage in Positions</Text>
            <Text style={[link, { color: colors.accentText }]}>›</Text>
          </Pressable>
        </View>
      )}
    </Card>
  )
}
