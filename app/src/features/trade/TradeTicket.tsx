// app/src/features/trade/TradeTicket.tsx
//
// Task 10: Long/Short + Size/Margin/Leverage form, live preview row, Open
// button. Week 6 (C.4): that form is the Open tab; the Close tab
// (`CloseTab.tsx`) closes part or all of the position via `decrease_position`. Leverage convention (`math.ts`'s header comment): a plain integer
// 1..10× (matches `ui/LeverageSlider`'s step). Changing Size or dragging the
// slider recomputes Margin at that leverage (`deriveTicket`, below, wraps
// `math.marginForLeverage`); typing a custom Margin overrides it until
// either changes again — `open_position` only ever sees the Margin field's
// current value, leverage is a UI convenience, not a program argument.
// Position slots: `position` is the SELECTED market's slot (null = no
// position there: Open only, no Close tab); `openBlocked` (all 16 slots taken
// elsewhere, `tradingRules.ts`'s `slotGate`) disables Open before sending.
// Insufficient-margin gate (post-launch smoke-test fix, 23.09.2026): see
// `deriveTicket`'s doc comment in `ticketMath.ts` (week 6: the pure math
// moved there so it runs under `npm test`; this file is render-only).
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
import { CloseTab } from './CloseTab'
import * as math from '@/src/lib/math'
import { formatUsd2 } from '@/src/lib/status'
import { clampLeverage, deriveTicket, impliedLeverage, safeLiq, submitLabel } from './ticketMath'
import { type SideName } from '@/src/lib/codecs'
import { type PositionSlot } from '@/src/lib/positions'
import { solSize, usdAmount, type OrderParams } from '@/src/lib/trade'
import { validateAttached, validateStopLimit } from '@/src/lib/orders'
import { parseAmount } from '@/src/lib/decimal'

export interface MarketParams {
  imrBps: bigint
  mmrBps: bigint
  openFeeBps: bigint
  closeFeeBps: bigint
  minSize: bigint
  /** Integer leverage cap of THIS market (`maxLeverage(max_lev_bps, imr_bps)`): the slider's and MAX's upper bound. */
  maxLeverage: number
}

/** Optional TP/SL (raw 1e6 prices, 0 = none) that ride along with an entry. */
export interface Exits {
  tp: bigint
  sl: bigint
}

type OrderType = 'market' | 'limit' | 'stop'

export interface TradeTicketProps {
  markUsd: bigint | null
  market: MarketParams | null
  freeMarginUsd: bigint | null
  /** Selected market symbol — the size field's unit. */
  symbol: string
  /** The selected market's slot; null when the trader has none there. */
  position: PositionSlot | null
  /** Set when Open must not be sent (no free slot): shown above the slider, and the Open button is disabled. */
  openBlocked: string | null
  busy: boolean
  disabled?: boolean
  /** Raw program units: size 1e9, margin/limit 1e6 — no number round trip on the way to `openPosition`. */
  onOpen: (side: SideName, size: bigint, margin: bigint, limitPrice: bigint, exits: Exits) => Promise<void>
  /** Limit/Stop entry: parked as a conditional order and executed when the mark reaches the trigger. */
  onPlace: (p: OrderParams) => Promise<void>
  /** Raw 1e9 size — `decrease_position`'s `close_size`. */
  onClose: (closeSize: bigint) => Promise<void>
}

export function TradeTicket({ position, onClose, ...open }: TradeTicketProps) {
  const [tab, setTab] = useState<'open' | 'close'>('open')
  const hasOpenPosition = position !== null
  // No slot on this market: the Close tab is not offered at all, and a full
  // close drops back to Open (render-time adjust, as in OpenForm below).
  if (!hasOpenPosition && tab === 'close') setTab('open')

  return (
    <Card>
      <Segment
        compact
        value={tab}
        onChange={setTab}
        options={
          hasOpenPosition
            ? [
                { value: 'open', label: 'Open' },
                { value: 'close', label: 'Close' },
              ]
            : [{ value: 'open', label: 'Open' }]
        }
      />
      {tab === 'open' ? (
        <OpenForm {...open} hasOpenPosition={hasOpenPosition} />
      ) : (
        <CloseTab
          // A fresh position starts with an empty field, not the last close's text.
          key={hasOpenPosition ? `${position.entry}` : 'none'}
          position={position}
          symbol={open.symbol}
          markUsd={open.markUsd}
          closeFeeBps={open.market?.closeFeeBps ?? null}
          minSize={open.market?.minSize ?? null}
          busy={open.busy}
          disabled={open.disabled}
          onClose={onClose}
        />
      )}
    </Card>
  )
}

