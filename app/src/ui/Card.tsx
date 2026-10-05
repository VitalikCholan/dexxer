// app/src/ui/Card.tsx
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'

export interface CardProps {
  title?: string
  children: ReactNode
}

export function Card({ title, children }: CardProps) {
  const { colors, space, radius, border } = useTheme()
  const titleStyle = useTextStyle('heading')

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        // Concentric with the controls inside: radius.md (10) + padding space.lg (16).
        borderRadius: radius.xl,
        borderWidth: border.hairline,
        borderColor: colors.border,
        padding: space.lg,
        gap: space.md,
      }}
    >
      {title ? <Text style={[titleStyle, { color: colors.textPrimary }]}>{title}</Text> : null}
      {children}
    </View>
  )
}
