// app/src/ui/Segment.tsx
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'

export interface SegmentOption<T> {
  value: T
  label: string
}

export interface SegmentProps<T> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  /** 'long-short' colors the selected segment green/red by its index (0 = long, 1 = short) instead of the neutral accent highlight. */
  tone?: 'long-short'
}

export function Segment<T extends string | number>({ options, value, onChange, tone }: SegmentProps<T>) {
  const { colors, space, radius, control } = useTheme()
  const textStyle = useTextStyle('bodyStrong')

  return (
    <View
      style={{
        flexDirection: 'row',
        height: control.segmentHeight,
        borderRadius: radius.sm,
        backgroundColor: colors.surfaceAlt,
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value
        const selectedBg = tone === 'long-short' ? (i === 0 ? colors.longSubtle : colors.shortSubtle) : colors.surface
        const selectedFg = tone === 'long-short' ? (i === 0 ? colors.long : colors.short) : colors.textPrimary
        return (
          <Pressable
            key={String(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.value)}
            style={{
              flex: 1,
              borderRadius: radius.sm - 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? selectedBg : 'transparent',
              paddingHorizontal: space.sm,
            }}
          >
            <Text style={[textStyle, { color: selected ? selectedFg : colors.textSecondary }]}>{opt.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
