// app/src/features/trade/TradeScreen.tsx
//
// Task 10: full Trade screen per design — header (mark + 24h change + Pyth
// Lazer freshness badge), the chart (C.5: `chart/TradingChart`), TradeTicket (Open
// Long/Short — session-signed, no MWA prompt), stale-oracle and
// session-expired banners. Close/Increase/Decrease moved to the Positions
// screen (Task 10); week 6 (C.4) brings partial/full close back as the
// ticket's Close tab (`decrease_position`). Week 6 (C.6-A): the chart
// collapses (`ChartSection`), and Positions (n) / Open Orders (n) sit
// under the ticket (`TradeActivity`). Position slots: everything is for the
// globally selected market (`useSelectedMarket`) — its PDA, live `Market`
// (feed, params), mark and candles, and its slot of the owner's `Positions`
// (`slotGate`: never another market's slot; Open blocked when all 16 slots
// are taken elsewhere).
import { useCallback, useMemo, useState } from 'react'
import { router } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { Page } from '@/src/ui/Page'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Badge } from '@/src/ui/Badge'
import { Button } from '@/src/ui/Button'
import { Skeleton } from '@/src/ui/Skeleton'
import { showToast } from '@/src/ui/Toast'
import { useLiveAccount } from '@/src/lib/live'
import { useCandles, useIndexerConnected, useMark } from '@/src/lib/indexer'
import { decodeUserAccount, readMarket, type SideName } from '@/src/lib/codecs'
import { describeTxError } from '@/src/lib/errors'
import { useSelectedMarket } from '@/src/lib/markets'
import { pdas } from '@/src/lib/pdas'
import { decodePositions, ordersFor } from '@/src/lib/positions'
import {
  cancelOrder,
  decreasePosition,
  openPosition,
  placeOrder,
  tradeAccountsFor,
  type OrderParams,
} from '@/src/lib/trade'
import * as math from '@/src/lib/math'
import { ChartSection, type Tf } from './ChartSection'
import { TradeActivity } from './TradeActivity'
import { TradeHeader } from './TradeHeader'
import { maxLeverage, rangeStats } from './headerStats'
import { TradeTicket, type Exits, type MarketParams } from './TradeTicket'
import { decodeTicketMarket } from './marketLimits'
import { slotGate } from './tradingRules'
import { useTradeSession } from './useTradeSession'
import { LOW_SESSION_ACTIONS } from '@/src/lib/session'
import { useOnboardingGate } from '../onboard/useOnboardingGate'

