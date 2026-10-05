// app/src/features/chart/TradingChart.tsx
//
// C.5: the TradingView-style chart — lightweight-charts in a WebView
// (`chartHtml.ts`), fed from the indexer's candles with the mark stream folded
// into the newest buckets (`chartData.ts`). Pan and pinch-zoom, crosshair with an
// OHLC row, High/Low of the visible range and the mark's last-price line are
// the library's (driven from the page), plus −/+/↺ zoom buttons for one-hand
// use; the toolbar here picks the
// timeframe (one row that fits the screen: up to five pinned timeframes and
// More, which opens all 16 — `tfToolbar.ts`), the chart type (one button,
// the full list in a sheet), auto/log scale, EMA(20) and entry / liq lines of
// the open position. Live marks fold in via `useMarkTail`.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
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
  liveUpdateKind,
  secondsVisibleFor,
  seriesFor,
  type Tf,
} from './chartData'
import { chartHtml, type ChartColors } from './chartHtml'
import { useChartPrefs } from './useChartPrefs'
import { MAX_PINNED_TFS, chartTypeGlyph, tfRow, togglePinnedTf, type ChartTypeGlyph } from './tfToolbar'
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

function Pill({
  label,
  active,
  onPress,
  accessibilityLabel,
  icon,
}: {
  label: string
  active?: boolean
  onPress: () => void
  accessibilityLabel?: string
  icon?: React.ReactNode
}) {
  const { colors, space, radius, border, control } = useTheme()
  const style = useTextStyle('caption', { mono: true })
  // The pill is drawn 28 dp tall; the touch area reaches control.minHitTarget vertically only,
  // so neighbouring pills (gap space.xs) never steal each other's taps.
  const drawn = (style.lineHeight ?? 0) + 2 * space.xs + 2 * border.hairline
  const slop = Math.max(0, (control.minHitTarget - drawn) / 2)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      hitSlop={{ top: slop, bottom: slop }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderRadius: radius.sm,
        borderWidth: border.hairline,
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accentSubtle : pressed ? colors.surfaceAlt : colors.bgElevated,
      })}
    >
      {icon}
      <Text style={[style, { color: active ? colors.textPrimary : colors.textSecondary }]}>{label}</Text>
    </Pressable>
  )
}

/** The chart-type button's icon, drawn in the button's text colour; decorative (the button has a label). */
function TypeGlyph({ glyph, color, size }: { glyph: ChartTypeGlyph; color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" accessibilityElementsHidden importantForAccessibility="no">
      {glyph === 'candles' ? (
        <>
          <Path d="M4 2v12M11 1v13" stroke={color} strokeWidth={1.5} />
          <Rect x={2.5} y={5} width={3} height={6} fill={color} />
          <Rect x={9.5} y={3.5} width={3} height={7} fill={color} />
        </>
      ) : glyph === 'line' ? (
        <Path d="M1 12l4-5 3 3 6-7" stroke={color} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
      ) : (
        <>
          <Path d="M1 12l4-5 3 3 6-7v12H1z" fill={color} opacity={0.35} />
          <Path d="M1 12l4-5 3 3 6-7" stroke={color} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
        </>
      )}
    </Svg>
  )
}

