// app/src/features/account/ExitSheet.tsx
//
// Task 10 (week 5, Task 6): `undelegate_user` confirmation. The checklist
// mirrors the program's own REMAINING hard preconditions — no open
// position, `free_margin == 0 && locked_margin == 0`
// (`08-undelegate.ts`'s devnet reference) — so the user sees why the button
// is disabled before tapping it. `historyQueueEmpty` is gone from the
// checklist: week-5 Task 2 (spec §2.6.3) retired `QueueNotEmpty` —
// `undelegate_user` now succeeds with a non-empty `DisclosureQueue`, which
// stays behind in the ER (crank-only) until `commit_aggregate` drains it and
// the relayer's orphan janitor closes it. `pendingDisclosures` surfaces that
// as information, not a gate: how many still-queued trades will be revealed
// on the normal schedule after the owner has already left.
import { Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Sheet } from '@/src/ui/Sheet'
import { Button } from '@/src/ui/Button'

export interface ExitChecklist {
  noOpenPosition: boolean
  balanceWithdrawn: boolean
}

export interface ExitSheetProps {
  open: boolean
  onClose: () => void
  checklist: ExitChecklist
  /** Count of still-queued `DisclosureQueue` records — informational only, does not gate the Exit button. `0` hides the line entirely. */
  pendingDisclosures: number
  busy: boolean
  onConfirm: () => Promise<void>
}

function ChecklistRow({ ok, label }: { ok: boolean; label: string }) {
  const { colors } = useTheme()
  const body = useTextStyle('body')
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <Text style={{ color: ok ? colors.long : colors.textTertiary }}>{ok ? '✓' : '○'}</Text>
      <Text style={[body, { color: ok ? colors.textPrimary : colors.textSecondary }]}>{label}</Text>
    </View>
  )
}

export function ExitSheet({ open, onClose, checklist, pendingDisclosures, busy, onConfirm }: ExitSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const ready = checklist.noOpenPosition && checklist.balanceWithdrawn

  return (
    <Sheet open={open} onClose={onClose} title="Exit private account">
      <ChecklistRow ok={checklist.noOpenPosition} label="No open position" />
      <ChecklistRow ok={checklist.balanceWithdrawn} label="Balance withdrawn" />
      {pendingDisclosures > 0 ? (
        <Text style={[caption, { color: colors.warning }]}>
          {pendingDisclosures} trade{pendingDisclosures === 1 ? '' : 's'} will be revealed after you exit
        </Text>
      ) : null}
      <Text style={[caption, { color: colors.textSecondary }]}>
        Your accounts return to L1 with private fields erased.
      </Text>
      <Button variant="destructive" disabled={!ready || busy} onPress={() => void onConfirm()}>
        {busy ? 'Confirm in wallet…' : 'Exit private account'}
      </Button>
    </Sheet>
  )
}
