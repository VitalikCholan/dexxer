// app/src/features/trade/TradeScreen.tsx
//
// Task 10: full Trade screen per design — header (mark + 24h change + Pyth
// Lazer freshness badge), PriceChart (1m/5m/15m), TradeTicket (Open
// Long/Short — session-signed, no MWA prompt), stale-oracle and
// session-expired banners. Close/Increase/Decrease moved to the Positions
// screen (Task 10); week 6 (C.4) brings partial/full close back as the
// ticket's Close tab (`decrease_position`). Week 6 (C.6-A): the chart
// collapses (`ChartSection`), and Positions (n) / Open Orders (n) sit
// under the ticket (`TradeActivity`).
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
import { useCandles, useIndexerConnected, useMark, usePoolHistory } from '@/src/lib/indexer'
import { decodePosition, decodeUserAccount, readMarket, type SideName } from '@/src/lib/codecs'
import { describeTxError } from '@/src/lib/errors'
import { decreasePosition, openPosition } from '@/src/lib/trade'
import * as math from '@/src/lib/math'
import { ChartSection, type Tf } from './ChartSection'
import { TradeActivity } from './TradeActivity'
import { TradeHeader } from './TradeHeader'
import { MarketInfoCard } from './MarketInfoCard'
import { maxLeverage, rangeStats } from './headerStats'
import { TradeTicket, type MarketParams } from './TradeTicket'
import { decodeTicketMarket } from './marketLimits'
import { useTradeSession } from './useTradeSession'
import { LOW_SESSION_ACTIONS } from '@/src/lib/session'
import { useOnboardingGate } from '../onboard/useOnboardingGate'

export function TradeScreen() {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')

  const { session, conn, accounts, loading, error: sessionError } = useTradeSession()
  const gate = useOnboardingGate()
  const [tf, setTf] = useState<Tf>('1m')
  const [busy, setBusy] = useState(false)

  const positionLive = useLiveAccount(conn, accounts?.position ?? null, decodePosition)
  const marketLive = useLiveAccount(conn, accounts?.market ?? null, decodeTicketMarket)
  const userLive = useLiveAccount(conn, accounts?.userAccount ?? null, decodeUserAccount)
  const mark = useMark()
  const change24h = useCandles('15m', 96)
  const pool = usePoolHistory(1)
  const indexerConnected = useIndexerConnected()

  const position = positionLive.value
  const marketMark = marketLive.value?.mark ?? null
  const markUsd = mark.data?.price ?? marketMark
  const markUsdNum = markUsd !== null ? Number(markUsd) / 1e6 : null

  // Single source of truth for "is the oracle good enough to trade on" — the
  // freshness dot, the paused banner, and the Open button's `disabled` all
  // derive from this ONE predicate (fix round 1: previously the dot alone
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
  const dotColor = oracle.ok ? colors.long : colors.warning

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

  const marketParams: MarketParams | null = marketLive.value
    ? {
        imrBps: BigInt(marketLive.value.imrBps),
        mmrBps: BigInt(marketLive.value.mmrBps),
        openFeeBps: BigInt(marketLive.value.openFeeBps),
        closeFeeBps: BigInt(marketLive.value.closeFeeBps),
        minSize: marketLive.value.minSize,
      }
    : null

  const handleOpen = useCallback(
    async (side: SideName, size: bigint, margin: bigint, limitPrice: bigint) => {
      if (!conn || !session || !accounts) return
      setBusy(true)
      try {
        const mkt = await readMarket(conn, accounts.market)
        if (!mkt || mkt.mark === 0n) throw new Error('Market has no mark price yet')
        await openPosition(conn, session, accounts, side === 'Long' ? 'long' : 'short', size, margin, limitPrice)
        showToast({ tone: 'success', text: `Opened ${side} ${Number(size) / 1_000_000_000} SOL` })
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
          text: closeSize === position.size ? 'Position closed' : `Closed ${Number(closeSize) / 1_000_000_000} SOL`,
        })
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, session, accounts, position, markUsd],
  )

  return (
    <Page>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <TradeHeader
          markUsdNum={markUsdNum}
          pctChange={pctChange}
          dotColor={dotColor}
          maxLeverage={marketLive.value ? maxLeverage(marketLive.value.maxLevBps, marketLive.value.imrBps) : null}
          range={rangeStats(change24h.data, now * 1000)}
          poolLiquidity={pool.data?.length ? pool.data[pool.data.length - 1].capitalTotal : null}
        />

        <ChartSection tf={tf} onTfChange={setTf} markUsd={markUsdNum} />

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
        {gate.status === 'needs_setup' ? null : sessionError || positionLive.error || marketLive.error ? (
          <Text style={[caption, { color: colors.short }]}>
            {sessionError ?? positionLive.error ?? marketLive.error}
          </Text>
        ) : null}

        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <TradeTicket
            markUsd={markUsd}
            market={marketParams}
            freeMarginUsd={userLive.value?.freeMargin ?? null}
            position={position}
            busy={busy}
            disabled={tradingPaused || sessionExpired || sessionUsedUp || !session}
            onOpen={handleOpen}
            onClose={handleClose}
          />
        )}

        <TradeActivity position={position} markUsd={markUsd} />

        <MarketInfoCard market={marketLive.value} />
      </ScrollView>
    </Page>
  )
}
