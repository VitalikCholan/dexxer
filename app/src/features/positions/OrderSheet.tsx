// app/src/features/positions/OrderSheet.tsx
//
// Add a conditional exit to the open position: Take profit / Stop loss at a
// price, or a Trailing stop at a distance. Each kind holds one slot — placing
// it again replaces the old one (`place_order`, `trade.rs`). Signed by the
// session key, no wallet prompt.
import { useState } from 'react'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Segment } from '@/src/ui/Segment'
import { Input } from '@/src/ui/Input'
import { Button } from '@/src/ui/Button'
import { type PositionSlot } from '@/src/lib/positions'
import { usdAmount, type OrderParams } from '@/src/lib/trade'
import { type ExitKind, validateExit, validateTrail } from '@/src/lib/orders'

export interface OrderSheetProps {
  open: boolean
  onClose: () => void
  position: PositionSlot
  symbol: string
  markUsd: bigint | null
  busy: boolean
  onSubmit: (p: OrderParams) => Promise<void>
}

export function OrderSheet({ open, onClose, position, symbol, markUsd, busy, onSubmit }: OrderSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const [kind, setKind] = useState<ExitKind>('TakeProfit')
  const [price, setPrice] = useState('')
  const [trailPct, setTrailPct] = useState('2')

  const priceNum = Number(price) || 0
  const trailBps = Math.round((Number(trailPct) || 0) * 100)
  const problem =
    kind === 'TrailingStop'
      ? validateTrail(trailBps)
      : price === ''
        ? 'Enter a price'
        : validateExit(kind, position.side, usdAmount(priceNum), markUsd)

  function submit() {
    if (problem) return
    void onSubmit(kind === 'TrailingStop' ? { kind, trailBps } : { kind, trigger: usdAmount(priceNum) })
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Add exit order · ${symbol}`}>
      <Segment
        value={kind}
        onChange={setKind}
        options={[
          { value: 'TakeProfit', label: 'Take profit' },
          { value: 'StopLoss', label: 'Stop loss' },
          { value: 'TrailingStop', label: 'Trailing' },
        ]}
      />
      {kind === 'TrailingStop' ? (
        <Input
          label="Trail distance"
          value={trailPct}
          onChangeText={setTrailPct}
          suffix="%"
          keyboardType="decimal-pad"
          hint="Closes when price falls this far from its best level since now (rises, for a short)"
        />
      ) : (
        <Input
          label={kind === 'TakeProfit' ? 'Take-profit price' : 'Stop-loss price'}
          value={price}
          onChangeText={setPrice}
          suffix="USD"
          keyboardType="decimal-pad"
          hint={markUsd !== null ? `Mark: $${(Number(markUsd) / 1e6).toFixed(2)}` : undefined}
        />
      )}
      {problem && (kind === 'TrailingStop' || price !== '') ? (
        <Text style={[caption, { color: colors.short }]}>{problem}</Text>
      ) : null}
      <Button variant="secondary" disabled={busy || problem !== null} onPress={submit}>
        {busy ? 'Signing with session key…' : 'Place order'}
      </Button>
      <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
        Closes the whole position at the mark when triggered. Only you can see it.
      </Text>
    </Sheet>
  )
}
