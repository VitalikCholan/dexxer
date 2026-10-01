// app/src/features/trade/CloseTab.tsx
//
// The ticket's Close tab (C.4): a partial or full close by size, through
// `decrease_position(close_size, …)` — closing the whole size is a full close
// on-chain (`finalize_close`), so one instruction covers both. MAX fills the
// exact on-chain size, so it closes fully even when the size has more
// precision than the field shows.
import { useState } from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Input } from '@/src/ui/Input'
import { Row } from '@/src/ui/Row'
import { Button } from '@/src/ui/Button'
import { formatUsd2 } from '@/src/lib/status'
import { type PositionSlot } from '@/src/lib/positions'
import { computeUpnl, solSize } from '@/src/lib/trade'
import { closeBlock, closePreview } from './ticketMath'

export interface CloseTabProps {
  /** The selected market's slot — null when the trader has no position on it. */
  position: PositionSlot | null
  /** Market symbol for the size labels. */
  symbol: string
  markUsd: bigint | null
  /** `Market.close_fee_bps` / `min_size` — null while the market is loading. */
  closeFeeBps: bigint | null
  minSize: bigint | null
  busy: boolean
  disabled?: boolean
  /** Raw 1e9 size to close — `decrease_position`'s `close_size`. */
  onClose: (closeSize: bigint) => Promise<void>
}

function sol(raw: bigint): string {
  return (Number(raw) / 1e9).toFixed(4)
}
function signedUsd(raw: bigint): string {
  return `${raw >= 0n ? '+' : '−'}$${formatUsd2(raw >= 0n ? raw : -raw)}`
}

export function CloseTab({ position, symbol, markUsd, closeFeeBps, minSize, busy, disabled, onClose }: CloseTabProps) {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')
  const [closeSizeText, setCloseSizeText] = useState('')
  /** Set by MAX, cleared by typing: sends the exact size rather than its 4-dp rendering. */
  const [all, setAll] = useState(false)

  if (!position) {
    return <Text style={[caption, { color: colors.textSecondary }]}>No open position to close.</Text>
  }

  const typed = Number(closeSizeText)
  const closeSize = all ? position.size : Number.isFinite(typed) && typed > 0 ? solSize(typed) : 0n
  const block = closeBlock(closeSize, position.size, minSize)
  const full = closeSize === position.size
  const preview =
    markUsd !== null && closeSize > 0n && block !== 'exceeds'
      ? closePreview(
          position.side,
          closeSize,
          position.size,
          position.entry,
          position.margin,
          markUsd,
          closeFeeBps ?? 0n,
        )
      : null
  const upnl = markUsd !== null ? computeUpnl(position.side, position.size, position.entry, markUsd) : null

  const warning =
    block === 'exceeds'
      ? `More than the open ${sol(position.size)} ${symbol}`
      : block === 'remainder_below_min'
        ? `Would leave less than the ${minSize !== null ? sol(minSize) : '—'} ${symbol} minimum — close all instead`
        : null

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <Row
          label="Position"
          value={`${position.side} ${sol(position.size)} ${symbol} @ $${formatUsd2(position.entry)}`}
          tone={position.side === 'Long' ? 'success' : 'danger'}
        />
        <Row
          label="Unrealized PnL"
          value={upnl !== null ? signedUsd(upnl) : '—'}
          tone={upnl === null ? undefined : upnl >= 0n ? 'success' : 'danger'}
        />
      </View>

      <Input
        label="Close size"
        value={closeSizeText}
        onChangeText={(t) => {
          setAll(false)
          setCloseSizeText(t)
        }}
        suffix={symbol}
        keyboardType="decimal-pad"
        hint={`Open: ${sol(position.size)} ${symbol}`}
        onMax={() => {
          setAll(true)
          setCloseSizeText(sol(position.size))
        }}
      />
      {warning ? <Text style={[caption, { color: colors.short }]}>{warning}</Text> : null}

      <View style={{ gap: space.xs }}>
        <Row label="Exit ≈" value={markUsd !== null ? `$${formatUsd2(markUsd)}` : '—'} mono />
        <Row
          label="Realized PnL ≈"
          value={preview !== null ? signedUsd(preview.pnl) : '—'}
          tone={preview === null ? undefined : preview.pnl >= 0n ? 'success' : 'danger'}
        />
        <Row label="Close fee" value={preview !== null ? `${formatUsd2(preview.fee)} dUSDC` : '—'} />
        <Row label="Margin released" value={preview !== null ? `${formatUsd2(preview.released)} dUSDC` : '—'} />
      </View>

      <Button
        variant="destructive"
        disabled={disabled || busy || markUsd === null || block !== null}
        onPress={() => void onClose(closeSize)}
      >
        {busy ? 'Signing with session key…' : full ? 'Close position' : `Close ${sol(closeSize)} ${symbol}`}
      </Button>
    </View>
  )
}
