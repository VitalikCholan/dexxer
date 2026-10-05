// app/src/features/onboard/OnboardScreen.tsx
//
// Task 10: Connect -> "Set up private account" (3 steps, StepsList.tsx) ->
// Done, per design. One "Confirm in wallet" button drives the whole
// remaining batch (`useOnboarding`'s `advance` -> `runBatchedOnboarding`);
// each leg is idempotent, so re-tapping after a failure resumes rather than
// restarts.
//
// Copy (week 5, Task 6): "No SOL needed — account rent is sponsored" is now
// accurate, not aspirational. Week 4's fix round left two owner-funded
// costs — the ATA-create and `delegate_user`'s own rent (no distinct
// `payer` field at all) — which week 5 closed on both ends:
// `delegate_user` gained a `payer` split from `owner`
// (programs/dexxer_core/src/instructions/user.rs), and
// `services/relayer/src/sponsor.ts`'s whitelist now fronts both. The ER
// leg (`init_permissions`/`set_session`) still costs the owner its own
// (negligible) ER network fee — it cannot be sponsored at all
// (`InvalidAccountForFee`, `batchOnboarding.ts`'s file header) — but that
// is not SOL rent, and the ER leg is funded from the shared ephemeral
// vault, not the owner's L1 balance.
import { useEffect } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { Page } from '@/src/ui/Page'
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

  const { owner, session, state, busy, error, batchProgress, connectWallet, refresh, advance } = useOnboarding()
  const gate = useOnboardingGate()
  // `reauth=1` (TradeScreen's "Re-authorize session"): the device IS set up,
  // but `UserAccount.sessionExpiry` lapsed — skip the "You're set" short-cut
  // and run the batch, which now re-issues `set_session` for a stale expiry
  // (`batchOnboarding.ts`'s `SESSION_RENEW_MARGIN_SECS`).
  const { reauth } = useLocalSearchParams<{ reauth?: string }>()
  const reauthorizing = reauth === '1'

  // Cheap L1-only progress read so the steps list reflects reality on mount
  // (without it `state` stays 'Disconnected' and every step shows "waiting"
  // even on a fully delegated device).
  const ownerKey = owner?.toBase58() ?? null
  useEffect(() => {
    if (ownerKey) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey])

  if (!owner) {
    return <ConnectScreen busy={busy} onConnect={() => void connectWallet()} />
  }

  // `state === 'SessionSet'` covers this run's batch just finishing;
  // `gate.status === 'ready'` covers landing on /onboard with a device
  // that was already set up in an earlier session — the gate re-derives
  // readiness from L1 + the stored session key without replaying the
  // onboarding state machine's own (mount-time-only) L1 check.
  if (state === 'SessionSet' || (gate.status === 'ready' && !reauthorizing)) {
    return (
      <Page>
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
      </Page>
    )
  }

  const failedStep = batchProgress.phase === 'Failed'

  return (
    <Page>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <Text style={[title, { color: colors.textPrimary }]}>
          {reauthorizing ? 'Re-authorize session' : 'Set up private account'}
        </Text>
        {reauthorizing ? (
          <Text style={[body, { color: colors.textSecondary }]}>
            Your session key expired. One enclave signature renews it for 24h — no SOL needed.
          </Text>
        ) : null}

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

        {state === 'Exited' ? (
          <Text style={[body, { color: colors.textSecondary }]}>
            Your account is being closed after exit — wait for the relayer to close it (up to 5 min) and try again.
          </Text>
        ) : (
          <StepsList state={state} progress={batchProgress} />
        )}

        {error ? <Text style={[caption, { color: colors.short }]}>{error}</Text> : null}

        <Button variant="primary" disabled={busy && !failedStep} onPress={() => void advance()}>
          {busy ? 'Confirming…' : failedStep ? 'Retry' : 'Confirm in wallet'}
        </Button>
        <Text style={[caption, { color: colors.textSecondary, textAlign: 'center' }]}>
          No SOL needed — rent is sponsored for empty wallets; a wallet holding SOL pays its own (≈0.03 SOL)
        </Text>
      </ScrollView>
    </Page>
  )
}
