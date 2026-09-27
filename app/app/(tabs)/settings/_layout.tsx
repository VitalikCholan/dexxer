import { WalletUiDropdown } from '@/src/features/wallet/WalletUiDropdown'
import { Stack } from 'expo-router'
import React from 'react'

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerTitle: 'Settings', headerRight: () => <WalletUiDropdown /> }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="ui-gallery" options={{ headerTitle: 'UI Gallery' }} />
    </Stack>
  )
}