export function TradingChart({ symbol, tf, onTfChange, position }: TradingChartProps) {
  const { colors, space, control } = useTheme()
  const caption = useTextStyle('caption')
  const body = useTextStyle('body')
  const mono = useTextStyle('body', { mono: true })
  const candles = useCandles(symbol, tf)
  const [prefs, setPrefs] = useChartPrefs()
  const [picker, setPicker] = useState(false)
  const [tfPicker, setTfPicker] = useState(false)
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

  // What the page currently draws: `symbol|tf` of the last `render` with
  // data, null before the first one, after a page reload and after an empty
  // render. A tick is sent only onto the series it belongs to.
  const renderedFor = useRef<string | null>(null)
  // `symbol|tf` the page was last cleared for, so an empty series is sent once, not on every refetch.
  const clearedFor = useRef<string | null>(null)
  const drawKey = `${symbol}|${tf}`

  function sendRender(resetView: boolean) {
    send({
      type: 'render',
      chartType: prefs.type,
      series,
      ema: emaPoints,
      lines,
      scale: prefs.log ? 'log' : 'auto',
      resetView,
      secondsVisible: secondsVisibleFor(tf),
    })
  }

  // Full redraw when the shape of what is drawn changes: new candles from
  // the indexer, a different market, type, timeframe, scale, EMA or lines.
  // The view refits only on a market, timeframe or type change, so a
  // pinch-zoom survives the 30 s candle refresh.
  const lastView = useRef('')
  const key = `${symbol}|${tf}|${prefs.type}`
  const candleStamp = candles.dataUpdatedAt
  useEffect(() => {
    if (!ready) return
    if (series.data.length === 0) {
      // Nothing for this market/tf yet (loading, or the indexer has no
      // candles and no mark arrived): never leave another market's or
      // timeframe's chart on screen under it. A chart this market/tf already
      // drew (a fresh `1s` built from marks alone) stays until data comes.
      if (renderedFor.current !== drawKey && clearedFor.current !== drawKey) {
        sendRender(true)
        clearedFor.current = drawKey
        renderedFor.current = null
        lastView.current = ''
      }
      return
    }
    sendRender(lastView.current !== key)
    lastView.current = key
    renderedFor.current = drawKey
    clearedFor.current = null
    // `series` / `emaPoints` also change on every mark; those go through the tick effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, candleStamp, key, prefs.log, prefs.ema, lines])

  // Mark ticks: only the last bar (and EMA point) moves — when the page
  // holds this market/tf. A mark that beats the first candle render of a new
  // market/tf draws the whole series instead (`liveUpdateKind`).
  useEffect(() => {
    if (!ready) return
    const kind = liveUpdateKind(renderedFor.current, drawKey, series.data.length > 0)
    if (kind === 'tick') {
      send({
        type: 'tick',
        point: series.data[series.data.length - 1],
        emaPoint: emaPoints ? emaPoints[emaPoints.length - 1] : null,
      })
    } else if (kind === 'render') {
      sendRender(true)
      renderedFor.current = drawKey
      clearedFor.current = null
    }
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
        renderedFor.current = null
        clearedFor.current = null
        setReady(true)
      }
    } catch {
      // not ours
    }
  }

  const current = CHART_TYPES.find((t) => t.id === prefs.type)
  const row = tfRow(prefs.pinnedTfs, tf)
  const pinsFull = prefs.pinnedTfs.length >= MAX_PINNED_TFS

  return (
    <View style={{ gap: space.sm }}>
      {/* One row that fits the screen: pinned timeframes, More (all 16), the chart type. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
        {row.pills.map((t) => (
          <Pill key={t} label={t} active={t === tf} onPress={() => onTfChange(t)} />
        ))}
        <Pill
          label={`${row.more.label} ▾`}
          active={row.more.active}
          accessibilityLabel={row.more.active ? `Timeframe ${tf}, more timeframes` : 'More timeframes'}
          onPress={() => setTfPicker(true)}
        />
        <View style={{ flex: 1 }} />
        <Pill
          label="▾"
          accessibilityLabel={`Chart type: ${current?.label ?? ''}`}
          icon={<TypeGlyph glyph={chartTypeGlyph(prefs.type)} color={colors.textSecondary} size={14} />}
          onPress={() => setPicker(true)}
        />
      </View>

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

      <Sheet open={tfPicker} onClose={() => setTfPicker(false)} title="Timeframe">
        <Text style={[caption, { color: colors.textSecondary }]}>
          {`Tap ★ to pin up to ${MAX_PINNED_TFS} to the toolbar · ${prefs.pinnedTfs.length} / ${MAX_PINNED_TFS} pinned`}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: space.xs }}>
          {TIMEFRAMES.map((t) => {
            const pinned = prefs.pinnedTfs.includes(t)
            const canPin = pinned || !pinsFull
            return (
              // Two sibling buttons (choose, pin): a nested button inside an accessible one is invisible to TalkBack.
              <View key={t} style={{ width: '25%', flexDirection: 'row', alignItems: 'center' }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Timeframe ${t}`}
                  accessibilityState={{ selected: t === tf }}
                  onPress={() => {
                    onTfChange(t)
                    setTfPicker(false)
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: control.minHitTarget,
                    justifyContent: 'center',
                    paddingLeft: space.sm,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={[mono, { color: t === tf ? colors.accentText : colors.textPrimary }]}>{t}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={pinned ? `Unpin ${t} from the toolbar` : `Pin ${t} to the toolbar`}
                  accessibilityState={{ disabled: !canPin }}
                  disabled={!canPin}
                  hitSlop={space.xs}
                  onPress={() => setPrefs({ pinnedTfs: togglePinnedTf(prefs.pinnedTfs, t) })}
                  style={({ pressed }) => ({
                    minHeight: control.minHitTarget,
                    justifyContent: 'center',
                    paddingHorizontal: space.sm,
                    opacity: !canPin ? 0.35 : pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={[body, { color: pinned ? colors.warning : colors.textTertiary }]}>
                    {pinned ? '★' : '☆'}
                  </Text>
                </Pressable>
              </View>
            )
          })}
        </View>
      </Sheet>

      <Sheet open={picker} onClose={() => setPicker(false)} title="Chart type">
        {CHART_TYPES.map((t) => {
          const selected = t.id === prefs.type
          const color = selected ? colors.accentText : colors.textPrimary
          return (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                setPrefs({ type: t.id })
                setPicker(false)
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                minHeight: control.minHitTarget,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <TypeGlyph glyph={chartTypeGlyph(t.id)} color={color} size={16} />
              <Text style={[body, { color }]}>{t.label}</Text>
            </Pressable>
          )
        })}
      </Sheet>
    </View>
  )
}
