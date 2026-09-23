// app/src/features/ledger/RootTab.tsx
//
// Task 10: the latest public `BalancesRoot` (`useRootLatest()`, Task 9) —
// root_slot, filled/64 leaves, and the account's own address (explorer
// link) as the "short hash" the design mockup calls for: `BalancesRoot` has
// no single merkle-root hash (spec §2.4.2 — inclusion is checked by scanning
// `leaves` directly, see ReceiptSection.tsx), so its own PDA address is the
// one short, explorer-linkable identifier this screen can show.
import { ScrollView, Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Address } from '@/src/ui/Address'
import { Skeleton } from '@/src/ui/Skeleton'
import { EmptyState } from '@/src/ui/EmptyState'
import { useRootLatest } from '@/src/lib/indexer'
import { ROOT_LEAVES } from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'

const BALANCES_ROOT_PDA = pdas.balancesRoot()

export function RootTab() {
  const { colors, space } = useTheme()
  const label = useTextStyle('micro')
  const root = useRootLatest()

  return (
    <ScrollView contentContainerStyle={{ gap: space.md, paddingVertical: space.md }}>
      {root.isLoading ? (
        <Skeleton lines={3} />
      ) : !root.data ? (
        <EmptyState text="No BalancesRoot commit yet." />
      ) : (
        <Card>
          <Row label="Root slot" value={String(root.data.root_slot)} mono />
          <Row label="Leaves" value={`${root.data.filled}/${ROOT_LEAVES}`} mono />
          <Text style={[label, { color: colors.textSecondary }]}>Account</Text>
          <Address pubkey={BALANCES_ROOT_PDA.toBase58()} explorer />
        </Card>
      )}
    </ScrollView>
  )
}
