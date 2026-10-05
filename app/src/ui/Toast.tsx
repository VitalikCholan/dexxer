// app/src/ui/Toast.tsx
//
// Module-level `showToast()` + a single `<ToastHost/>` (mounted once, in the
// root layout) — a minimal pub/sub so any screen can raise a toast without a
// context provider around it.
import { useEffect, useState } from 'react'
import { Animated, Easing, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/src/theme'
import { useTextStyle, useToneColors, type Tone } from './styles'

interface ToastState {
  id: number
  tone: Tone
  text: string
}

let listener: ((toast: ToastState | null) => void) | null = null
let counter = 0
let hideTimer: ReturnType<typeof setTimeout> | null = null

export function showToast({ tone, text }: { tone: Tone; text: string }) {
  const toast: ToastState = { id: ++counter, tone, text }
  listener?.(toast)
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => listener?.(null), 2800)
}

// Enter and exit: a short fade plus an 8 px rise, ease-out both ways (better-ui).
// It comes up from below but settles above the tab bar (and the system
// navigation inset): sitting at the screen edge, it was half-covered by the
// tab bar (05.10.2026).
const TOAST_MS = 180
const TOAST_RISE = 8
const EASE_OUT = Easing.bezier(0.2, 0, 0, 1)

export function ToastHost() {
  // `shown` outlives `toast` by the exit animation, so the toast fades out instead of vanishing.
  const [toast, setToast] = useState<ToastState | null>(null)
  const [shown, setShown] = useState<ToastState | null>(null)
  const [progress] = useState(() => new Animated.Value(0))
  if (toast && toast !== shown) setShown(toast)
  const { colors, space, radius, layout } = useTheme()
  const insets = useSafeAreaInsets()
  const textStyle = useTextStyle('bodyStrong')
  const toneColors = useToneColors()

  useEffect(() => {
    listener = setToast
    return () => {
      listener = null
    }
  }, [])

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: toast ? 1 : 0,
      duration: TOAST_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    })
    anim.start(({ finished }) => {
      if (finished && !toast) setShown(null)
    })
    return () => anim.stop()
  }, [toast, progress])

  if (!shown) return null
  const { fg, bg } = toneColors[shown.tone]

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: space.lg,
        right: space.lg,
        bottom: insets.bottom + layout.tabBar + space.md,
        alignItems: 'center',
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [TOAST_RISE, 0] }) }],
      }}
    >
      {/* The tone tints are 14 % alpha: an opaque base keeps the screen from showing through. */}
      <View style={{ backgroundColor: colors.bgElevated, borderRadius: radius.md, overflow: 'hidden' }}>
        <View style={{ backgroundColor: bg, paddingHorizontal: space.lg, paddingVertical: space.md }}>
          <Text style={[textStyle, { color: fg }]}>{shown.text}</Text>
        </View>
      </View>
    </Animated.View>
  )
}
