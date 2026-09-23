import { Link } from 'expo-router'
import { SettingsUiCluster } from '@/components/settings/settings-ui-cluster'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import { SettingsAppConfig } from '@/components/settings/settings-app-config'
import { SettingsUiAccount } from '@/components/settings/settings-ui-account'

import { AppPage } from '@/components/app-page'

// Task 8 (5-tab layout): `onboard`/`position`/`demo`/`spikes` dropped out of
// the tab bar (`href: null` in app/app/(tabs)/_layout.tsx) but stay reachable
// from here, plus the dev-only UI gallery (see app/app/(tabs)/settings/ui-gallery.tsx).
const DEVELOPER_LINKS: {
  href: '/onboard' | '/position' | '/demo' | '/spikes' | '/settings/ui-gallery'
  label: string
}[] = [
  { href: '/onboard', label: 'Onboard' },
  { href: '/position', label: 'Position (legacy)' },
  { href: '/demo', label: 'Demo' },
  { href: '/spikes', label: 'Spikes' },
  { href: '/settings/ui-gallery', label: 'UI gallery' },
]

export default function TabSettingsScreen() {
  return (
    <AppPage>
      <SettingsUiAccount />
      <SettingsAppConfig />
      <SettingsUiCluster />
      <AppView>
        <AppText type="subtitle">Developer</AppText>
        {DEVELOPER_LINKS.map((link) => (
          <Link key={link.href} href={link.href} asChild>
            <AppText type="link">{link.label}</AppText>
          </Link>
        ))}
      </AppView>
      <AppText type="default" style={{ opacity: 0.5, fontSize: 14 }}>
        Configure app info and clusters in{' '}
        <AppText type="defaultSemiBold" style={{ fontSize: 14 }}>
          constants/app-config.tsx
        </AppText>
        .
      </AppText>
    </AppPage>
  )
}
