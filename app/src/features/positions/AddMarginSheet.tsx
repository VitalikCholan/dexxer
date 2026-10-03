// app/src/features/positions/AddMarginSheet.tsx
//
// C.4: `add_margin(amount)` — moves free margin into the open position,
// lowering its leverage and pushing its liq price away; `trade.rs::add_margin`
// recomputes `liq_price` at the same entry and size. There is no
// `remove_margin` in the program, so this is one-way until the owner closes.
import { useState } from 'react'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Input } from '@/src/ui/Input'
import { Row } from '@/src/ui/Row'
import { Button } from '@/src/ui/Button'
import { formatUsd2 } from '@/src/lib/status'
import { notional } from '@/src/lib/math'
import { type PositionSlot } from '@/src/lib/positions'
import { usdAmount } from '@/src/lib/trade'
import { liqAfterAddMargin } from '../trade/ticketMath'

export interface AddMarginSheetProps {
  open: boolean
  onClose: () => void
  position: PositionSlot
  /** Market symbol for the labels (`SOL`, `BTC`, ...). */
  symbol: string
  freeMarginUsd: bigint | null
  mmrBps: bigint
  busy: boolean
  /** The position's Market has loaded (its feed is needed to sign). */
  ready: boolean
  /** Raw 1e6 amount — `add_margin`'s argument. */
  onSubmit: (amount: bigint) => Promise<void>
}

export function AddMarginSheet({
  open,
  onClose,
  position,
  symbol,
  freeMarginUsd,
  mmrBps,
  busy,
  ready,
  onSubmit,
}: AddMarginSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const [amount, setAmount] = useState('')
  // MAX sends the raw free margin — the field shows it rounded to cents, which can exceed it.
  const [all, setAll] = useState(false)

  const n = Number(amount)
  const add = all && freeMarginUsd !== null ? freeMarginUsd : Number.isFinite(n) && n > 0 ? usdAmount(n) : 0n
  const tooMuch = freeMarginUsd !== null && add > freeMarginUsd
  const newLiq =
    add > 0n ? liqAfterAddMargin(position.side, position.entry, position.size, position.margin, add, mmrBps) : null
  const ntl = notional(position.size, position.entry)
  const newMargin = position.margin + add
  const leverage = (m: bigint) => (m > 0n ? `${(Number(ntl) / Number(m)).toFixed(1)}×` : '—')
  const liqAfter = add > 0n ? (newLiq !== null ? `$${formatUsd2(newLiq)}` : 'none') : '—'

  return (
    <Sheet open={open} onClose={onClose} title={`Add margin · ${symbol}-PERP`}>
      <Input
        label="Amount"
        value={amount}
        onChangeText={(t) => {
          setAll(false)
          setAmount(t)
        }}
        suffix="dUSDC"
        keyboardType="decimal-pad"
        hint={`Available: ${freeMarginUsd !== null ? formatUsd2(freeMarginUsd) : '—'} dUSDC`}
        onMax={
          freeMarginUsd !== null
            ? () => {
                setAll(true)
                setAmount(formatUsd2(freeMarginUsd))
              }
            : undefined
        }
      />
      <Row label="Margin" value={`$${formatUsd2(position.margin)} → $${formatUsd2(newMargin)}`} />
      <Row label="Leverage" value={`${leverage(position.margin)} → ${leverage(newMargin)}`} />
      <Row label="Liq. price" value={`$${formatUsd2(position.liqPrice)} → ${liqAfter}`} />
      {tooMuch ? (
        <Text style={[caption, { color: colors.short }]}>More than your free margin — deposit first</Text>
      ) : null}
      {!ready ? (
        <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>Waiting for market price…</Text>
      ) : null}
      <Button variant="primary" disabled={busy || !ready || add === 0n || tooMuch} onPress={() => void onSubmit(add)}>
        {busy ? 'Signing with session key…' : 'Confirm add margin'}
      </Button>
      <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
        Margin cannot be withdrawn from an open position — only released by closing it.
      </Text>
    </Sheet>
  )
}
