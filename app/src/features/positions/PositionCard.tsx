// app/src/features/positions/PositionCard.tsx
//
// Task 10: open-position card per design — side/leverage header, Size/
// Entry/Mark/Margin/Liq. price rows, live uPnL, a liquidation-distance bar,
// Close/Increase/Decrease actions.
//
// Week 5, Task 6: the "Recording commitment on-chain" pending badge this
// card used to render for `Position.state === 'Closed' && !commitmentWritten`
// is gone — `finalize_close` (week-5 Task 1) now pushes the `ClosedRecord`
// straight into `DisclosureQueue` and resets `Position` to `Empty` in the
// same instruction, so `Position.state` never observably sits at `Closed`
// on this client (`Position.closed` is always `None`, `DecodedPosition`
// no longer even carries the field — `program.ts`). That pending window is
// HistoryScreen's job now (`useHistoryRows.ts`'s `pending_commitment` row).
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Button } from '@/src/ui/Button'
import { computeUpnl, type DecodedPosition, type SideName } from '@/src/lib/program'
import { notional } from '@/src/lib/math'

function usd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2)
}
function sol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

/**
 * Liquidation-distance fraction: how far `mark` would have to move, as a
 * fraction of `mark` ITSELF, to reach `liqPrice` — `(mark - liq) / mark` for
 * Long, `(liq - mark) / mark` for Short. Clamped to `[0, 1]`.
 *
 * Bug this fixes (observed live, smoke test 23.09.2026): the old formula was
 * `(mark - liq) / (entry - liq)` — distance from `liqPrice` as a fraction of
 * the entry→liq span. Right after opening, `mark ≈ entry` by construction,
 * so that fraction reads ~100% ("100% away from liquidation", full
 * warning-tone bar) no matter how thin the actual price cushion is — e.g.
 * entry $116.73 / mark $116.71 / liq $64.22 rendered 100% even though mark
 * is already less than half its own liq-distance from `liqPrice`. Measuring
 * against `mark` instead answers the question the bar is actually for ("how
 * much can the CURRENT price move before I'm liquidated") — the same
 * numbers now read ~45%.
 */
export function liqDistancePct(side: SideName, mark: bigint, liq: bigint): number {
  if (mark === 0n) return 0
  const raw = side === 'Long' ? Number(mark - liq) / Number(mark) : Number(liq - mark) / Number(mark)
  return Math.min(1, Math.max(0, raw))
}

/**
 * Self-check, `lib/status.ts`'s style: asserts `liqDistancePct` against the
 * live-observed repro (mark $116.71 / liq $64.22 -> 45%, not the old
 * formula's ~100%) plus the Short-side mirror and the clamp edges. Throws on
 * mismatch; called once from `__DEV__` startup logging below.
 */
export function assertLiqDistancePctSelfCheck(): void {
  const MARK = 116_710_000n // $116.71
  const LIQ = 64_220_000n // $64.22
  const cases: [number, number][] = [
    [Math.round(liqDistancePct('Long', MARK, LIQ) * 100), 45], // the observed repro
    [Math.round(liqDistancePct('Short', 100_000_000n, 145_000_000n) * 100), 45], // Short mirror: liq above mark by the same 45%-of-mark gap
    [liqDistancePct('Long', MARK, MARK), 0], // at the liq price itself -> 0% away
    [liqDistancePct('Long', MARK, MARK + 1_000_000n), 0], // past liq (shouldn't happen live, but clamp holds) -> floor at 0
    [liqDistancePct('Short', MARK, MARK - 1_000_000n), 0], // Short past liq -> floor at 0
  ]
  for (const [got, expected] of cases) {
    if (got !== expected) {
      throw new Error(`assertLiqDistancePctSelfCheck: liqDistancePct mismatch — got ${got}, expected ${expected}`)
    }
  }
}

if (__DEV__) {
  try {
    assertLiqDistancePctSelfCheck()
    console.log('[dexxer] assertLiqDistancePctSelfCheck: liqDistancePct OK')
  } catch (e) {
    console.error('[dexxer] assertLiqDistancePctSelfCheck FAILED', e)
  }
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

  if (p.state !== 'Open') return null

  const upnl = mark !== null ? computeUpnl(p.side, p.size, p.entry, mark) : null
  const upnlPct = upnl !== null && p.margin > 0n ? (Number(upnl) / Number(p.margin)) * 100 : null
  const entryNotional = notional(p.size, p.entry)
  const leverage = p.margin > 0n ? Number(entryNotional) / Number(p.margin) : null

  // Liquidation-distance bar — see `liqDistancePct`'s doc comment above for
  // the bug this replaced. Display-only, [0,1].
  const liqPct = mark !== null ? liqDistancePct(p.side, mark, p.liqPrice) : null
  const liqTone =
    liqPct === null ? colors.warning : liqPct >= 0.25 ? colors.long : liqPct >= 0.1 ? colors.warning : colors.short

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
        value={
          upnl !== null
            ? `${upnl >= 0n ? '+' : ''}$${usd(upnl)}${upnlPct !== null ? ` (${upnlPct >= 0 ? '+' : ''}${upnlPct.toFixed(1)}%)` : ''}`
            : '—'
        }
        tone={upnl === null ? undefined : upnl >= 0n ? 'success' : 'danger'}
      />
      <Row label="Margin" value={`$${usd(p.margin)}`} />
      <Row label="Liq. price" value={`$${usd(p.liqPrice)}`} />
      {liqPct !== null ? (
        <View style={{ gap: space.xs }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}>
            <View style={{ height: 4, width: `${liqPct * 100}%`, backgroundColor: liqTone }} />
          </View>
          <Text style={[caption, { color: colors.textTertiary }]}>
            {Math.round(liqPct * 100)}% away from liquidation
          </Text>
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
