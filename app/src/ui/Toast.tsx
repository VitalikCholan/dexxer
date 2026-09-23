// app/src/ui/Toast.tsx
//
// Module-level `showToast()` + a single `<ToastHost/>` (mounted once, in the
// root layout) — a minimal pub/sub so any screen can raise a toast without a
// context provider around it.
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
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

export function ToastHost() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const { space, radius } = useTheme()
  const textStyle = useTextStyle('bodyStrong')
  const toneColors = useToneColors()

  useEffect(() => {
    listener = setToast
    return () => {
      listener = null
    }
  }, [])

  if (!toast) return null
  const { fg, bg } = toneColors[toast.tone]

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: space.lg, right: space.lg, bottom: space.xxl, alignItems: 'center' }}
    >
      <View
        style={{ backgroundColor: bg, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md }}
      >
        <Text style={[textStyle, { color: fg }]}>{toast.text}</Text>
      </View>
    </View>
  )
}
