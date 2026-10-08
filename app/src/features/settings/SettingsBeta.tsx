// app/src/features/settings/SettingsBeta.tsx
//
// Closed beta section: "Report a problem" and the crash-report switch
// (lib/crashReporter.ts; on unless turned off here).
import { useEffect, useState } from 'react'
import { Link } from 'expo-router'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { crashReportsEnabled, setCrashReportsEnabled } from '@/src/lib/crashReporter'
import { appInfo } from '@/src/lib/appInfo'

export function SettingsBeta() {
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')
  const [crashes, setCrashes] = useState<boolean | null>(null)
  const info = appInfo()

  useEffect(() => {
    let live = true
    void crashReportsEnabled().then((v) => live && setCrashes(v))
    return () => {
      live = false
    }
  }, [])

  return (
    <View style={{ gap: space.sm }}>
      <Text style={[heading, { color: colors.textPrimary }]}>Beta</Text>
      <Link href="/report" asChild>
        <Text style={StyleSheet.flatten([body, { color: colors.accentText, lineHeight: 30 }])}>Report a problem</Text>
      </Link>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[body, { color: colors.textPrimary }]}>Send crash reports</Text>
          <Text style={[caption, { color: colors.textTertiary }]}>
            After a crash, the error and recent app events are sent on the next launch. Never amounts or positions.
          </Text>
        </View>
        <Switch
          value={crashes ?? true}
          disabled={crashes === null}
          accessibilityLabel="Send crash reports"
          onValueChange={(v) => {
            setCrashes(v)
            void setCrashReportsEnabled(v)
          }}
          trackColor={{ true: colors.accent, false: colors.border }}
          thumbColor={colors.textPrimary}
        />
      </View>
      <Text style={[caption, { color: colors.textTertiary }]}>
        {`Version ${info.version}${info.build ? ` (build ${info.build})` : ''}${info.channel ? ` · ${info.channel}` : ''}`}
      </Text>
    </View>
  )
}
