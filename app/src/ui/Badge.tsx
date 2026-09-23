// app/src/ui/Badge.tsx
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle, useToneColors, type Tone } from './styles'

export interface BadgeProps {
  tone: Tone
  children: ReactNode
}

export function Badge({ tone, children }: BadgeProps) {
  const { space, radius } = useTheme()
  const textStyle = useTextStyle('micro')
  const toneColors = useToneColors()
  const { fg, bg } = toneColors[tone]

  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: radius.pill,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
      }}
    >
      <Text style={[textStyle, { color: fg }]}>{children}</Text>
    </View>
  )
}
