import { Link } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Page } from '@/src/ui/Page'
import { SettingsUiAccount } from '@/src/features/settings/SettingsUiAccount'

// Task 8 (5-tab layout): `onboard`/`position` dropped out of the tab bar
// (`href: null` in app/app/(tabs)/_layout.tsx) but stay reachable from here,
// plus the dev-only UI gallery and the devnet SOL airdrop (week 6: the
// template's demo/spikes screens and cluster switcher are gone — the app
// runs against one network profile, `src/lib/config.ts`).
const DEVELOPER_LINKS: {
  href: '/onboard' | '/position' | '/account/airdrop' | '/settings/ui-gallery'
  label: string
}[] = [
  { href: '/onboard', label: 'Onboard' },
  { href: '/position', label: 'Position (legacy)' },
  { href: '/account/airdrop', label: 'Airdrop devnet SOL' },
  { href: '/settings/ui-gallery', label: 'UI gallery' },
]

export default function TabSettingsScreen() {
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const link = useTextStyle('body')
  return (
    <Page>
      <SettingsUiAccount />
      <View style={{ gap: space.sm }}>
        <Text style={[heading, { color: colors.textPrimary }]}>Developer</Text>
        {DEVELOPER_LINKS.map((l) => (
          <Link key={l.href} href={l.href} asChild>
            <Text style={StyleSheet.flatten([link, { color: colors.accent, lineHeight: 30 }])}>{l.label}</Text>
          </Link>
        ))}
      </View>
    </Page>
  )
}
