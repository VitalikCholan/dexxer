// app/src/features/account/DepositSheet.tsx
//
// Task 10: `faucet_mint` + `credit_deposit` (see accountTx.ts) behind one
// amount field — devnet's dev-faucet stands in for a real deposit flow
// (CLAUDE.md: "власний dUSDC faucet-мінт").
import { useState } from 'react'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Input } from '@/src/ui/Input'
import { Button } from '@/src/ui/Button'

export interface DepositSheetProps {
  open: boolean
  onClose: () => void
  busy: boolean
  onSubmit: (amountUsd: number) => Promise<void>
}

export function DepositSheet({ open, onClose, busy, onSubmit }: DepositSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const [amount, setAmount] = useState('100')
  const amountNum = Number(amount) || 0

  return (
    <Sheet open={open} onClose={onClose} title="Deposit">
      <Input label="Amount" value={amount} onChangeText={setAmount} suffix="dUSDC" keyboardType="decimal-pad" />
      <Text style={[caption, { color: colors.textSecondary }]}>Devnet faucet — mints test dUSDC, then credits it to your free margin.</Text>
      <Button variant="primary" disabled={busy || amountNum <= 0} onPress={() => void onSubmit(amountNum)}>
        {busy ? 'Confirm in wallet…' : 'Deposit'}
      </Button>
    </Sheet>
  )
}
