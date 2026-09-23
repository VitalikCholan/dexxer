// app/src/features/trade/TradeTicket.tsx
//
// Task 10: Long/Short + Size/Margin/Leverage form, live preview row, Open
// button. Leverage convention (`math.ts`'s header comment): a plain integer
// 1..10× (matches `ui/LeverageSlider`'s step). Dragging the slider
// recomputes Margin from the current Size at that leverage
// (`math.marginForLeverage`); typing a custom Margin overrides it until the
// slider moves again — `open_position` only ever sees the Margin field's
// current value, leverage is a UI convenience, not a program argument.
import { useState } from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { Input } from '@/src/ui/Input'
import { LeverageSlider } from '@/src/ui/LeverageSlider'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Button } from '@/src/ui/Button'
import * as math from '@/src/lib/math'
import { solSize, usdAmount, type SideName } from '@/src/lib/program'

export interface MarketParams {
  imrBps: bigint
  mmrBps: bigint
  openFeeBps: bigint
}

export interface TradeTicketProps {
  markUsd: bigint | null
  market: MarketParams | null
  freeMarginUsd: bigint | null
  hasOpenPosition: boolean
  busy: boolean
  disabled?: boolean
  onOpen: (side: SideName, sizeSol: number, marginUsd: number, limitUsd: number) => Promise<void>
}

function usd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2)
}

function safeLiq(side: SideName, entry: bigint, size: bigint, margin: bigint, mmrBps: bigint): bigint | null {
  try {
    return math.liqPrice(side, entry, size, margin, mmrBps)
  } catch {
    return null
  }
}

export function TradeTicket({
  markUsd,
  market,
  freeMarginUsd,
  hasOpenPosition,
  busy,
  disabled,
  onOpen,
}: TradeTicketProps) {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')

  const [side, setSide] = useState<'long' | 'short'>('long')
  const [sizeSol, setSizeSol] = useState('0.1')
  const [marginUsd, setMarginUsd] = useState('20')
  const [leverage, setLeverage] = useState(2)

  const sideName: SideName = side === 'long' ? 'Long' : 'Short'
  const sizeNum = Number(sizeSol) || 0
  const sizeBig = sizeNum > 0 ? solSize(sizeNum) : 0n
  const ntl = markUsd !== null && sizeBig > 0n ? math.notional(sizeBig, markUsd) : null

  // Recompute Margin from (size, leverage) whenever the slider moves — the
  // React-docs "adjust state when [something] changes" pattern (during
  // render, not a `useEffect` + `setState`, which the project's react-hooks
  // lint flags as a cascading-render risk; `ui/Sheet.tsx` uses the same
  // pattern for its own render-triggered state adjustment).
  const [prevLeverage, setPrevLeverage] = useState(leverage)
  if (leverage !== prevLeverage) {
    setPrevLeverage(leverage)
    if (ntl !== null) setMarginUsd(usd(math.marginForLeverage(ntl, leverage)))
  }

  const marginNum = Number(marginUsd) || 0
  const marginBig = marginNum > 0 ? usdAmount(marginNum) : 0n
  const feeUsd = ntl !== null && market ? math.fee(ntl, market.openFeeBps) : null
  const liq =
    ntl !== null && markUsd !== null && market && marginBig > 0n && sizeBig > 0n
      ? safeLiq(sideName, markUsd, sizeBig, marginBig, market.mmrBps)
      : null
  const limit = markUsd !== null ? math.openSlippageLimit(sideName, markUsd) : null

  const availableUsd = freeMarginUsd !== null ? usd(freeMarginUsd) : '—'

  if (hasOpenPosition) {
    return (
      <Card>
        <Segment
          tone="long-short"
          value={side}
          onChange={setSide}
          options={[
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
        />
        <Text style={[caption, { color: colors.textSecondary }]}>One position per market. Close it in Positions.</Text>
      </Card>
    )
  }

  return (
    <Card>
      <Segment
        tone="long-short"
        value={side}
        onChange={setSide}
        options={[
          { value: 'long', label: 'Long' },
          { value: 'short', label: 'Short' },
        ]}
      />
      <Input label="Size" value={sizeSol} onChangeText={setSizeSol} suffix="SOL" keyboardType="decimal-pad" />
      <Input
        label="Margin"
        value={marginUsd}
        onChangeText={setMarginUsd}
        suffix="dUSDC"
        keyboardType="decimal-pad"
        hint={`Available: ${availableUsd} dUSDC`}
        onMax={freeMarginUsd !== null ? () => setMarginUsd(usd(freeMarginUsd)) : undefined}
      />
      <LeverageSlider value={leverage} onChange={setLeverage} />
      <View style={{ gap: space.xs }}>
        <Row label="Entry ≈" value={markUsd !== null ? `$${usd(markUsd)}` : '—'} />
        <Row label="Liq. price" value={liq !== null ? `$${usd(liq)}` : '—'} />
        <Row label="Fee" value={feeUsd !== null ? `${usd(feeUsd)} dUSDC` : '—'} />
        <Row label="Slippage limit" value={limit !== null ? `$${usd(limit)}` : '—'} />
      </View>
      <Button
        variant={side === 'long' ? 'primary' : 'destructive'}
        disabled={disabled || busy || markUsd === null}
        onPress={() => void onOpen(sideName, sizeNum, marginNum, limit !== null ? Number(limit) / 1_000_000 : 0)}
      >
        {busy ? 'Signing with session key…' : side === 'long' ? 'Open Long' : 'Open Short'}
      </Button>
      <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
        No wallet prompt — signed by your session key
      </Text>
    </Card>
  )
}
