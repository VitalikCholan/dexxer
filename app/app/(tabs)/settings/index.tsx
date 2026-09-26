import { Link } from 'expo-router'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { SettingsUiAccount } from '@/components/settings/settings-ui-account'
import { AppPage } from '@/components/app-page'

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
  return (
    <AppPage>
      <SettingsUiAccount />
      <AppView>
        <AppText type="subtitle">Developer</AppText>
        {DEVELOPER_LINKS.map((link) => (
          <Link key={link.href} href={link.href} asChild>
            <AppText type="link">{link.label}</AppText>
          </Link>
        ))}
      </AppView>
    </AppPage>
  )
}
