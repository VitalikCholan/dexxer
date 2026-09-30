// app/src/ui/SolIcon.tsx
//
// The Solana mark for the SOL-PERP header — the three slanted bars, drawn
// with `react-native-svg` so no image asset is needed. The gradient runs
// accent → long from the design tokens (CLAUDE.md: no hex in components),
// close to the brand's own purple → green.
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg'
import { View } from 'react-native'
import { useTheme } from '@/src/theme'

export function SolIcon({ size = 28 }: { size?: number }) {
  const { colors } = useTheme()
  const glyph = size * 0.55
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={glyph} height={glyph * 0.78} viewBox="0 0 398 312">
        <Defs>
          <LinearGradient id="sol" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor={colors.accent} />
            <Stop offset="1" stopColor={colors.long} />
          </LinearGradient>
        </Defs>
        <Path
          fill="url(#sol)"
          d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"
        />
        <Path
          fill="url(#sol)"
          d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"
        />
        <Path
          fill="url(#sol)"
          d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"
        />
      </Svg>
    </View>
  )
}
