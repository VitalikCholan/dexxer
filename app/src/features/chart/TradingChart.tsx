// app/src/features/chart/TradingChart.tsx
//
// C.5: the TradingView-style chart — lightweight-charts in a WebView
// (`chartHtml.ts`), fed from the indexer's candles with the live mark folded
// into the last bar (`chartData.ts`). Pan and pinch-zoom, crosshair with an
// OHLC row, High/Low of the visible range and the mark's last-price line are
// the library's (driven from the page), plus −/+/↺ zoom buttons for one-hand
// use; the toolbar here picks the
// timeframe, the chart type (starred types get a quick-access chip, the rest
// are in a sheet), auto/log scale, EMA(20) and entry / liq lines of the open
// position. All 16 timeframes; live marks fold in via `useMarkTail`.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Pressable, ScrollView, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { useCandles, useMark } from '@/src/lib/indexer'
import { type PositionSlot } from '@/src/lib/positions'
import {
  CHART_TYPES,
  TIMEFRAMES,
  ema,
  fillWhitespace,
  foldMarks,
  seriesFor,
  type ChartType,
  type Tf,
} from './chartData'
import { chartHtml, type ChartColors } from './chartHtml'
import { useChartPrefs } from './useChartPrefs'
import { useMarkTail } from './useMarkTail'

const HEIGHT = 300
const EMA_PERIOD = 20

export interface TradingChartProps {
  /** Market symbol whose candles are drawn. */
  symbol: string
  tf: Tf
  onTfChange: (tf: Tf) => void
  /** The same market's slot — entry / liq lines; null when there is none. */
  position: PositionSlot | null
}

function Pill({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  const { colors, space, radius, border } = useTheme()
  const style = useTextStyle('caption', { mono: true })
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderRadius: radius.sm,
        borderWidth: border.hairline,
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accentSubtle : pressed ? colors.surfaceAlt : colors.bgElevated,
      })}
    >
      <Text style={[style, { color: active ? colors.textPrimary : colors.textSecondary }]}>{label}</Text>
    </Pressable>
  )
}

