// app/src/features/trade/ChartAxes.tsx
//
// Grid lines + price/time tick labels for PriceChart's candlestick chart —
// split out of PriceChart.tsx to keep it under the ~180-line guideline.
// Pure presentation: renders react-native-svg primitives into the caller's
// own <Svg> (no nested <Svg> of its own), so it only needs plot geometry, a
// price→y mapper and the candle list for time labels.
import { G, Line, Text as SvgText } from 'react-native-svg'
import { useTheme } from '@/src/theme'
import type { Candle } from '@/src/lib/indexer'

const TICK_COUNT = 4
const FONT = 'IBM Plex Mono, monospace'

function fmtPrice(n: number, decimals: number): string {
  return n.toFixed(decimals)
}

/** `t` is unix ms (services/relayer/src/indexer/candles.ts's `Candle.t`). */
function fmtTime(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface ChartAxesProps {
  plotWidth: number
  plotHeight: number
  timeH: number
  min: number
  max: number
  decimals: number
  candles: Candle[]
  priceToY: (price: number) => number
}

/** Right-side price ticks + grid lines, and up to 3 bottom time labels. */
export function ChartAxes({ plotWidth, plotHeight, timeH, min, max, decimals, candles, priceToY }: ChartAxesProps) {
  const { colors } = useTheme()
  const step = (max - min) / (TICK_COUNT - 1 || 1)
  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => min + step * i)

  const timeLabels =
    candles.length >= 2 ? [candles[0], candles[Math.floor((candles.length - 1) / 2)], candles[candles.length - 1]] : []

  return (
    <G>
      {ticks.map((price) => {
        const y = priceToY(price)
        return (
          <G key={price}>
            <Line x1={0} y1={y} x2={plotWidth} y2={y} stroke={colors.border} strokeWidth={1} />
            <SvgText x={plotWidth + 6} y={y + 3} fontSize={10} fontFamily={FONT} fill={colors.textTertiary}>
              {fmtPrice(price, decimals)}
            </SvgText>
          </G>
        )
      })}
      {timeLabels.map((c, i) => (
        <SvgText
          key={c.t}
          x={i === 0 ? 0 : i === timeLabels.length - 1 ? Math.max(0, plotWidth - 34) : plotWidth / 2 - 16}
          y={plotHeight + timeH - 4}
          fontSize={10}
          fontFamily={FONT}
          fill={colors.textTertiary}
        >
          {fmtTime(c.t)}
        </SvgText>
      ))}
    </G>
  )
}
