// app/src/features/account/WithdrawSheet.tsx
//
// Task 10: `withdraw` (see accountTx.ts). CLAUDE.md's withdraw rule: `amount
// >= MIN_WITHDRAW (1 dUSDC)`, `WITHDRAW_COOLDOWN_SLOTS = 300` (~2 min on
// devnet) per account — surfaced as the design's copy verbatim.
import { useState } from 'react'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Input } from '@/src/ui/Input'
import { Button } from '@/src/ui/Button'
import { MIN_WITHDRAW_USD } from './accountTx'

export interface WithdrawSheetProps {
  open: boolean
  onClose: () => void
  availableUsd: string
  busy: boolean
  onSubmit: (amountUsd: number) => Promise<void>
}

export function WithdrawSheet({ open, onClose, availableUsd, busy, onSubmit }: WithdrawSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const [amount, setAmount] = useState(String(MIN_WITHDRAW_USD))
  const amountNum = Number(amount) || 0

  return (
    <Sheet open={open} onClose={onClose} title="Withdraw">
      <Input
        label="Amount"
        value={amount}
        onChangeText={setAmount}
        suffix="dUSDC"
        keyboardType="decimal-pad"
        hint={`Available: ${availableUsd} dUSDC`}
      />
      <Text style={[caption, { color: colors.textSecondary }]}>Min {MIN_WITHDRAW_USD} dUSDC · one withdrawal per ~2 min</Text>
      <Button variant="primary" disabled={busy || amountNum < MIN_WITHDRAW_USD} onPress={() => void onSubmit(amountNum)}>
        {busy ? 'Confirm in wallet…' : 'Withdraw'}
      </Button>
    </Sheet>
  )
}
