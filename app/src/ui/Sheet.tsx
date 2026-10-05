// app/src/ui/Sheet.tsx
//
// Bottom sheet on RN's `Modal` + `Animated` (no new deps, per task-8 brief).
// The backdrop is `colors.bg` (near-black) at partial opacity, rather than an
// invented scrim hex — there is no dedicated overlay token in
// docs/design/tokens.json. `elevation.sheet` ("0 -1px 0 #232733", a CSS box-
// shadow string) has no RN equivalent, so it's approximated with a top
// hairline border in `colors.border`, which is the same 1px line.
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}

// Ease-out both ways (better-ui): fast start, soft landing.
const EASE_OUT = Easing.bezier(0.2, 0, 0, 1)
const BACKDROP_OPACITY = 0.7

export function Sheet({ open, onClose, title, children }: SheetProps) {
  const { colors, space, radius, border } = useTheme()
  const titleStyle = useTextStyle('heading')
  // `useState(() => ...)` rather than `useRef(...).current` — see
  // LeverageSlider's header comment (React Compiler's react-hooks lint
  // treats a `.current` read in the render body as an error).
  // Closed = a full window height down, so a sheet taller than any fixed offset never shows on the first frame.
  const closedOffset = useWindowDimensions().height
  const [translateY] = useState(() => new Animated.Value(closedOffset))
  const [mounted, setMounted] = useState(open)
  // Mount synchronously on the `open` transition, during render (the React-
  // docs "adjusting state when a prop changes" pattern) rather than as a
  // `setState` call in `useEffect` — the lint also flags that as a
  // cascading-render risk. Unmounting (the reverse transition) still happens
  // from the animation's completion callback below, which is fine: it is not
  // a synchronous effect-body `setState`.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setMounted(true)
  }

  useEffect(() => {
    if (open) {
      Animated.timing(translateY, { toValue: 0, duration: 220, easing: EASE_OUT, useNativeDriver: true }).start()
    } else if (mounted) {
      Animated.timing(translateY, {
        toValue: closedOffset,
        duration: 180,
        easing: EASE_OUT,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false)
      })
    }
  }, [open, mounted, translateY, closedOffset])

  if (!mounted) return null

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        {/* The backdrop fades with the sheet's position instead of popping in. */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: colors.bg,
              opacity: translateY.interpolate({
                inputRange: [0, closedOffset],
                outputRange: [BACKDROP_OPACITY, 0],
                extrapolate: 'clamp',
              }),
            },
          ]}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderTopWidth: border.hairline,
            borderColor: colors.border,
            padding: space.lg,
            gap: space.md,
            transform: [{ translateY }],
          }}
        >
          <Text style={[titleStyle, { color: colors.textPrimary }]}>{title}</Text>
          {children}
        </Animated.View>
      </View>
    </Modal>
  )
}
