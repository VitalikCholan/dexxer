// app/src/ui/Input.tsx
import { Pressable, Text, TextInput, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { linkPressStyle, useTextLinkHitSlop, useTextStyle } from './styles'

export interface InputProps {
  label: string
  value: string
  onChangeText: (value: string) => void
  suffix?: string
  hint?: string
  onMax?: () => void
  placeholder?: string
  keyboardType?: 'default' | 'numeric' | 'decimal-pad'
}

export function Input({ label, value, onChangeText, suffix, hint, onMax, placeholder, keyboardType }: InputProps) {
  const { colors, space, radius, control } = useTheme()
  const labelStyle = useTextStyle('micro')
  const valueStyle = useTextStyle('bodyStrong', { mono: true })
  // Caption-sized suffix so a six-character amount (e.g. `116.54`) still fits
  // next to `dUSDC` + `MAX` in a half-width ticket field — with `body` the
  // TextInput overflowed and Android scrolled the leading digits out of view.
  const suffixStyle = useTextStyle('caption')
  const hintStyle = useTextStyle('caption')
  const maxHitSlop = useTextLinkHitSlop(labelStyle)

  return (
    <View style={{ gap: space.xs }}>
      <Text style={[labelStyle, { color: colors.textSecondary }]}>{label}</Text>
      <View
        style={{
          minHeight: control.inputHeight,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: space.sm,
          gap: space.xs,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          keyboardType={keyboardType ?? 'decimal-pad'}
          numberOfLines={1}
          style={[valueStyle, { flex: 1, minWidth: 0, color: colors.textPrimary, minHeight: control.minHitTarget }]}
        />
        {suffix ? <Text style={[suffixStyle, { color: colors.textSecondary }]}>{suffix}</Text> : null}
        {onMax ? (
          <Pressable onPress={onMax} hitSlop={maxHitSlop} style={linkPressStyle}>
            <Text style={[labelStyle, { color: colors.accentText }]}>MAX</Text>
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={[hintStyle, { color: colors.textTertiary }]}>{hint}</Text> : null}
    </View>
  )
}
