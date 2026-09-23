// app/src/features/onboard/ConnectScreen.tsx
//
// Task 10: the very first screen — wordmark, one value line, Connect wallet
// (opens the system MWA wallet picker). Per the "chego NOT to draw" list
// (design prompt), no logo art — text wordmark only.
import { View, Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Button } from '@/src/ui/Button'

export function ConnectScreen({ busy, onConnect }: { busy: boolean; onConnect: () => void }) {
  const { colors, space } = useTheme()
  const display = useTextStyle('display')
  const body = useTextStyle('body')

  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: space.xl, paddingHorizontal: space.lg }}>
      <Text style={[display, { color: colors.textPrimary, textAlign: 'center' }]}>Dexxer</Text>
      <Text style={[body, { color: colors.textSecondary, textAlign: 'center' }]}>
        Your position is yours alone. The world sees only the pool.
      </Text>
      <Button variant="primary" loading={busy} onPress={onConnect}>
        Connect wallet
      </Button>
    </View>
  )
}
