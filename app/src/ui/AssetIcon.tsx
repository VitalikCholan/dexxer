// app/src/ui/AssetIcon.tsx
//
// A market's icon: the asset's brand mark (official kits only, see
// assetIcons.ts) or a letter avatar, on a `surfaceAlt` circle. Decorative —
// the symbol is always written next to it — so hidden from screen readers.
// The SOL mark (three slanted bars) runs accent → long from the design
// tokens, close to the brand's own purple → green.
import type { ReactElement } from 'react'
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'
import { fallbackLetter, hasBrandIcon } from './assetIcons'

type Colors = ReturnType<typeof useTheme>['colors']
type Glyph = (size: number, colors: Colors) => ReactElement

const GLYPHS: Record<string, Glyph> = {
  SOL: (s, colors) => (
    <Svg width={s} height={s * 0.78} viewBox="0 0 398 312">
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
  ),
}

export function AssetIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const { colors } = useTheme()
  const letter = useTextStyle('bodyStrong')
  const glyph = hasBrandIcon(symbol) ? GLYPHS[symbol] : undefined
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {glyph ? (
        glyph(size * 0.55, colors)
      ) : (
        <Text style={[letter, { color: colors.textPrimary }]}>{fallbackLetter(symbol)}</Text>
      )}
    </View>
  )
}
