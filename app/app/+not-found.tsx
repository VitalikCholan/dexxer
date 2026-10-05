import { Link, Stack } from 'expo-router'
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'

export default function NotFoundScreen() {
  const { colors, space } = useTheme()
  const title = useTextStyle('title')
  const body = useTextStyle('body')
  return (
    <>
      <Stack.Screen options={{ title: 'Oops!' }} />
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.xl,
          backgroundColor: colors.bg,
        }}
      >
        <Text style={[title, { color: colors.textPrimary, textAlign: 'center' }]}>This screen does not exist.</Text>
        <Link href="/" style={{ marginTop: space.md, paddingVertical: space.md }}>
          <Text style={[body, { color: colors.accentText }]}>Go to home screen!</Text>
        </Link>
      </View>
    </>
  )
}