export function TradeScreen() {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')

  const { symbol } = useSelectedMarket()
  const { session, conn, base, loading, error: sessionError } = useTradeSession()
  const gate = useOnboardingGate()
  const [tf, setTf] = useState<Tf>('1m')
  const [busy, setBusy] = useState(false)

  const marketPda = useMemo(() => pdas.marketFor(symbol), [symbol])
  const positionsLive = useLiveAccount(conn, base?.positions ?? null, decodePositions)
  const marketLive = useLiveAccount(conn, base ? marketPda : null, decodeTicketMarket)
  const userLive = useLiveAccount(conn, base?.userAccount ?? null, decodeUserAccount)
  const mark = useMark(symbol)
  const change24h = useCandles(symbol, '15m', 96)
  const indexerConnected = useIndexerConnected()

  // Right after a switch the subscription still holds the previous market for
  // one render — never pair its feed or params with the new market's PDA.
  const market = marketLive.value?.symbol === symbol ? marketLive.value : null
  const accounts = useMemo(
    () => (base && market ? tradeAccountsFor(base, { market: marketPda, feed: market.feed }) : null),
    [base, market, marketPda],
  )
  const { slot: position, openBlocked } = slotGate(positionsLive.value, marketPda)
  const marketMark = market?.mark ?? null
  const markUsd = mark.data?.price ?? marketMark
  const markUsdNum = markUsd !== null ? Number(markUsd) / 1e6 : null

  // Single source of truth for "is the oracle good enough to trade on" — the
  // paused banner and the Open button's `disabled` both derive from this ONE
  // predicate (the header's freshness dot was removed 05.10.2026) (fix round 1: previously the dot alone
  // also gated on `indexerConnected`/loading, while the banner and
  // `disabled` only checked `stale === true` — a disconnected or still-
  // loading feed showed a yellow dot with no banner and a still-enabled
  // Open button).
  const oracle = useMemo((): { ok: boolean; reason: 'loading' | 'stale' | 'disconnected' | null } => {
    if (mark.isLoading || mark.data === undefined) return { ok: false, reason: 'loading' }
    if (mark.data.stale) return { ok: false, reason: 'stale' }
    if (!indexerConnected) return { ok: false, reason: 'disconnected' }
    return { ok: true, reason: null }
  }, [mark.isLoading, mark.data, indexerConnected])
  const tradingPaused = !oracle.ok

  const pctChange = (() => {
    const c = change24h.data
    if (!c || c.length < 2) return null
    const first = c[0].c
    const last = c[c.length - 1].c
    return first === 0 ? null : ((last - first) / first) * 100
  })()

  // Wall-clock read during render: only needs to be approximately right
  // (re-evaluated on every push/re-render, not a ticking clock) — same class
  // of intentional impure-during-render read the codebase already accepts
  // elsewhere via a justified lint escape hatch.
  // eslint-disable-next-line react-hooks/purity
  const now = Math.floor(Date.now() / 1000)
  const sessionExpired =
    userLive.value !== null && userLive.value.sessionExpiry > 0n && userLive.value.sessionExpiry < BigInt(now)
  // Week 6: the session's action budget — spent one per trade, refilled only
  // by `set_session`. 0 is as blocking as an expiry (error 6021); at or below
  // `LOW_SESSION_ACTIONS` the user is warned while trading still works.
  const actionsLeft = userLive.value?.actionsLeft ?? null
  const sessionUsedUp = !sessionExpired && actionsLeft === 0
  const sessionLow = !sessionExpired && actionsLeft !== null && actionsLeft > 0 && actionsLeft <= LOW_SESSION_ACTIONS

  const marketParams: MarketParams | null = market
    ? {
        imrBps: BigInt(market.imrBps),
        mmrBps: BigInt(market.mmrBps),
        openFeeBps: BigInt(market.openFeeBps),
        closeFeeBps: BigInt(market.closeFeeBps),
        minSize: market.minSize,
        maxLeverage: maxLeverage(market.maxLevBps, market.imrBps),
      }
    : null

  const handleOpen = useCallback(
    async (side: SideName, size: bigint, margin: bigint, limitPrice: bigint, exits: Exits) => {
      if (!conn || !session || !accounts) return
      if (openBlocked) {
        showToast({ tone: 'danger', text: openBlocked })
        return
      }
      setBusy(true)
      try {
        const mkt = await readMarket(conn, accounts.market)
        if (!mkt || mkt.mark === 0n) throw new Error('Market has no mark price yet')
        await openPosition(conn, session, accounts, side === 'Long' ? 'long' : 'short', size, margin, limitPrice)
        showToast({ tone: 'success', text: `Opened ${side} ${Number(size) / 1_000_000_000} ${symbol}` })
        // TP/SL ride along as separate session-signed orders right after the
        // open lands. A failure here must not look like a failed open.
        for (const [kind, trigger] of [
          ['TakeProfit', exits.tp],
          ['StopLoss', exits.sl],
        ] as const) {
          if (trigger === 0n) continue
          try {
            await placeOrder(conn, session, accounts, { kind, trigger })
          } catch (e) {
            showToast({ tone: 'danger', text: `Position opened, but ${kind} was not set: ${describeTxError(e)}` })
          }
        }
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, session, accounts, openBlocked, symbol],
  )

  const handlePlace = useCallback(
    async (p: OrderParams) => {
      if (!conn || !session || !accounts) return
      setBusy(true)
      try {
        await placeOrder(conn, session, accounts, p)
        showToast({ tone: 'success', text: `${p.kind} order placed` })
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, session, accounts],
  )

  const handleCancel = useCallback(
    async (slot: number) => {
      if (!conn || !session || !accounts) return
      setBusy(true)
      try {
        await cancelOrder(conn, session, accounts, slot)
        showToast({ tone: 'success', text: 'Order cancelled' })
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, session, accounts],
  )

  const handleClose = useCallback(
    async (closeSize: bigint) => {
      if (!conn || !session || !accounts || !position || markUsd === null) return
      setBusy(true)
      try {
        const limit = math.closeSlippageLimit(position.side, markUsd)
        await decreasePosition(conn, session, accounts, closeSize, limit)
        showToast({
          tone: 'success',
          text:
            closeSize === position.size ? 'Position closed' : `Closed ${Number(closeSize) / 1_000_000_000} ${symbol}`,
        })
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, session, accounts, position, markUsd, symbol],
  )

  return (
    <Page>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <TradeHeader
          symbol={symbol}
          markUsdNum={markUsdNum}
          pctChange={pctChange}
          maxLeverage={market ? maxLeverage(market.maxLevBps, market.imrBps) : null}
          range={rangeStats(change24h.data, now * 1000)}
        />

        <ChartSection symbol={symbol} tf={tf} onTfChange={setTf} position={position} market={market} />

        {oracle.reason === 'loading' ? (
          <Skeleton lines={1} />
        ) : oracle.reason === 'stale' ? (
          <Badge tone="warning">Oracle price is stale — trading paused</Badge>
        ) : oracle.reason === 'disconnected' ? (
          <Badge tone="warning">Price feed disconnected — trading paused</Badge>
        ) : null}
        {gate.status === 'needs_setup' ? (
          <View style={{ gap: space.sm }}>
            <Badge tone="warning">Private account not set up on this device</Badge>
            <Button variant="secondary" onPress={() => router.push('/onboard')}>
              Set up private account
            </Button>
          </View>
        ) : sessionExpired || sessionUsedUp ? (
          <View style={{ gap: space.sm }}>
            <Badge tone="danger">{sessionUsedUp ? 'Session used up' : 'Session expired'}</Badge>
            <Button variant="secondary" onPress={() => router.push({ pathname: '/onboard', params: { reauth: '1' } })}>
              Re-authorize session
            </Button>
          </View>
        ) : sessionLow ? (
          <View style={{ gap: space.sm }}>
            <Badge tone="warning">{`Session key: ${actionsLeft} action${actionsLeft === 1 ? '' : 's'} left`}</Badge>
            <Button variant="secondary" onPress={() => router.push({ pathname: '/onboard', params: { reauth: '1' } })}>
              Re-authorize session
            </Button>
          </View>
        ) : null}
        {gate.status === 'needs_setup' ? null : sessionError || positionsLive.error || marketLive.error ? (
          <Text style={[caption, { color: colors.short }]}>
            {sessionError ?? positionsLive.error ?? marketLive.error}
          </Text>
        ) : null}

        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <TradeTicket
            // A market switch starts a fresh ticket: no size typed for one market lands on another.
            key={symbol}
            symbol={symbol}
            markUsd={markUsd}
            market={marketParams}
            freeMarginUsd={userLive.value?.freeMargin ?? null}
            position={position}
            openBlocked={openBlocked}
            busy={busy}
            // Not set up (or still checking): a live-looking Open would only fail after "Signing…".
            disabled={tradingPaused || sessionExpired || sessionUsedUp || !session || gate.status !== 'ready'}
            onOpen={handleOpen}
            onPlace={handlePlace}
            onClose={handleClose}
          />
        )}

        <TradeActivity
          symbol={symbol}
          position={position}
          markUsd={markUsd}
          orders={ordersFor(positionsLive.value, marketPda)}
          busy={busy}
          onCancel={(slot) => void handleCancel(slot)}
        />
      </ScrollView>
    </Page>
  )
}
