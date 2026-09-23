// app/src/features/onboard/OnboardScreen.tsx
//
// Task 10: Connect -> "Set up private account" (3 steps, StepsList.tsx) ->
// Done, per design. One "Confirm in wallet" button drives the whole
// remaining batch (`useOnboarding`'s `advance` -> `runBatchedOnboarding`);
// each leg is idempotent, so re-tapping after a failure resumes rather than
// restarts.
//
// Copy correction (controller ruling — measured fact overrides the design
// mockup): the subtitle is NOT "No SOL needed" — rent for the L1
// PDAs/eSPL delegation is sponsored (`services/relayer`'s `/sponsor`,
// Task 6), but `delegate_user`'s own CPI to the Delegation Program still
// draws directly from the owner and has no sponsor path (Task 6 fix round
// 1's residual-gap finding, `batchOnboarding.ts`'s header comment): a
// genuinely 0-SOL wallet cannot complete onboarding, real measured minimum
// ≈0.0033-0.0035 SOL. The subtitle below says so plainly instead of
// promising zero.
import { router } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { AppPage } from '@/components/app-page'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Button } from '@/src/ui/Button'
import { Address } from '@/src/ui/Address'
import { ConnectScreen } from './ConnectScreen'
import { StepsList } from './StepsList'
import { useOnboarding } from './useOnboarding'
import { useOnboardingGate } from './useOnboardingGate'

export function OnboardScreen() {
  const { colors, space } = useTheme()
  const title = useTextStyle('title')
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')

  const { owner, session, state, busy, error, batchProgress, connectWallet, advance } = useOnboarding()
  const gate = useOnboardingGate()

  if (!owner) {
    return (
      <AppPage>
        <ConnectScreen busy={busy} onConnect={() => void connectWallet()} />
      </AppPage>
    )
  }

  // `state === 'SessionSet'` covers this run's batch just finishing;
  // `gate.status === 'ready'` covers landing on /onboard with a device
  // that was already set up in an earlier session — the gate re-derives
  // readiness from L1 + the stored session key without replaying the
  // onboarding state machine's own (mount-time-only) L1 check.
  if (state === 'SessionSet' || gate.status === 'ready') {
    return (
      <AppPage>
        <View style={{ flex: 1, justifyContent: 'center', gap: space.lg, paddingHorizontal: space.lg }}>
          <Text style={[title, { color: colors.textPrimary, textAlign: 'center' }]}>You&apos;re set.</Text>
          <Text style={[body, { color: colors.textSecondary, textAlign: 'center' }]}>Session key active for 24h</Text>
          <Button
            variant="primary"
            onPress={() => {
              gate.refetch()
              router.replace('/(tabs)/trade')
            }}
          >
            Go to Trade
          </Button>
        </View>
      </AppPage>
    )
  }

  const failedStep = batchProgress.phase === 'Failed'

  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <Text style={[title, { color: colors.textPrimary }]}>Set up private account</Text>

        <View style={{ gap: space.xs }}>
          <Text style={[caption, { color: colors.textSecondary }]}>Owner</Text>
          <Address pubkey={owner.toBase58()} />
          {session ? (
            <>
              <Text style={[caption, { color: colors.textSecondary }]}>Session key</Text>
              <Address pubkey={session.toBase58()} />
            </>
          ) : null}
        </View>

        <StepsList state={state} progress={batchProgress} />

        {error ? <Text style={{ color: colors.short }}>{error}</Text> : null}

        <Button variant="primary" disabled={busy && !failedStep} onPress={() => void advance()}>
          {busy ? 'Confirming…' : failedStep ? 'Retry' : 'Confirm in wallet'}
        </Button>
        <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
          Account rent is sponsored — you need ≈0.004 SOL for delegation
        </Text>
      </ScrollView>
    </AppPage>
  )
}
