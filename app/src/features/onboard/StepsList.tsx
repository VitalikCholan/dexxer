// app/src/features/onboard/StepsList.tsx
//
// Task 10: the 3-step "Set up private account" list. Maps the design's 3
// steps onto `batchOnboarding.ts`'s actual legs (brief's own mapping): L1a
// (faucet_init + init_user) = "Create private accounts (L1)", L1b
// (delegateSpl + delegate_user) = "Move them into the private enclave
// (L1)", the ER leg + session top-up = "Activate session key (enclave)".
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import type { BatchProgress, OnboardState } from './batchOnboarding'

export type StepStatus = 'waiting' | 'signing' | 'confirming' | 'done' | 'failed'

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

interface StepDef {
  label: string
  doneAt: OnboardState
  legs: string[]
}

const STEPS: StepDef[] = [
  { label: 'Create private accounts (L1)', doneAt: 'Initialized', legs: ['faucet+init_user'] },
  { label: 'Move them into the private enclave (L1)', doneAt: 'Delegated', legs: ['delegate'] },
  { label: 'Activate session key (enclave)', doneAt: 'SessionSet', legs: ['permissions+session', 'session top-up'] },
]

function stepStatus(step: StepDef, state: OnboardState, progress: BatchProgress): StepStatus {
  const doneIdx = STATE_ORDER.indexOf(step.doneAt)
  if (STATE_ORDER.indexOf(state) >= doneIdx) return 'done'
  if (progress.phase === 'Failed') {
    if (progress.step && step.legs.includes(progress.step)) return 'failed'
    // A signing-time failure (no specific leg landed yet) fails the first not-yet-done step.
    if (progress.step === 'signing') return 'failed'
    return 'waiting'
  }
  if (progress.phase === 'Submitting' && progress.step && step.legs.includes(progress.step)) return 'confirming'
  if (progress.phase === 'Signing' || progress.phase === 'Collecting') return 'signing'
  return 'waiting'
}

const STATUS_ICON: Record<StepStatus, string> = {
  waiting: '○',
  signing: '…',
  confirming: '…',
  done: '✓',
  failed: '✕',
}

export function StepsList({ state, progress }: { state: OnboardState; progress: BatchProgress }) {
  const { colors, space } = useTheme()
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')

  return (
    <View style={{ gap: space.md }}>
      {STEPS.map((step) => {
        const status = stepStatus(step, state, progress)
        const color =
          status === 'done'
            ? colors.long
            : status === 'failed'
              ? colors.short
              : status === 'waiting'
                ? colors.textTertiary
                : colors.accent
        return (
          <View key={step.label} style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            <Text style={{ color, width: 20 }}>{STATUS_ICON[status]}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[body, { color: colors.textPrimary }]}>{step.label}</Text>
              <Text style={[caption, { color: colors.textTertiary }]}>{status}</Text>
            </View>
          </View>
        )
      })}
    </View>
  )
}
