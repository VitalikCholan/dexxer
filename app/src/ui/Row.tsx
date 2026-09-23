// app/src/ui/Row.tsx
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle, useToneColors, type Tone } from './styles'

export interface RowProps {
  label: string
  value: string
  tone?: Tone
  mono?: boolean
}

export function Row({ label, value, tone, mono }: RowProps) {
  const { colors } = useTheme()
  const labelStyle = useTextStyle('body')
  const valueStyle = useTextStyle('bodyStrong', { mono })
  const toneColors = useToneColors()
  const valueColor = tone ? toneColors[tone].fg : colors.textPrimary

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={[labelStyle, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[valueStyle, { color: valueColor }]}>{value}</Text>
    </View>
  )
}
