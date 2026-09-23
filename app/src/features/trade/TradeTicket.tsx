// app/src/features/trade/TradeTicket.tsx
//
// Task 10: Long/Short + Size/Margin/Leverage form, live preview row, Open
// button. Leverage convention (`math.ts`'s header comment): a plain integer
// 1..10× (matches `ui/LeverageSlider`'s step). Changing Size or dragging the
// slider recomputes Margin at that leverage (`deriveTicket`, below, wraps
// `math.marginForLeverage`); typing a custom Margin overrides it until
// either changes again — `open_position` only ever sees the Margin field's
// current value, leverage is a UI convenience, not a program argument.
// Insufficient-margin gate (post-launch smoke-test fix, 23.09.2026): see
// `deriveTicket`'s doc comment.
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

export interface DerivedTicket {
  /** Margin required at the current (size, leverage), 2-decimal USD string — `'0.00'` while size/mark aren't ready yet. */
  marginUsd: string
  /** `true` iff the derived margin exceeds `available` — `false` (never blocking) while `available` is still `null`/loading. */
  insufficient: boolean
}

/**
 * Pure margin math for the ticket's Margin field, extracted so it can run
 * through a `__DEV__` self-check below (this `app/` package has no test
 * runner wired up — same gap `lib/status.ts`/`lib/math.ts` work around).
 *
 * Bug this fixes (observed live, smoke test 23.09.2026): Size 2 SOL,
 * leverage 2×, Available 100 dUSDC — derived margin ≈$116.71 > 100, but the
 * Margin field showed a malformed `00.00` and "Open Long" stayed enabled.
 * Two separate defects: (1) the old render-time sync only recomputed Margin
 * when the LEVERAGE slider moved (`leverage !== prevLeverage`) — typing a
 * new Size at the already-selected default leverage left the field's text
 * state stale/unsynced from the real required margin, and a `ntl === null`
 * mid-keystroke (Size field momentarily empty/`0`) could set the text to a
 * bare `'0.00'` that then collided with the leftover characters RN's
 * Android decimal-pad `TextInput` was still composing, rendering the two
 * concatenated (`'0'` + `'0.00'` → `'00.00'`); (2) nothing ever compared
 * the margin against `freeMarginUsd`, so Open never blocked on
 * undercollateralization. `deriveTicket` is now the single source of truth
 * for both — one pure computation, always 2-decimal formatted, called
 * fresh every render (see the render-time sync below), so there is no
 * stale text to concatenate with.
 */
export function deriveTicket(args: {
  sizeSol: number
  leverage: number
  markUsd: bigint | null
  available: bigint | null
}): DerivedTicket {
  const { sizeSol, leverage, markUsd, available } = args
  const sizeBig = sizeSol > 0 ? solSize(sizeSol) : 0n
  if (markUsd === null || sizeBig === 0n) {
    return { marginUsd: '0.00', insufficient: false }
  }
  const ntl = math.notional(sizeBig, markUsd)
  const marginBig = math.marginForLeverage(ntl, leverage)
  return {
    marginUsd: usd(marginBig),
    insufficient: available !== null && marginBig > available,
  }
}

/**
 * Self-check, `lib/status.ts`'s style: asserts `deriveTicket` against the
 * live-observed repro (Size 2 SOL / 2× / mark $116.71 / available $100 →
 * insufficient, NOT `00.00`) plus the not-ready and sufficient-margin
 * branches. Throws on mismatch; called once from `__DEV__` startup logging
 * below.
 */
