// app/src/features/settings/SettingsAbout.tsx
//
// Third-party attribution. lightweight-charts' license (README, "License")
// requires showing its NOTICE text and a link to https://www.tradingview.com/
// on a page users can reach; the chart runs with `attributionLogo: false`
// (`chartHtml.ts`), so this section is where that requirement is met.
import { Linking, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { LWC_VERSION } from '@/src/features/chart/lwcSource.generated'

const TRADINGVIEW_URL = 'https://www.tradingview.com/'

export function SettingsAbout() {
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')
  return (
    <View style={{ gap: space.sm }}>
      <Text style={[heading, { color: colors.textPrimary }]}>About</Text>
      <Text style={[body, { color: colors.textSecondary }]}>
        Charts by TradingView Lightweight Charts™ v{LWC_VERSION}
      </Text>
      <Text style={[caption, { color: colors.textTertiary }]}>
        Copyright (c) 2025 TradingView, Inc. Licensed under the Apache License 2.0.
      </Text>
      <Text
        accessibilityRole="link"
        style={[body, { color: colors.accent }]}
        onPress={() => void Linking.openURL(TRADINGVIEW_URL).catch(() => undefined)}
      >
        tradingview.com
      </Text>
    </View>
  )
}
