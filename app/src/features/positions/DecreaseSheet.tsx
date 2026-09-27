// app/src/features/positions/DecreaseSheet.tsx
//
// Task 10: `decrease_position(close_size, limit_price)` — partial close.
// `close_size` must be > 0 and <= `Position.size` on-chain
// (`trade.rs::decrease_position`); the limit-price direction is the
// close/decrease one (`math.closeSlippageLimit` — opposite of open/increase).
import { useState } from 'react'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Input } from '@/src/ui/Input'
import { Row } from '@/src/ui/Row'
import { Button } from '@/src/ui/Button'
import { type DecodedPosition } from '@/src/lib/codecs'
import { computeUpnl, solSize } from '@/src/lib/trade'

export interface DecreaseSheetProps {
  open: boolean
  onClose: () => void
  position: DecodedPosition
  markUsd: bigint | null
  busy: boolean
  onSubmit: (closeSizeSol: number) => Promise<void>
}

export function DecreaseSheet({ open, onClose, position, markUsd, busy, onSubmit }: DecreaseSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const maxSol = Number(position.size) / 1e9
  const [closeSize, setCloseSize] = useState((maxSol / 2).toFixed(4))

  const closeSizeNum = Math.min(maxSol, Number(closeSize) || 0)
  const closeSizeBig = closeSizeNum > 0 ? solSize(closeSizeNum) : 0n
  // `decrease_pnl(side, size_total, size_close, entry, exit)` in math.rs is
  // literally `upnl(side, size_close, entry, exit)` once `size_close <=
  // size_total` is checked — no separate port needed, reuse `computeUpnl`.
  const realizedPnl =
    markUsd !== null && closeSizeBig > 0n && closeSizeBig <= position.size
      ? computeUpnl(position.side, closeSizeBig, position.entry, markUsd)
      : null

  return (
    <Sheet open={open} onClose={onClose} title="Decrease position">
      <Input
        label="Close size"
        value={closeSize}
        onChangeText={setCloseSize}
        suffix="SOL"
        keyboardType="decimal-pad"
        hint={`Max: ${maxSol.toFixed(4)} SOL`}
        onMax={() => setCloseSize(maxSol.toFixed(4))}
      />
      <Row
        label="Realized PnL ≈"
        value={realizedPnl !== null ? `${realizedPnl >= 0n ? '+' : ''}$${(Number(realizedPnl) / 1e6).toFixed(2)}` : '—'}
        tone={realizedPnl === null ? undefined : realizedPnl >= 0n ? 'success' : 'danger'}
      />
      <Button
        variant="secondary"
        disabled={busy || closeSizeNum <= 0 || closeSizeNum > maxSol}
        onPress={() => void onSubmit(closeSizeNum)}
      >
        {busy ? 'Signing with session key…' : 'Confirm decrease'}
      </Button>
      <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
        No wallet prompt — signed by your session key
      </Text>
    </Sheet>
  )
}
