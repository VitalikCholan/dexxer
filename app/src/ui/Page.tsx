// app/src/ui/Page.tsx
//
// Screen wrapper every tab/product screen renders inside (week 6: replaces
// the Expo template's `AppPage`/`AppView`, on design tokens instead of the
// template's `useThemeColor` indirection). Geometry is the template's —
// `gap`/gutter 16 — so no screen moved by a pixel in the migration.
import type { PropsWithChildren } from 'react'
import { View, type ViewProps } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@/src/theme'

export function Page({ children, style, ...props }: PropsWithChildren<ViewProps>) {
  const { colors, space, layout } = useTheme()
  return (
    <View style={[{ flex: 1, backgroundColor: colors.bg }, style]} {...props}>
      <SafeAreaView style={{ flex: 1, gap: space.lg, paddingHorizontal: layout.gutter }}>{children}</SafeAreaView>
    </View>
  )
}
