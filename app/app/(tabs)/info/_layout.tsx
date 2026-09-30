import { router, Stack } from 'expo-router'
import React from 'react'
import { Pressable, Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'

// Static explainer pages linked from the Trade screen's About card (C.6-A).
// Each page is this Stack's root, so the header has no back arrow of its
// own — `BackButton` returns to wherever the link was tapped.
function BackButton() {
  const { colors, space } = useTheme()
  const style = useTextStyle('title')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={space.md}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/trade'))}
      style={{ paddingRight: space.lg }}
    >
      <Text style={[style, { color: colors.textPrimary }]}>‹</Text>
    </Pressable>
  )
}

export default function InfoLayout() {
  return (
    <Stack screenOptions={{ headerLeft: () => <BackButton /> }}>
      <Stack.Screen name="perpetuals" options={{ headerTitle: 'Perpetuals' }} />
      <Stack.Screen name="risk" options={{ headerTitle: 'Risk disclosure' }} />
    </Stack>
  )
}
