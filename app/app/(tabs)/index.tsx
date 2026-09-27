import React from 'react'
import { Redirect } from 'expo-router'
import { Page } from '@/src/ui/Page'
import { Skeleton } from '@/src/ui/Skeleton'
import { useOnboardingGate } from '@/src/features/onboard/useOnboardingGate'

// Routing gate (fix: a fresh wallet used to always land on `/(tabs)/account`,
// which shows a dead-end "finish onboarding first (Onboard tab)" message —
// `onboard` is `href: null`, out of the tab bar). `no_wallet`/`needs_setup`
// send the device to the hidden `onboard` route (reachable via
// `router.push`, per `_layout.tsx`); `ready` skips straight to Trade.
export default function TabsIndexScreen() {
  const { status } = useOnboardingGate()

  if (status === 'loading') {
    return (
      <Page>
        <Skeleton lines={4} />
      </Page>
    )
  }
  if (status === 'ready') {
    return <Redirect href="/(tabs)/trade" />
  }
  return <Redirect href="/(tabs)/onboard" />
}
