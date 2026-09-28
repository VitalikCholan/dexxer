// app/src/features/info/InfoArticle.tsx
//
// Shared layout for the static explainer pages under `app/(tabs)/info`:
// an intro paragraph and titled sections of paragraphs, on design tokens.
// A plain View, not `Page`: the Stack header already covers the top inset,
// and `Page`'s SafeAreaView added it a second time under the header.
import { ScrollView, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'

export interface InfoSection {
  title: string
  paragraphs: string[]
}

export function InfoArticle({ intro, sections, footer }: { intro: string; sections: InfoSection[]; footer?: string }) {
  const { colors, space, layout } = useTheme()
  const body = useTextStyle('body')
  const heading = useTextStyle('heading')
  const caption = useTextStyle('caption')

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingHorizontal: layout.gutter }}>
      <ScrollView contentContainerStyle={{ gap: space.xl, paddingVertical: space.lg }}>
        <Text style={[body, { color: colors.textPrimary }]}>{intro}</Text>
        {sections.map((s) => (
          <View key={s.title} style={{ gap: space.sm }}>
            <Text style={[heading, { color: colors.textPrimary }]}>{s.title}</Text>
            {s.paragraphs.map((p) => (
              <Text key={p} style={[body, { color: colors.textSecondary }]}>
                {p}
              </Text>
            ))}
          </View>
        ))}
        {footer ? <Text style={[caption, { color: colors.textTertiary }]}>{footer}</Text> : null}
      </ScrollView>
    </View>
  )
}
