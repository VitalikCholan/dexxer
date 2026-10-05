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
  /**
   * Fit-content pill row instead of a full-width, equal-column segment —
   * matches the Trade screen's 1m/5m/15m timeframe row in the mockup
   * ("01 · Trade"), which sits left-aligned under the chart rather than
   * spanning the ticket width.
   */
  compact?: boolean
}

export function Segment<T extends string | number>({ options, value, onChange, tone, compact }: SegmentProps<T>) {
  const { colors, space, radius, control } = useTheme()
  const textStyle = useTextStyle(compact ? 'body' : 'bodyStrong', { mono: compact })
  // Drawn option height: compact = text + paddingVertical; full = segmentHeight minus the 2 dp container padding.
  const optionHeight = compact ? (textStyle.lineHeight ?? 0) + 2 * space.sm : control.segmentHeight - 2 * 2
  const optionSlop = Math.max(0, (control.minHitTarget - optionHeight) / 2)

  return (
    <View
      style={{
        flexDirection: 'row',
        alignSelf: compact ? 'flex-start' : 'stretch',
        height: compact ? undefined : control.segmentHeight,
        borderRadius: compact ? radius.md : radius.sm,
        borderWidth: compact ? 1 : 0,
        borderColor: colors.border,
        backgroundColor: compact ? colors.bgElevated : colors.surfaceAlt,
        padding: compact ? 3 : 2,
        gap: compact ? space.xs : 2,
      }}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value
        const selectedBg =
          tone === 'long-short'
            ? i === 0
              ? colors.longSubtle
              : colors.shortSubtle
            : compact
              ? colors.border
              : colors.surface
        const selectedFg = tone === 'long-short' ? (i === 0 ? colors.long : colors.short) : colors.textPrimary
        return (
          <Pressable
            key={String(opt.value)}
            accessibilityRole="button"
            // Vertical touch area up to control.minHitTarget; options sit edge to edge, so no horizontal slop.
            hitSlop={{ top: optionSlop, bottom: optionSlop }}
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.value)}
            style={({ pressed }) => ({
              // Instant press feedback on an unselected option; the selected one already stands out.
              opacity: pressed && !selected ? 0.6 : 1,
              flex: compact ? undefined : 1,
              borderRadius: compact ? radius.md - 3 : radius.sm - 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? selectedBg : 'transparent',
              paddingHorizontal: compact ? space.lg : space.sm,
              paddingVertical: compact ? space.sm : undefined,
            })}
          >
            <Text style={[textStyle, { color: selected ? selectedFg : colors.textSecondary }]}>{opt.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
