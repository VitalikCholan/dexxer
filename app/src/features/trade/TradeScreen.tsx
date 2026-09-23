// app/src/features/trade/TradeScreen.tsx
//
// Task 10: full Trade screen per design — header (mark + 24h change + Pyth
// Lazer freshness badge), PriceChart (1m/5m/15m), TradeTicket (Open
// Long/Short — session-signed, no MWA prompt), stale-oracle and
// session-expired banners. Close/Increase/Decrease moved to the Positions
// screen (Task 10) — this screen only opens.
import { useCallback, useMemo, useState } from 'react'
import { router } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { AppPage } from '@/components/app-page'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Segment } from '@/src/ui/Segment'
import { Badge } from '@/src/ui/Badge'
import { Button } from '@/src/ui/Button'
import { Skeleton } from '@/src/ui/Skeleton'
import { showToast } from '@/src/ui/Toast'
import { useLiveAccount } from '@/src/lib/live'
import { useCandles, useIndexerConnected, useMark } from '@/src/lib/indexer'
import {
  decodeMarket,
  decodePosition,
  decodeUserAccount,
  describeTxError,
  openPosition,
  readMarket,
  type SideName,
} from '@/src/lib/program'
import { PriceChart } from './PriceChart'
import { TradeHeader } from './TradeHeader'
import { TradeTicket, type MarketParams } from './TradeTicket'
import { useTradeSession } from './useTradeSession'

type Tf = '1m' | '5m' | '15m'

export function TradeScreen() {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')

  const { session, conn, accounts, loading, error: sessionError } = useTradeSession()
  const [tf, setTf] = useState<Tf>('1m')
  const [busy, setBusy] = useState(false)

  const positionLive = useLiveAccount(conn, accounts?.position ?? null, decodePosition)
  const marketLive = useLiveAccount(conn, accounts?.market ?? null, decodeMarket)
  const userLive = useLiveAccount(conn, accounts?.userAccount ?? null, decodeUserAccount)
  const mark = useMark()
  const change24h = useCandles('15m', 96)
  const indexerConnected = useIndexerConnected()

  const hasOpenPosition = positionLive.value?.state === 'Open'
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

  const marketParams: MarketParams | null = marketLive.value
    ? {
        imrBps: BigInt(marketLive.value.imrBps),
        mmrBps: BigInt(marketLive.value.mmrBps),
        openFeeBps: BigInt(marketLive.value.openFeeBps),
      }
    : null

  const handleOpen = useCallback(
    async (side: SideName, sizeSol: number, marginUsd: number, limitUsd: number) => {
      if (!conn || !session || !accounts) return
      setBusy(true)
      try {
        const mkt = await readMarket(conn, accounts.market)
        if (!mkt || mkt.mark === 0n) throw new Error('Market has no mark price yet')
        await openPosition(conn, session, accounts, side === 'Long' ? 'long' : 'short', sizeSol, marginUsd, limitUsd)
        showToast({ tone: 'success', text: `Opened ${side} ${sizeSol} SOL` })
      } catch (e) {
        showToast({ tone: 'danger', text: describeTxError(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, session, accounts],
  )

  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <TradeHeader markUsdNum={markUsdNum} pctChange={pctChange} dotColor={dotColor} />

        <View style={{ gap: space.sm }}>
          <PriceChart tf={tf} markUsd={markUsdNum} />
          <Segment
            compact
            value={tf}
            onChange={setTf}
            options={[
              { value: '1m', label: '1m' },
              { value: '5m', label: '5m' },
              { value: '15m', label: '15m' },
            ]}
          />
        </View>

        {oracle.reason === 'loading' ? (
          <Skeleton lines={1} />
        ) : oracle.reason === 'stale' ? (
          <Badge tone="warning">Oracle price is stale — trading paused</Badge>
        ) : oracle.reason === 'disconnected' ? (
          <Badge tone="warning">Price feed disconnected — trading paused</Badge>
        ) : null}
        {sessionExpired ? (
          <View style={{ gap: space.sm }}>
            <Badge tone="danger">Session expired</Badge>
            <Button variant="secondary" onPress={() => router.push('/onboard')}>
              Re-authorize session
            </Button>
          </View>
        ) : null}
        {sessionError || positionLive.error || marketLive.error ? (
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
            hasOpenPosition={hasOpenPosition}
            busy={busy}
            disabled={tradingPaused || sessionExpired || !session}
            onOpen={handleOpen}
          />
        )}
      </ScrollView>
    </AppPage>
  )
}
