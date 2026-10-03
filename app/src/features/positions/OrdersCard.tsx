// app/src/features/positions/OrdersCard.tsx
//
// Pending conditional orders (private — they live in the owner's `Position`).
// Entry orders (Limit/Stop) wait on an empty position, exit orders (TP/SL/
// Trailing) on an open one; each row cancels its slot.
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Button } from '@/src/ui/Button'
import { type DecodedOrder } from '@/src/lib/codecs'
import { describeOrder } from '@/src/lib/orders'

export interface OrdersCardProps {
  orders: DecodedOrder[]
  busy: boolean
  /** Hidden when there is no open position to protect. */
  onAdd?: () => void
  onCancel: (slot: number) => void
}

export function OrdersCard({ orders, busy, onAdd, onCancel }: OrdersCardProps) {
  const { colors, space } = useTheme()
  const body = useTextStyle('bodyStrong')
  const caption = useTextStyle('caption')

  return (
    <Card title="Orders">
      {orders.length === 0 ? (
        <Text style={[caption, { color: colors.textSecondary }]}>No pending orders</Text>
      ) : (
        orders.map((o) => {
          const d = describeOrder(o)
          return (
            <View key={o.slot} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View style={{ flex: 1 }}>
                <Text style={[body, { color: colors.textPrimary }]}>{d.title}</Text>
                <Text style={[caption, { color: colors.textSecondary }]}>{d.detail}</Text>
              </View>
              <Button variant="ghost" disabled={busy} onPress={() => onCancel(o.slot)}>
                Cancel
              </Button>
            </View>
          )
        })
      )}
      {onAdd ? (
        <Button variant="secondary" disabled={busy} onPress={onAdd}>
          Add TP / SL
        </Button>
      ) : null}
    </Card>
  )
}
