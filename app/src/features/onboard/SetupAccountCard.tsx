// app/src/features/onboard/SetupAccountCard.tsx
//
// Shared "this device isn't set up yet" prompt. Replaces the old dead-end
// red text ("No session key on this device yet — finish onboarding first
// (Onboard tab)") that a fresh wallet used to hit on Account/Positions/Trade
// with no way forward — `onboard` is `href: null`, out of the tab bar, so
// "(Onboard tab)" pointed at nothing a user could tap. `router.push`
// still reaches it; every consumer of this card routes there.
import { router } from 'expo-router'
import { Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Button } from '@/src/ui/Button'

export const SETUP_PRIVATE_ACCOUNT_LABEL = 'Set up private account'

export function SetupAccountCard() {
  const { colors } = useTheme()
  const body = useTextStyle('body')

  return (
    <Card>
      <Text style={[body, { color: colors.textSecondary }]}>
        Your private account isn&apos;t set up on this device yet.
      </Text>
      <Button variant="primary" onPress={() => router.push('/onboard')}>
        {SETUP_PRIVATE_ACCOUNT_LABEL}
      </Button>
    </Card>
  )
}
