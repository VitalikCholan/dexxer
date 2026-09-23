// app/src/ui/Input.tsx
import { Pressable, Text, TextInput, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'

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
  const suffixStyle = useTextStyle('body')
  const hintStyle = useTextStyle('caption')

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
          paddingHorizontal: space.md,
          gap: space.sm,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          keyboardType={keyboardType ?? 'decimal-pad'}
          style={[valueStyle, { flex: 1, color: colors.textPrimary, minHeight: control.minHitTarget }]}
        />
        {suffix ? <Text style={[suffixStyle, { color: colors.textSecondary }]}>{suffix}</Text> : null}
        {onMax ? (
          <Pressable onPress={onMax} hitSlop={space.sm}>
            <Text style={[labelStyle, { color: colors.accent }]}>MAX</Text>
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={[hintStyle, { color: colors.textTertiary }]}>{hint}</Text> : null}
    </View>
  )
}
