// app/src/features/positions/PositionCard.tsx
//
// Task 10: open-position card per design — side/leverage header, Size/
// Entry/Mark/Margin/Liq. price rows, live uPnL, a liquidation-distance bar,
// Close/Increase/Decrease actions, and the "Recording commitment on-chain"
// pending badge for the 5-minute window right after Close (`Position.state
// === 'Closed' && !commitment_written`).
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Button } from '@/src/ui/Button'
import { computeUpnl, type DecodedPosition } from '@/src/lib/program'
import { notional } from '@/src/lib/math'

function usd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2)
}
function sol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

export interface PositionCardProps {
  position: DecodedPosition
  mark: bigint | null
  busy: boolean
  onClose: () => void
  onIncrease: () => void
  onDecrease: () => void
}

export function PositionCard({ position: p, mark, busy, onClose, onIncrease, onDecrease }: PositionCardProps) {
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const caption = useTextStyle('caption')

  const isClosedPendingCommitment = p.state === 'Closed' && p.closed !== null && !p.closed.commitmentWritten
  if (isClosedPendingCommitment) {
    return (
      <Card>
        <Badge tone="pending">Recording commitment on-chain (≤5 min)</Badge>
        <Text style={[caption, { color: colors.textSecondary }]}>
          Your {p.closed!.side} {sol(p.closed!.size)} SOL close is final — PnL {p.closed!.pnl >= 0n ? '+' : ''}
          {usd(p.closed!.pnl)} dUSDC. Follow it in History.
        </Text>
      </Card>
    )
  }
  if (p.state !== 'Open') return null

  const upnl = mark !== null ? computeUpnl(p.side, p.size, p.entry, mark) : null
  const upnlPct = upnl !== null && p.margin > 0n ? (Number(upnl) / Number(p.margin)) * 100 : null
  const entryNotional = notional(p.size, p.entry)
  const leverage = p.margin > 0n ? Number(entryNotional) / Number(p.margin) : null

  // Liquidation-distance bar: how far `mark` currently sits from `liqPrice`,
  // as a fraction of the distance between `entry` and `liqPrice` (0% = at
  // entry, 100% = at the liquidation price). Display-only, clamped to [0,1].
  const distanceFrac = (() => {
    if (mark === null) return null
    const span = Math.abs(Number(p.entry) - Number(p.liqPrice))
    if (span === 0) return null
    const traveled = p.side === 'Long' ? Number(p.entry) - Number(mark) : Number(mark) - Number(p.entry)
    return Math.min(1, Math.max(0, traveled / span))
  })()

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={[heading, { color: colors.textPrimary }]}>
          SOL-PERP · {p.side} · {leverage !== null ? leverage.toFixed(1) : '—'}×
        </Text>
        <Badge tone={p.side === 'Long' ? 'success' : 'danger'}>{p.side}</Badge>
      </View>
      <Row label="Size" value={`${sol(p.size)} SOL`} />
      <Row label="Entry" value={`$${usd(p.entry)}`} mono />
      <Row label="Mark" value={mark !== null ? `$${usd(mark)}` : '—'} mono />
      <Row
        label="Unrealized PnL"
        value={upnl !== null ? `${upnl >= 0n ? '+' : ''}$${usd(upnl)}${upnlPct !== null ? ` (${upnlPct >= 0 ? '+' : ''}${upnlPct.toFixed(1)}%)` : ''}` : '—'}
        tone={upnl === null ? undefined : upnl >= 0n ? 'success' : 'danger'}
      />
      <Row label="Margin" value={`$${usd(p.margin)}`} />
      <Row label="Liq. price" value={`$${usd(p.liqPrice)}`} />
      {distanceFrac !== null ? (
        <View style={{ gap: space.xs }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}>
            <View style={{ height: 4, width: `${(1 - distanceFrac) * 100}%`, backgroundColor: colors.warning }} />
          </View>
          <Text style={[caption, { color: colors.textTertiary }]}>{Math.round((1 - distanceFrac) * 100)}% away from liquidation</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" disabled={busy} onPress={onIncrease}>
            Increase
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" disabled={busy} onPress={onDecrease}>
            Decrease
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="destructive" disabled={busy} onPress={onClose}>
            Close
          </Button>
        </View>
      </View>
    </Card>
  )
}
