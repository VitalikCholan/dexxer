// app/src/features/trade/PriceChart.tsx
//
// Task 10: mark-price LINE chart (design: "line, height ~200, no candles/
// order book/volume"). A plain polyline over `useCandles(tf)` closes —
// `react-native-svg` only (already a dep), no new charting library.
import { useState } from 'react'
import { View } from 'react-native'
import Svg, { Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg'
import { useTheme } from '@/src/theme'
import { useCandles, type Candle } from '@/src/lib/indexer'
import { Skeleton } from '@/src/ui/Skeleton'

const HEIGHT = 200

function linePoints(candles: Candle[], width: number, height: number): string {
  const closes = candles.map((c) => c.c)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const step = candles.length > 1 ? width / (candles.length - 1) : 0
  return closes.map((c, i) => `${(i * step).toFixed(1)},${(height - ((c - min) / span) * height).toFixed(1)}`).join(' ')
}

export function PriceChart({ tf }: { tf: '1m' | '5m' | '15m' }) {
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
        <Svg width={width} height={HEIGHT}>
          <Defs>
            <LinearGradient id="markFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.accent} stopOpacity={0.25} />
              <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Polygon points={`0,${HEIGHT} ${linePoints(data, width, HEIGHT)} ${width.toFixed(1)},${HEIGHT}`} fill="url(#markFill)" />
          <Polyline points={linePoints(data, width, HEIGHT)} fill="none" stroke={colors.accent} strokeWidth={2} />
        </Svg>
      )}
    </View>
  )
}
