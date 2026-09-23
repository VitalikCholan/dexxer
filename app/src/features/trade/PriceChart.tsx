// app/src/features/trade/PriceChart.tsx
//
// Post-fix B: candlestick chart per the mockup ("01 · Trade") — OHLC bars
// from `useCandles(tf)`, a right price axis + bottom time axis (ChartAxes),
// and a dashed line + price tag at the current mark. `react-native-svg`
// only (already a dep), no new charting library.
import { useState } from 'react'
import { View } from 'react-native'
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg'
import { useTheme } from '@/src/theme'
import { useCandles, type Candle } from '@/src/lib/indexer'
import { Skeleton } from '@/src/ui/Skeleton'
import { ChartAxes } from './ChartAxes'

const HEIGHT = 200
const AXIS_W = 44
const TIME_H = 20
const PLOT_H = HEIGHT - TIME_H
const FONT = 'IBM Plex Mono, monospace'
// Candle o/h/l/c arrive 1e6-scaled, the same raw unit as `mark`
// (services/relayer/src/indexer/prices.ts's `price1e6`) — never rendered
// without this division.
const SCALE = 1e6

function dollars(raw: number): number {
  return raw / SCALE
}

type Colors = ReturnType<typeof useTheme>['colors']

export function PriceChart({ tf, markUsd }: { tf: '1m' | '5m' | '15m'; markUsd: number | null }) {
  const { colors } = useTheme()
  const candles = useCandles(tf)
  const [width, setWidth] = useState(0)
  const data = candles.data

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: HEIGHT }}>
      {candles.isLoading || width === 0 ? (
        <Skeleton lines={1} />
      ) : !data || data.length < 2 ? (
        <View style={{ flex: 1 }} />
      ) : (
        <Chart data={data} markUsd={markUsd} width={width} colors={colors} />
      )}
    </View>
  )
}

function Chart({
  data,
  markUsd,
  width,
  colors,
}: {
  data: Candle[]
  markUsd: number | null
  width: number
  colors: Colors
}) {
  const plotWidth = Math.max(0, width - AXIS_W)

  const lows = data.map((c) => dollars(c.l))
  const highs = data.map((c) => dollars(c.h))
  const rawMin = Math.min(...lows)
  const rawMax = Math.max(...highs)
  const rawSpan = rawMax - rawMin || 1
  const pad = rawSpan * 0.08
  const min = rawMin - pad
  const max = rawMax + pad
  const span = max - min || 1
  const decimals = rawSpan >= 8 ? 0 : 2

  const priceToY = (price: number) => PLOT_H - ((price - min) / span) * PLOT_H

  const step = plotWidth / data.length
  const bodyW = Math.max(2, Math.min(8, step * 0.6))
  const wickW = Math.max(1, bodyW / 5)

  const markTone =
    markUsd !== null && data.length > 0 ? (markUsd >= dollars(data[0].o) ? colors.long : colors.short) : colors.accent
  const markY = markUsd !== null ? Math.min(PLOT_H, Math.max(0, priceToY(markUsd))) : null

  return (
    <Svg width={width} height={HEIGHT}>
      <ChartAxes
        plotWidth={plotWidth}
        plotHeight={PLOT_H}
        timeH={TIME_H}
        min={min}
        max={max}
        decimals={decimals}
        candles={data}
        priceToY={priceToY}
      />
      <G>
        {data.map((c, i) => {
          const cx = step * i + step / 2
          const o = dollars(c.o)
          const close = dollars(c.c)
          const up = close >= o
          const color = up ? colors.long : colors.short
          const bodyTop = priceToY(Math.max(o, close))
          const bodyBottom = priceToY(Math.min(o, close))
          return (
            <G key={c.t}>
              <Rect
                x={cx - wickW / 2}
                y={priceToY(dollars(c.h))}
                width={wickW}
                height={Math.max(1, priceToY(dollars(c.l)) - priceToY(dollars(c.h)))}
                fill={color}
              />
              <Rect
                x={cx - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={Math.max(1, bodyBottom - bodyTop)}
                fill={color}
              />
            </G>
          )
        })}
      </G>
      {markY !== null && markUsd !== null ? (
        <G>
          <Line x1={0} y1={markY} x2={plotWidth} y2={markY} stroke={markTone} strokeWidth={1} strokeDasharray="2 3" />
          <Rect x={plotWidth + 2} y={markY - 8} width={AXIS_W - 4} height={16} rx={3} fill={markTone} />
          <SvgText
            x={plotWidth + 2 + (AXIS_W - 4) / 2}
            y={markY + 3}
            textAnchor="middle"
            fontSize={10}
            fontWeight="600"
            fontFamily={FONT}
            fill={colors.textInverse}
          >
            {markUsd.toFixed(decimals)}
          </SvgText>
        </G>
      ) : null}
    </Svg>
  )
}
