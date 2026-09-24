import { Tabs } from 'expo-router'
import React from 'react'
import { UiIconSymbol } from '@/components/ui/ui-icon-symbol'
import { useTheme } from '@/src/theme'

// Visible order (task-8, Claude Design 5-tab layout): trade, positions,
// history, ledger, account. Everything else (`index`, `onboard`, `position`,
// `demo`, `spikes`, `settings`) is `href: null` — out of the tab bar but
// still reachable via router.push, and linked from Account → Settings →
// Developer (see app/app/(tabs)/settings/index.tsx).

// Cold-start fix (observed live): expo-router's <Tabs> otherwise opens the
// first declared `Tabs.Screen` ('trade') regardless of declaration order in
// JSX vs. file layout, so `index.tsx`'s onboarding-gate `Redirect` never ran
// on a fresh launch. `initialRouteName` is expo-router's documented,
// file-based way to pick the initial route within a layout without
// reordering the visible tab bar (`index` stays `href: null` below).
export const unstable_settings = {
  initialRouteName: 'index',
}

export default function TabLayout() {
  const { colors, layout, border } = useTheme()

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          height: layout.tabBar,
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
          borderTopWidth: border.hairline,
        },
      }}
    >
      <Tabs.Screen
        name="trade"
        options={{
          title: 'Trade',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="arrow.left.arrow.right" color={color} />,
        }}
      />
      <Tabs.Screen
        name="positions"
        options={{
          title: 'Positions',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="chart.bar.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="clock.arrow.circlepath" color={color} />,
        }}
      />
      {/* Ledger tab hidden for the 24.09 demo (user request) — `href: null` keeps the
          route registered (deep link `app://ledger` still works) but drops it from the
          tab bar. Restore by removing `href: null`. */}
      <Tabs.Screen name="ledger" options={{ href: null, title: 'Ledger' }} />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color }) => <UiIconSymbol size={28} name="wallet.pass.fill" color={color} />,
        }}
      />

      {/* Not in the tab bar — reachable via navigation only. */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="onboard" options={{ href: null, title: 'Onboard' }} />
      <Tabs.Screen name="position" options={{ href: null, title: 'Position' }} />
      <Tabs.Screen name="settings" options={{ href: null, title: 'Settings' }} />
      <Tabs.Screen name="demo" options={{ href: null, title: 'Demo' }} />
      <Tabs.Screen name="spikes" options={{ href: null, title: 'Spikes' }} />
    </Tabs>
  )
}
