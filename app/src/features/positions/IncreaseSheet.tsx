// app/src/features/positions/IncreaseSheet.tsx
//
// Task 10: `increase_position(add_size, add_margin, limit_price)` — both
// fields named to match the actual ix args (`idl/dexxer_core.json`),
// not a generic "size" field. `add_size` must be > 0 on-chain
// (`trade.rs::increase_position`); `add_margin` defaults to 0 (size-only
// increase is valid, margin-only is not — that needs `add_margin` alone,
// out of this MVP's Positions actions per the brief).
import { useState } from 'react'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Input } from '@/src/ui/Input'
import { Row } from '@/src/ui/Row'
import { Button } from '@/src/ui/Button'
import * as math from '@/src/lib/math'
import { type PositionSlot } from '@/src/lib/positions'
import { solSize } from '@/src/lib/trade'

export interface IncreaseSheetProps {
  open: boolean
  onClose: () => void
  position: PositionSlot
  /** Market symbol for the labels (`SOL`, `BTC`, ...). */
  symbol: string
  markUsd: bigint | null
  mmrBps: bigint
  busy: boolean
  onSubmit: (addSizeSol: number, addMarginUsd: number) => Promise<void>
}

export function IncreaseSheet({
  open,
  onClose,
  position,
  symbol,
  markUsd,
  mmrBps,
  busy,
  onSubmit,
}: IncreaseSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const [addSize, setAddSize] = useState('0.05')
  const [addMargin, setAddMargin] = useState('0')

  const addSizeNum = Number(addSize) || 0
  const addMarginNum = Number(addMargin) || 0
  const newLiq = (() => {
    if (markUsd === null || addSizeNum <= 0) return null
    try {
      const newSize = position.size + solSize(addSizeNum)
      const newMargin = position.margin + (addMarginNum > 0 ? BigInt(Math.round(addMarginNum * 1e6)) : 0n)
      const newEntry = (position.size * position.entry + solSize(addSizeNum) * markUsd) / newSize
      return math.liqPrice(position.side, newEntry, newSize, newMargin, mmrBps)
    } catch {
      return null
    }
  })()

  return (
    <Sheet open={open} onClose={onClose} title={`Increase ${symbol}-PERP`}>
      <Input label="Add size" value={addSize} onChangeText={setAddSize} suffix={symbol} keyboardType="decimal-pad" />
      <Input
        label="Add margin (optional)"
        value={addMargin}
        onChangeText={setAddMargin}
        suffix="dUSDC"
        keyboardType="decimal-pad"
      />
      <Row label="New liq. price ≈" value={newLiq !== null ? `$${(Number(newLiq) / 1e6).toFixed(2)}` : '—'} />
      <Button
        variant="primary"
        disabled={busy || addSizeNum <= 0}
        onPress={() => void onSubmit(addSizeNum, addMarginNum)}
      >
        {busy ? 'Signing with session key…' : 'Confirm increase'}
      </Button>
      <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
        No wallet prompt — signed by your session key
      </Text>
    </Sheet>
  )
}
