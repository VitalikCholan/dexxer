// app/src/features/settings/SettingsLearn.tsx
//
// The in-app explainer and risk disclosure (`app/(tabs)/info`). They used to
// be linked from the "About <SYMBOL>-PERP" card at the bottom of Trade; the
// card repeated the Info tab's trading rules (and the oracle / pool details
// removed from the trader UI), so it was removed on 05.10.2026 and the links
// live here.
import { router } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'

const LINKS = [
  { label: 'Learn more about Perpetuals', href: '/info/perpetuals' as const },
  { label: 'View risk disclosure', href: '/info/risk' as const },
]

export function SettingsLearn() {
  const { colors, space, border, control } = useTheme()
  const heading = useTextStyle('heading')
  const link = useTextStyle('bodyStrong')
  const caption = useTextStyle('caption')
  return (
    <View style={{ gap: space.sm }}>
      <Text style={[heading, { color: colors.textPrimary }]}>Learn</Text>
      <View>
        {LINKS.map((l) => (
          <Pressable
            key={l.href}
            accessibilityRole="link"
            onPress={() => router.push(l.href)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: control.minHitTarget,
              borderTopWidth: border.hairline,
              borderTopColor: colors.border,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={[link, { color: colors.accentText }]}>{l.label}</Text>
            <Text style={[link, { color: colors.accentText }]}>›</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[caption, { color: colors.textTertiary }]}>Devnet: dUSDC is a test token with no value.</Text>
    </View>
  )
}
