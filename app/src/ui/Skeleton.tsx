// app/src/ui/Skeleton.tsx
import { useEffect, useState } from 'react'
import { Animated, View } from 'react-native'
import { useTheme } from '@/src/theme'

export interface SkeletonProps {
  lines: number
}

export function Skeleton({ lines }: SkeletonProps) {
  const { colors, space, radius } = useTheme()
  // `useState(() => ...)` rather than `useRef(...).current` — see LeverageSlider's
  // header comment: the project's react-hooks lint (React Compiler on) treats
  // a `.current` read in the render body as an error.
  const [pulse] = useState(() => new Animated.Value(0.4))

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse])

  return (
    <View style={{ gap: space.sm }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Animated.View
          key={i}
          style={{
            height: 14,
            borderRadius: radius.sm,
            backgroundColor: colors.surfaceAlt,
            opacity: pulse,
            width: i === lines - 1 ? '60%' : '100%',
          }}
        />
      ))}
    </View>
  )
}
