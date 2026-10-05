// app/src/ui/AssetIcon.tsx
//
// A market's icon: the asset's brand mark or a letter avatar. Decorative —
// the symbol is always written next to it — so hidden from screen readers.
//
// Brand marks, taken from each project's own files (never traced or redrawn);
// brand colours live only in this file:
// - SOL  — Solana's three bars; gradient from our tokens (accent → long),
//          close to the brand's purple → green.
// - BTC  — the Bitcoin logo (bitcoin.org, public domain), Wikimedia Commons
//          File:Bitcoin.svg: #f7931a disc, white ₿.
// - ETH  — the Ethereum diamond from ethereum.org
//          (ethereum-org-website/public/images/assets/svgs/eth-diamond-black.svg),
//          drawn in white for our dark background, the original facet opacities kept.
// - HYPE — the Hyperliquid mark from hyperliquid.xyz's own logo SVG (the path
//          before the wordmark), in the site's mint #97fce3 for a dark background.
// - ZEC  — the Zcash logo from z.cash (wp-content/uploads/2023/03/zcash-logo.svg):
//          #f3b724 disc, white Z.
// A logo that is itself a disc (BTC, ZEC) fills the whole icon; a mark sits
// on the `surfaceAlt` circle at ~55 % of its size.
import type { ReactElement } from 'react'
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from './styles'
import { fallbackLetter, hasBrandIcon } from './assetIcons'

type Colors = ReturnType<typeof useTheme>['colors']
interface Glyph {
  /** `disc`: the logo is a full circle and replaces the background; `mark`: drawn on the surfaceAlt circle. */
  kind: 'disc' | 'mark'
  draw: (size: number, colors: Colors) => ReactElement
}

const GLYPHS: Record<string, Glyph> = {
  SOL: {
    kind: 'mark',
    draw: (s, colors) => (
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
  },
  BTC: {
    kind: 'disc',
    draw: (s) => (
      <Svg width={s} height={s} viewBox="0 0 64 64">
        <G transform="translate(0.00630876,-0.00301984)">
          <Path
            fill="#f7931a"
            d="m63.033,39.744c-4.274,17.143-21.637,27.576-38.782,23.301-17.138-4.274-27.571-21.638-23.295-38.78,4.272-17.145,21.635-27.579,38.775-23.305,17.144,4.274,27.576,21.64,23.302,38.784z"
          />
          <Path
            fill="#ffffff"
            d="m46.103,27.444c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4,5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439,5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934,3.75s2.605,0.597,2.55,0.634c1.422,0.355,1.679,1.296,1.636,2.042l-1.638,6.571c0.098,0.025,0.225,0.061,0.365,0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296,9.205c-0.174,0.432-0.615,1.08-1.609,0.834,0.035,0.051-2.552-0.637-2.552-0.637l-1.743,4.019,4.569,1.139c0.85,0.213,1.683,0.436,2.503,0.646l-1.453,5.834,3.507,0.875,1.439-5.772c0.958,0.26,1.888,0.5,2.798,0.726l-1.434,5.745,3.511,0.875,1.453-5.823c5.987,1.133,10.489,0.676,12.384-4.739,1.527-4.36-0.076-6.875-3.226-8.515,2.294-0.529,4.022-2.038,4.483-5.155zm-8.022,11.249c-1.085,4.36-8.426,2.003-10.806,1.412l1.928-7.729c2.38,0.594,10.012,1.77,8.878,6.317zm1.086-11.312c-0.99,3.966-7.1,1.951-9.082,1.457l1.748-7.01c1.982,0.494,8.365,1.416,7.334,5.553z"
          />
        </G>
      </Svg>
    ),
  },
  ETH: {
    kind: 'mark',
    draw: (s) => (
      <Svg width={s * 0.62} height={s} viewBox="420 80 1080 1760">
        <Path fill="#ffffff" opacity={0.6} d="m959.8 730.9-539.8 245.4 539.8 319.1 539.9-319.1z" />
        <Path fill="#ffffff" opacity={0.45} d="m420.2 976.3 539.8 319.1v-564.5-650.3z" />
        <Path fill="#ffffff" opacity={0.8} d="m960 80.6v650.3 564.5l539.8-319.1z" />
        <Path fill="#ffffff" opacity={0.45} d="m420 1078.7 539.8 760.7v-441.8z" />
        <Path fill="#ffffff" opacity={0.8} d="m959.8 1397.6v441.8l540.2-760.7z" />
      </Svg>
    ),
  },
  HYPE: {
    kind: 'mark',
    draw: (s) => (
      <Svg width={s} height={s * 0.72} viewBox="0 45 153 110">
        <Path
          fill="#97fce3"
          d="M152.75393,98.33694c0,49.53839-30.41458,65.4366-46.54323,51.38164-13.13338-11.52047-17.05043-35.94411-36.86579-38.47859-25.11487-2.99537-27.419,30.41426-44.00855,30.41426-19.35459,0-23.04117-27.87978-23.04117-42.39574,0-14.74629,4.14741-34.7921,20.50659-34.7921,19.12413,0,20.27625,28.80147,44.23899,27.18856,23.7324-1.61291,24.19319-31.56639,39.86116-44.23897,13.59385-11.29016,45.852.69123,45.852,50.92094Z"
        />
      </Svg>
    ),
  },
  ZEC: {
    kind: 'disc',
    draw: (s) => (
      <Svg width={s} height={s} viewBox="0 0 65 65">
        <G transform="translate(-138 -41)">
          <Path
            fill="#f3b724"
            d="M32.5,0A32.5,32.5,0,1,1,0,32.5,32.5,32.5,0,0,1,32.5,0Z"
            transform="translate(138 41)"
          />
          <Path
            fill="#ffffff"
            d="M8.591,0V5.146H0v6.2H13.33L0,28.974v4.667H8.591v5.113H13.87V33.641H22.46v-6.2H9.131L22.46,9.813V5.146H13.87V0Z"
            transform="translate(159 54)"
          />
        </G>
      </Svg>
    ),
  },
}

export function AssetIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const { colors } = useTheme()
  const letter = useTextStyle('bodyStrong')
  const glyph = hasBrandIcon(symbol) ? GLYPHS[symbol] : undefined
  const disc = glyph?.kind === 'disc'
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: disc ? 'transparent' : colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {glyph ? (
        glyph.draw(disc ? size : size * 0.55, colors)
      ) : (
        <Text style={[letter, { color: colors.textPrimary }]}>{fallbackLetter(symbol)}</Text>
      )}
    </View>
  )
}
