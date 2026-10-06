// app/src/features/onboard/ConnectScreen.tsx
//
// The very first screen, as in the design's "00 · Connect"
// (docs/design/Dexxer App.dc.html): the Dexxer mark, the name under it (not
// in the design — the mark alone does not read as the name) and the value line,
// left-aligned and centred vertically (the design puts them near the top);
// Connect wallet (opens the system MWA wallet picker) at the bottom, in thumb
// reach. The design's "Mobile Wallet Adapter · Devnet" line under the button
// is left out (05.10.2026).
// Wraps itself in `Page`, so the sign-in gate and onboarding render it alike.
import { View, Text } from 'react-native'
import Svg, { ClipPath, Defs, G, Path, Rect } from 'react-native-svg'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Button } from '@/src/ui/Button'
import { Page } from '@/src/ui/Page'

/** The design's mark: a D and an X whose lower half is faded. Decorative — the screen is the Dexxer app. */
function DexxerMark({ color }: { color: string }) {
  return (
    <Svg
      width={132}
      height={92}
      viewBox="46 100 296 200"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <ClipPath id="top">
          <Rect x={46} y={100} width={296} height={100} />
        </ClipPath>
        <ClipPath id="bottom">
          <Rect x={46} y={200} width={296} height={100} />
        </ClipPath>
      </Defs>
      <Path
        fill={color}
        fillRule="evenodd"
        d="M56 110 H126 A90 90 0 0 1 126 290 H56 Z M96 150 H126 A50 50 0 0 1 126 250 H96 Z"
      />
      <G fill="none" stroke={color} strokeWidth={40} clipPath="url(#top)">
        <Path d="M 232 110 L 332 290" />
        <Path d="M 332 110 L 232 290" />
      </G>
      <G fill="none" stroke={color} strokeWidth={40} opacity={0.38} clipPath="url(#bottom)">
        <Path d="M 232 110 L 332 290" />
        <Path d="M 332 110 L 232 290" />
      </G>
    </Svg>
  )
}

export function ConnectScreen({
  busy,
  onConnect,
  onReport,
}: {
  busy: boolean
  onConnect: () => void
  onReport?: () => void
}) {
  const { colors, space } = useTheme()
  const name = useTextStyle('display')
  const tagline = useTextStyle('title')
  const caption = useTextStyle('caption')

  return (
    <Page>
      <View style={{ flex: 1, paddingHorizontal: space.sm, paddingBottom: space.xl }}>
        {/* Mark, name and value line centred vertically in the space above the button. */}
        <View style={{ flex: 1, justifyContent: 'center', gap: space.xl }}>
          <DexxerMark color={colors.accent} />
          <View style={{ gap: space.sm }}>
            <Text accessibilityRole="header" style={[name, { color: colors.textPrimary }]}>
              Dexxer
            </Text>
            <Text style={[tagline, { color: colors.textSecondary }]}>Your positions are only yours.</Text>
          </View>
        </View>
        <Button variant="primary" loading={busy} onPress={onConnect}>
          Connect wallet
        </Button>
        {onReport ? (
          <Text
            accessibilityRole="link"
            onPress={onReport}
            style={[caption, { color: colors.textSecondary, textAlign: 'center', paddingTop: space.md }]}
          >
            Trouble connecting? Report a problem
          </Text>
        ) : null}
      </View>
    </Page>
  )
}
