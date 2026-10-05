// app/src/ui/Button.tsx
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost' | 'long'

export interface ButtonProps {
  variant: ButtonVariant
  loading?: boolean
  disabled?: boolean
  onPress: () => void
  children: ReactNode
}

export function Button({ variant, loading, disabled, onPress, children }: ButtonProps) {
  const { colors, space, radius, control } = useTheme()
  const textStyle = useTextStyle('bodyStrong')
  const isDisabled = disabled || loading

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: !!loading }}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => {
        const { bg, borderColor } = variantColors(variant, colors, isDisabled, pressed)
        return {
          minHeight: control.buttonHeight,
          borderRadius: radius.md,
          backgroundColor: bg,
          borderWidth: borderColor ? 1 : 0,
          borderColor: borderColor ?? 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space.sm,
          paddingHorizontal: space.lg,
        }
      }}
    >
      {({ pressed }) => {
        const { fg } = variantColors(variant, colors, isDisabled, pressed)
        return loading ? (
          <ActivityIndicator color={fg} size="small" />
        ) : (
          <View>
            <Text style={[textStyle, { color: fg }]}>{children}</Text>
          </View>
        )
      }}
    </Pressable>
  )
}

function variantColors(
  variant: ButtonVariant,
  colors: ReturnType<typeof useTheme>['colors'],
  isDisabled?: boolean,
  pressed?: boolean,
): { bg: string; fg: string; borderColor?: string } {
  if (isDisabled) {
    return { bg: colors.disabledBg, fg: colors.disabledText }
  }
  switch (variant) {
    case 'primary':
      return { bg: pressed ? colors.accentPressed : colors.accent, fg: colors.textPrimary }
    case 'secondary':
      return { bg: pressed ? colors.surface : colors.surfaceAlt, fg: colors.textPrimary, borderColor: colors.border }
    case 'destructive':
      return { bg: colors.short, fg: colors.textPrimary }
    // Opens a Long: the side's own color, like the Long/Short toggle (Short opens with `destructive`).
    case 'long':
      return { bg: colors.long, fg: colors.textInverse }
    case 'ghost':
      return { bg: pressed ? colors.accentSubtle : 'transparent', fg: colors.accent }
  }
}
