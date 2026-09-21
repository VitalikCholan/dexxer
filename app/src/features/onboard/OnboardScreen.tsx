// app/src/features/onboard/OnboardScreen.tsx
//
// Task 7: the private onboarding flow, driven by `useOnboarding()`. One
// "Continue" button drives the whole sequence — faucet -> init_user ->
// delegate -> credit_deposit -> init_permissions -> set_session -> session
// top-up (see useOnboarding.ts header) — each step idempotent, so tapping it
// again after a failure (network blip, a declined MWA prompt) resumes from
// wherever it broke instead of restarting.
import { useEffect } from 'react'
import { Button, ScrollView, Text, View } from 'react-native'
import { AppPage } from '@/components/app-page'
import { useOnboarding, type OnboardState } from './useOnboarding'

const STATE_LABEL: Record<OnboardState, string> = {
  Disconnected: 'Wallet not connected',
  NotOnboarded: 'Not onboarded',
  Funded: 'Faucet funded (dUSDC minted)',
  Initialized: 'User initialized (UserAccount/Position/DisclosureQueue on L1)',
  Delegated: 'Delegated to the ER',
  Credited: 'Deposit credited (ER free_margin)',
  Permissioned: 'Private permissions set (owner + crank)',
  SessionSet: 'Session key active — ready to trade',
}

const STATE_ORDER: OnboardState[] = [
  'Disconnected',
  'NotOnboarded',
  'Funded',
  'Initialized',
  'Delegated',
  'Credited',
  'Permissioned',
  'SessionSet',
]

function progressFraction(state: OnboardState): number {
  const i = STATE_ORDER.indexOf(state)
  return i <= 1 ? 0 : (i - 1) / (STATE_ORDER.length - 2)
}

export function OnboardScreen() {
  const { owner, session, state, busy, log, error, connectWallet, refresh, advance } = useOnboarding()

  useEffect(() => {
    void refresh()
    // Only re-check when the connected wallet changes — `refresh` is
    // recreated each render (it closes over `owner`), so it isn't a dep here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.toBase58()])

  const done = state === 'SessionSet'

  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: 16, paddingVertical: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700' }}>Private onboarding</Text>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Owner</Text>
          <Text selectable>{owner ? owner.toBase58() : 'not connected'}</Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Session key (this device, never leaves it)</Text>
          <Text selectable>{session ? session.toBase58() : 'not generated yet'}</Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Status</Text>
          <Text>
            {state} — {STATE_LABEL[state]}
          </Text>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: '#3333', overflow: 'hidden' }}>
            <View
              style={{
                height: 8,
                width: `${Math.round(progressFraction(state) * 100)}%`,
                backgroundColor: done ? '#22c55e' : '#3b82f6',
              }}
            />
          </View>
        </View>

        {error ? (
          <Text selectable style={{ color: '#ef4444' }}>
            {error}
          </Text>
        ) : null}

        {!owner ? (
          <Button title="Connect wallet" onPress={() => void connectWallet()} disabled={busy} />
        ) : (
          <Button
            title={done ? 'Onboarding complete' : busy ? 'Working…' : 'Continue onboarding'}
            onPress={() => void advance()}
            disabled={busy || done}
          />
        )}

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Log</Text>
          {log.length === 0 ? <Text style={{ opacity: 0.6 }}>No steps run yet.</Text> : null}
          {log.map((line, i) => (
            <Text key={i} selectable style={{ fontSize: 12 }}>
              {line}
            </Text>
          ))}
        </View>
      </ScrollView>
    </AppPage>
  )
}