export function TradingChart({ symbol, tf, onTfChange, position }: TradingChartProps) {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')
  const body = useTextStyle('body')
  const candles = useCandles(symbol, tf)
  const [prefs, setPrefs] = useChartPrefs()
  const [picker, setPicker] = useState(false)
  const [ready, setReady] = useState(false)
  const web = useRef<WebView>(null)

  const chartColors: ChartColors = useMemo(
    () => ({
      bg: colors.bg,
      text: colors.textPrimary,
      textDim: colors.textSecondary,
      grid: colors.surface,
      border: colors.border,
      up: colors.long,
      down: colors.short,
      accent: colors.accent,
      accentSubtle: colors.accentSubtle,
      warning: colors.warning,
    }),
    [colors],
  )
  const html = useMemo(() => chartHtml(chartColors), [chartColors])

  const mark = useMark(symbol)
  const tail = useMarkTail(mark.data, candles.dataUpdatedAt, symbol)
  const merged = useMemo(() => foldMarks(candles.data ?? [], tail, tf), [candles.data, tail, tf])
  const series = useMemo(() => {
    const s = seriesFor(prefs.type, merged)
    return tf === '1s' ? ({ ...s, data: fillWhitespace(s.data, 1) } as typeof s) : s
  }, [prefs.type, merged, tf])
  const emaPoints = useMemo(() => {
    if (!prefs.ema) return null
    const pts = ema(seriesFor('candles', merged).data as { time: number; close: number }[], EMA_PERIOD)
    return tf === '1s' ? fillWhitespace(pts, 1) : pts
  }, [prefs.ema, merged, tf])
  const lines = useMemo(
    () =>
      prefs.positions && position
        ? { entry: Number(position.entry) / 1e6, liq: Number(position.liqPrice) / 1e6 }
        : ({} as const),
    [prefs.positions, position],
  )

  function send(msg: unknown) {
    web.current?.injectJavaScript(`window.__dexxer && window.__dexxer(${JSON.stringify(msg)}); true;`)
  }

  // Full redraw when the shape of what is drawn changes: new candles from
  // the indexer, a different type, timeframe, scale, EMA or lines. The
  // view refits only on a timeframe or type change, so a pinch-zoom
  // survives the 30 s candle refresh.
  const lastView = useRef('')
  const key = `${tf}|${prefs.type}`
  const candleStamp = candles.dataUpdatedAt
  useEffect(() => {
    if (!ready || series.data.length === 0) return
    send({
      type: 'render',
      chartType: prefs.type,
      series,
      ema: emaPoints,
      lines,
      scale: prefs.log ? 'log' : 'auto',
      resetView: lastView.current !== key,
    })
    lastView.current = key
    // `series` / `emaPoints` also change on every mark; those go through the tick effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, candleStamp, key, prefs.log, prefs.ema, lines])

  // Mark ticks: only the last bar (and EMA point) moves.
  useEffect(() => {
    if (!ready || series.data.length === 0) return
    send({
      type: 'tick',
      point: series.data[series.data.length - 1],
      emaPoint: emaPoints ? emaPoints[emaPoints.length - 1] : null,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail])

  function onMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type?: string; message?: string }
      if (msg.type === 'error') {
        if (__DEV__) console.warn('[dexxer] chart page error:', msg.message)
        return
      }
      if (msg.type === 'ready') {
        lastView.current = ''
        setReady(true)
      }
    } catch {
      // not ours
    }
  }

  const favorites = CHART_TYPES.filter((t) => prefs.favorites.includes(t.id))
  const current = CHART_TYPES.find((t) => t.id === prefs.type)
  function toggleFavorite(id: ChartType) {
    setPrefs({
      favorites: prefs.favorites.includes(id) ? prefs.favorites.filter((f) => f !== id) : [...prefs.favorites, id],
    })
  }

  return (
    <View style={{ gap: space.sm }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
        {TIMEFRAMES.map((t) => (
          <Pill key={t} label={t} active={t === tf} onPress={() => onTfChange(t)} />
        ))}
        <View style={{ width: space.sm }} />
        {/* First, so it never scrolls out of reach behind the starred types. */}
        <Pill label="⋯ Types" onPress={() => setPicker(true)} />
        {favorites.map((t) => (
          <Pill key={t.id} label={t.label} active={t.id === prefs.type} onPress={() => setPrefs({ type: t.id })} />
        ))}
        {!favorites.some((t) => t.id === prefs.type) && current ? (
          <Pill label={current.label} active onPress={() => setPicker(true)} />
        ) : null}
      </ScrollView>

      <View style={{ height: HEIGHT }}>
        <WebView
          ref={web}
          originWhitelist={['*']}
          source={{ html }}
          onMessage={onMessage}
          // The page is inline HTML: any http(s) navigation is a link out of
          // the chart — send it to the system browser, never load it here.
          onShouldStartLoadWithRequest={(req) => {
            if (!/^https?:/i.test(req.url)) return true
            void Linking.openURL(req.url).catch(() => undefined)
            return false
          }}
          setSupportMultipleWindows={false}
          javaScriptEnabled
          // chrome://inspect on a dev build; release builds keep it off.
          webviewDebuggingEnabled={__DEV__}
          scrollEnabled={false}
          nestedScrollEnabled
          overScrollMode="never"
          setBuiltInZoomControls={false}
          style={{ backgroundColor: colors.bg }}
        />
        {candles.isLoading ? (
          <View style={{ position: 'absolute', top: space.xl, left: 0, right: 0, alignItems: 'center' }}>
            <Text style={[caption, { color: colors.textTertiary }]}>Loading candles…</Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' }}>
        <Pill label={prefs.log ? 'L' : 'A'} active={prefs.log} onPress={() => setPrefs({ log: !prefs.log })} />
        <Pill label={`EMA ${EMA_PERIOD}`} active={prefs.ema} onPress={() => setPrefs({ ema: !prefs.ema })} />
        <Pill
          label="Positions on chart"
          active={prefs.positions}
          onPress={() => setPrefs({ positions: !prefs.positions })}
        />
        <View style={{ flex: 1 }} />
        {/* Pinch zooms too; these are for one hand. ↺ = back to the latest bars. */}
        <Pill label="−" onPress={() => send({ type: 'zoom', dir: -1 })} />
        <Pill label="+" onPress={() => send({ type: 'zoom', dir: 1 })} />
        <Pill label="↺" onPress={() => send({ type: 'zoom', dir: 0 })} />
      </View>

      <Sheet open={picker} onClose={() => setPicker(false)} title="Chart type">
        {CHART_TYPES.map((t) => {
          const starred = prefs.favorites.includes(t.id)
          return (
            <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setPrefs({ type: t.id })
                  setPicker(false)
                }}
                style={{ flex: 1, paddingVertical: space.sm }}
              >
                <Text style={[body, { color: t.id === prefs.type ? colors.accent : colors.textPrimary }]}>
                  {t.label}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={starred ? `Remove ${t.label} from quick access` : `Add ${t.label} to quick access`}
                hitSlop={space.sm}
                onPress={() => toggleFavorite(t.id)}
              >
                <Text style={[body, { color: starred ? colors.warning : colors.textTertiary }]}>
                  {starred ? '★' : '☆'}
                </Text>
              </Pressable>
            </View>
          )
        })}
      </Sheet>
    </View>
  )
}
