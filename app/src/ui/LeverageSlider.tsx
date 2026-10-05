// app/src/ui/LeverageSlider.tsx
//
// Integer 1..10 (default) leverage picker on a horizontal track. Built on
// RN's built-in `PanResponder` — no new slider dependency, per task-8 brief.
// No `useRef` here: with `experiments.reactCompiler` on, the project's
// react-hooks lint treats `useRef(x).current` reads (and refs closed over by
// a function built during render) as errors, so track width lives in state
// instead and the `PanResponder` is rebuilt — cheaply — whenever it changes.
import { useMemo, useState } from 'react'
import { type GestureResponderEvent, PanResponder, type PanResponderGestureState, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'
import { sliderIntent } from './sliderGesture'

export interface LeverageSliderProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
}

const THUMB_SIZE = 24

export function LeverageSlider({ value, onChange, min = 1, max = 10 }: LeverageSliderProps) {
  const { colors, space, radius } = useTheme()
  const labelStyle = useTextStyle('heading', { mono: true })
  const captionStyle = useTextStyle('micro')
  const [trackWidth, setTrackWidth] = useState(0)

  function valueFromX(x: number): number {
    if (trackWidth <= 0) return value
    const ratio = Math.min(1, Math.max(0, x / trackWidth))
    const raw = min + ratio * (max - min)
    return Math.min(max, Math.max(min, Math.round(raw)))
  }

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Claim the touch so a tap can set the value, but change nothing until the gesture says
        // what it is (`sliderIntent`): a vertical move is the page scroll — hand it back.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => sliderIntent(g.dx, g.dy) === 'drag',
        onPanResponderTerminationRequest: (_e, g) => sliderIntent(g.dx, g.dy) !== 'drag',
        // Let the native (vertical) ScrollView intercept, otherwise a swipe that starts here can't scroll the page.
        onShouldBlockNativeResponder: () => false,
        onPanResponderMove: (e: GestureResponderEvent, g: PanResponderGestureState) => {
          if (sliderIntent(g.dx, g.dy) === 'drag') onChange(valueFromX(e.nativeEvent.locationX))
        },
        onPanResponderRelease: (e: GestureResponderEvent, g: PanResponderGestureState) => {
          if (sliderIntent(g.dx, g.dy) !== 'scroll') onChange(valueFromX(e.nativeEvent.locationX))
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilding per onChange/value identity would thrash mid-gesture for no benefit; trackWidth/min/max are what actually change valueFromX's math.
    [min, max, trackWidth],
  )

  const ratio = trackWidth > 0 ? (value - min) / (max - min || 1) : 0
  const thumbLeft = Math.min(trackWidth - THUMB_SIZE, Math.max(0, ratio * trackWidth - THUMB_SIZE / 2))

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={[captionStyle, { color: colors.textSecondary }]}>Leverage</Text>
        <Text style={[labelStyle, { color: colors.textPrimary }]}>{value}×</Text>
      </View>
      <View
        {...panResponder.panHandlers}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        style={{ height: 32, justifyContent: 'center' }}
      >
        <View style={{ height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}>
          <View style={{ height: 4, width: `${ratio * 100}%`, backgroundColor: colors.accent }} />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: thumbLeft,
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            borderRadius: THUMB_SIZE / 2,
            backgroundColor: colors.textPrimary,
            borderWidth: 2,
            borderColor: colors.accent,
          }}
        />
      </View>
    </View>
  )
}