type OpenFormProps = Omit<TradeTicketProps, 'position' | 'onClose'> & { hasOpenPosition: boolean }

function OpenForm({
  markUsd,
  market,
  freeMarginUsd,
  symbol,
  openBlocked,
  hasOpenPosition,
  busy,
  disabled,
  onOpen,
  onPlace,
}: OpenFormProps) {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')

  const [side, setSide] = useState<'long' | 'short'>('long')
  const [sizeSol, setSizeSol] = useState('0.1')
  const [marginUsd, setMarginUsd] = useState('20')
  const [leverage, setLeverage] = useState(2)
  const [orderType, setOrderType] = useState<OrderType>('market')
  const [triggerUsd, setTriggerUsd] = useState('')
  const [limitUsd, setLimitUsd] = useState('')
  const [tpUsd, setTpUsd] = useState('')
  const [slUsd, setSlUsd] = useState('')

  const sideName: SideName = side === 'long' ? 'Long' : 'Short'
  // A filled field is a positive number or an error — never a silent zero
  // (0 means "not set" to the program: no bound, no TP, no SL).
  const sizeIn = parseAmount(sizeSol)
  const triggerIn = parseAmount(triggerUsd)
  const limitIn = parseAmount(limitUsd)
  const tpIn = parseAmount(tpUsd)
  const slIn = parseAmount(slUsd)
  const sizeNum = sizeIn.value
  const sizeBig = sizeNum > 0 ? solSize(sizeNum) : 0n
  const triggerBig = triggerIn.value > 0 ? usdAmount(triggerIn.value) : 0n
  const isEntryOrder = orderType !== 'market'
  const limitBig = orderType === 'stop' && limitIn.value > 0 ? usdAmount(limitIn.value) : 0n
  const inputProblem =
    sizeIn.invalid ||
    tpIn.invalid ||
    slIn.invalid ||
    (isEntryOrder && triggerIn.invalid) ||
    (orderType === 'stop' && limitIn.invalid)
      ? 'Enter each price and size as a number above 0'
      : null
  // Price the position is expected to open at: the trigger for a resting
  // order, the current mark for a market order.
  const refPrice = isEntryOrder ? (triggerBig > 0n ? triggerBig : null) : markUsd
  const tpBig = tpIn.value > 0 ? usdAmount(tpIn.value) : 0n
  const slBig = slIn.value > 0 ? usdAmount(slIn.value) : 0n
  const exitProblem =
    inputProblem ??
    (refPrice !== null ? validateAttached(sideName, refPrice, tpBig, slBig) : null) ??
    (orderType === 'stop' && triggerBig > 0n ? validateStopLimit(sideName, triggerBig, limitBig) : null)
  const ntl = refPrice !== null && sizeBig > 0n ? math.notional(sizeBig, refPrice) : null
  const derived = deriveTicket({ sizeSol: sizeNum, leverage, markUsd: refPrice, available: freeMarginUsd })

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
  // The market's leverage cap (10 until the live `Market` has loaded). A
  // leverage carried over from a 10× market is clamped the moment a 5×
  // market's params arrive — same render-time adjust pattern as below.
  const maxLev = market?.maxLeverage ?? 10
  if (leverage > maxLev) setLeverage(clampLeverage(leverage, maxLev))

  const [prevSizeSol, setPrevSizeSol] = useState(sizeSol)
  const [prevLeverage, setPrevLeverage] = useState(leverage)
  if (sizeSol !== prevSizeSol || leverage !== prevLeverage) {
    setPrevSizeSol(sizeSol)
    setPrevLeverage(leverage)
    setMarginUsd(derived.marginUsd)
  }

  const marginNum = parseAmount(marginUsd).value
  const marginBig = marginNum > 0 ? usdAmount(marginNum) : 0n
  const feeUsd = ntl !== null && market ? math.fee(ntl, market.openFeeBps) : null
  const liq =
    ntl !== null && refPrice !== null && market && marginBig > 0n && sizeBig > 0n
      ? safeLiq(sideName, refPrice, sizeBig, marginBig, market.mmrBps)
      : null
  const limit = markUsd !== null ? math.openSlippageLimit(sideName, markUsd) : null

  const availableUsd = freeMarginUsd !== null ? formatUsd2(freeMarginUsd) : '—'

  // MAX: margin = available, then pick the smallest integer leverage (1..maxLev,
  // `LeverageSlider`'s step) whose derived margin doesn't exceed it —
  // `Math.ceil` (not "nearest") so `deriveTicket`'s pool-favoring round-up
  // lands at-or-under `available`, not over it. Syncs `prevLeverage` in the
  // same batch so the render-time effect above doesn't immediately
  // re-derive over this and undo it.
  function handleMax() {
    if (freeMarginUsd === null) return
    setMarginUsd(formatUsd2(freeMarginUsd))
    if (ntl !== null && freeMarginUsd > 0n) {
      const implied = impliedLeverage(ntl, freeMarginUsd, maxLev)
      setLeverage(implied)
      setPrevLeverage(implied)
    }
  }

  if (hasOpenPosition) {
    return (
      <View style={{ gap: space.md }}>
        <Segment
          tone="long-short"
          value={side}
          onChange={setSide}
          options={[
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
        />
        <Text style={[caption, { color: colors.textSecondary }]}>
          One position per market. Close it on the Close tab, or change it in Positions.
        </Text>
      </View>
    )
  }

  const canSubmit =
    !(disabled || busy || markUsd === null || derived.insufficient || openBlocked !== null || exitProblem !== null) &&
    (!isEntryOrder || triggerBig > 0n)

  function submit() {
    if (!isEntryOrder) {
      void onOpen(sideName, sizeBig, marginBig, limit ?? 0n, { tp: tpBig, sl: slBig })
      return
    }
    void onPlace({
      kind: orderType === 'limit' ? 'Limit' : 'Stop',
      side,
      size: sizeBig,
      margin: marginBig,
      trigger: triggerBig,
      tp: tpBig,
      sl: slBig,
      limit: limitBig,
    })
  }

  return (
    <View style={{ gap: space.md }}>
      <Segment
        compact
        value={orderType}
        onChange={setOrderType}
        options={[
          { value: 'market', label: 'Market' },
          { value: 'limit', label: 'Limit' },
          { value: 'stop', label: 'Stop' },
        ]}
      />
      <Segment
        tone="long-short"
        value={side}
        onChange={setSide}
        options={[
          { value: 'long', label: 'Long' },
          { value: 'short', label: 'Short' },
        ]}
      />
      {isEntryOrder ? (
        <Input
          label={orderType === 'limit' ? 'Limit price' : 'Trigger price'}
          value={triggerUsd}
          onChangeText={setTriggerUsd}
          suffix="USD"
          keyboardType="decimal-pad"
          hint={
            orderType === 'limit'
              ? 'Opens when the mark reaches this price from the better side'
              : 'Opens when the mark breaks through this price'
          }
        />
      ) : null}
      {orderType === 'stop' ? (
        <Input
          label="Limit price (optional)"
          value={limitUsd}
          onChangeText={setLimitUsd}
          suffix="USD"
          keyboardType="decimal-pad"
          placeholder="no limit"
          hint="Stop-limit: if the price gaps past this, the order waits instead of filling far from the trigger"
        />
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Input label="Size" value={sizeSol} onChangeText={setSizeSol} suffix={symbol} keyboardType="decimal-pad" />
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
      {openBlocked ? <Text style={[caption, { color: colors.short }]}>{openBlocked}</Text> : null}
      <LeverageSlider value={leverage} onChange={setLeverage} max={maxLev} />
      <View style={{ gap: space.xs }}>
        <Row
          label={isEntryOrder ? 'Entry at' : 'Entry ≈'}
          value={refPrice !== null ? `$${formatUsd2(refPrice)}` : '—'}
          mono
        />
        <Row label="Liq. price" value={liq !== null ? `$${formatUsd2(liq)}` : '—'} mono />
        <Row label="Fee" value={feeUsd !== null ? `${formatUsd2(feeUsd)} dUSDC` : '—'} mono />
        {isEntryOrder ? null : (
          <Row label="Slippage limit" value={limit !== null ? `$${formatUsd2(limit)}` : '—'} mono />
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Input
            label="Take profit"
            value={tpUsd}
            onChangeText={setTpUsd}
            suffix="USD"
            keyboardType="decimal-pad"
            placeholder="optional"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Input
            label="Stop loss"
            value={slUsd}
            onChangeText={setSlUsd}
            suffix="USD"
            keyboardType="decimal-pad"
            placeholder="optional"
          />
        </View>
      </View>
      {exitProblem ? <Text style={[caption, { color: colors.short }]}>{exitProblem}</Text> : null}
      {isEntryOrder ? (
        <Text style={[caption, { color: colors.textTertiary }]}>
          The margin is held while the order is open and comes back if you cancel it. The open fee is taken when it
          fills.
        </Text>
      ) : null}
      <Button variant={side === 'long' ? 'long' : 'destructive'} disabled={!canSubmit} onPress={submit}>
        {submitLabel({ busy, orderType, side, symbol })}
      </Button>
    </View>
  )
}