export function assertDeriveTicketSelfCheck(): void {
  const MARK = 116_710_000n // $116.71 (the smoke-test mark for both this bug and PositionCard's)
  const cases: [DerivedTicket, DerivedTicket][] = [
    // not ready: no mark yet -> '0.00', never blocking
    [
      deriveTicket({ sizeSol: 2, leverage: 2, markUsd: null, available: 100_000_000n }),
      { marginUsd: '0.00', insufficient: false },
    ],
    // not ready: no size yet -> '0.00', never blocking
    [
      deriveTicket({ sizeSol: 0, leverage: 2, markUsd: MARK, available: 100_000_000n }),
      { marginUsd: '0.00', insufficient: false },
    ],
    // the observed repro: 2 SOL @ 2x @ $116.71 -> $116.71 margin, > $100 available
    [
      deriveTicket({ sizeSol: 2, leverage: 2, markUsd: MARK, available: 100_000_000n }),
      { marginUsd: '116.71', insufficient: true },
    ],
    // same size/mark at 5x -> $46.68 margin, <= $50 available -> not insufficient
    [
      deriveTicket({ sizeSol: 2, leverage: 5, markUsd: MARK, available: 50_000_000n }),
      { marginUsd: '46.68', insufficient: false },
    ],
    // available unknown (still loading) -> never blocks, regardless of margin size
    [
      deriveTicket({ sizeSol: 2, leverage: 2, markUsd: MARK, available: null }),
      { marginUsd: '116.71', insufficient: false },
    ],
  ]
  for (const [got, expected] of cases) {
    if (got.marginUsd !== expected.marginUsd || got.insufficient !== expected.insufficient) {
      throw new Error(
        `assertDeriveTicketSelfCheck: mismatch — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      )
    }
  }
}

if (__DEV__) {
  try {
    assertDeriveTicketSelfCheck()
    console.log('[dexxer] assertDeriveTicketSelfCheck: deriveTicket OK')
  } catch (e) {
    console.error('[dexxer] assertDeriveTicketSelfCheck FAILED', e)
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
  const derived = deriveTicket({ sizeSol: sizeNum, leverage, markUsd, available: freeMarginUsd })

  // Recompute Margin from (size, leverage) whenever EITHER changes — the
  // React-docs "adjust state when [something] changes" pattern (during
  // render, not a `useEffect` + `setState`, which the project's react-hooks
  // lint flags as a cascading-render risk; `ui/Sheet.tsx` uses the same
  // pattern for its own render-triggered state adjustment). Fixed to key
  // off Size too (used to be leverage-only — see `deriveTicket`'s doc
  // comment for the bug that caused): typing a new Size at the default
  // leverage now correctly re-derives Margin instead of leaving it stale.
  // `deriveTicket` (always 2dp, `'0.00'` while not ready) is the sole
  // source of the synced text, so there's nothing stale left to concatenate
  // into a malformed value.
  const [prevSizeSol, setPrevSizeSol] = useState(sizeSol)
  const [prevLeverage, setPrevLeverage] = useState(leverage)
  if (sizeSol !== prevSizeSol || leverage !== prevLeverage) {
    setPrevSizeSol(sizeSol)
    setPrevLeverage(leverage)
    setMarginUsd(derived.marginUsd)
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

  // MAX: margin = available, then pick the smallest integer leverage (1..10,
  // `LeverageSlider`'s step) whose derived margin doesn't exceed it —
  // `Math.ceil` (not "nearest") so `deriveTicket`'s pool-favoring round-up
  // lands at-or-under `available`, not over it. Syncs `prevLeverage` in the
  // same batch so the render-time effect above doesn't immediately
  // re-derive over this and undo it.
  function handleMax() {
    if (freeMarginUsd === null) return
    setMarginUsd(usd(freeMarginUsd))
    if (ntl !== null && freeMarginUsd > 0n) {
      const implied = Math.min(10, Math.max(1, Math.ceil(Number(ntl) / Number(freeMarginUsd))))
      setLeverage(implied)
      setPrevLeverage(implied)
    }
  }

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
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Input label="Size" value={sizeSol} onChangeText={setSizeSol} suffix="SOL" keyboardType="decimal-pad" />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            label="Margin"
            value={marginUsd}
            onChangeText={setMarginUsd}
            suffix="dUSDC"
            keyboardType="decimal-pad"
            onMax={freeMarginUsd !== null ? handleMax : undefined}
          />
        </View>
      </View>
      <Text style={[caption, { color: colors.textTertiary }]}>Available: {availableUsd} dUSDC</Text>
      {derived.insufficient ? (
        <Text style={[caption, { color: colors.short }]}>Insufficient margin — lower size or leverage, or deposit</Text>
      ) : null}
      <LeverageSlider value={leverage} onChange={setLeverage} />
      <View style={{ gap: space.xs }}>
        <Row label="Entry ≈" value={markUsd !== null ? `$${usd(markUsd)}` : '—'} />
        <Row label="Liq. price" value={liq !== null ? `$${usd(liq)}` : '—'} />
        <Row label="Fee" value={feeUsd !== null ? `${usd(feeUsd)} dUSDC` : '—'} />
        <Row label="Slippage limit" value={limit !== null ? `$${usd(limit)}` : '—'} />
      </View>
      <Button
        variant={side === 'long' ? 'primary' : 'destructive'}
        disabled={disabled || busy || markUsd === null || derived.insufficient}
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
