// app/src/features/account/ExitSheet.tsx
//
// Task 10 (week 5, Task 6): `undelegate_user` confirmation. The checklist
// mirrors the program's hard preconditions — no open position (`Positions`
// has no open slot), `free_margin == 0 && locked_margin == 0` — so the user
// sees why the button is disabled before tapping it. Nothing is revealed on
// exit: trades are never disclosed (spec §2.9).
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

export function ExitSheet({ open, onClose, checklist, busy, onConfirm }: ExitSheetProps) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const ready = checklist.noOpenPosition && checklist.balanceWithdrawn

  return (
    <Sheet open={open} onClose={onClose} title="Exit private account">
      <ChecklistRow ok={checklist.noOpenPosition} label="No open position" />
      <ChecklistRow ok={checklist.balanceWithdrawn} label="Balance withdrawn" />
      <Text style={[caption, { color: colors.textSecondary }]}>
        Your accounts return to L1 with private fields erased.
      </Text>
      <Button variant="destructive" disabled={!ready || busy} onPress={() => void onConfirm()}>
        {busy ? 'Confirm in wallet…' : 'Exit private account'}
      </Button>
    </Sheet>
  )
}
