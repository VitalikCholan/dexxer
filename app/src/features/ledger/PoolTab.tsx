// app/src/features/ledger/PoolTab.tsx
//
// Task 10: the latest public `Pool` snapshot (`usePoolHistory()`, Task 9) —
// the aggregate that leaves the private ER every 5 minutes
// (`commit_aggregate`, CLAUDE.md). Field mapping (the design mockup's
// "Liquidity"/"Locked"/"Fees" onto `PoolSnapshot`'s actual columns):
// Liquidity = capital_total (the pool's total backing capital), Locked =
// locked_total (margin currently backing open positions), Fees =
// fees_accrued.
import { ScrollView, Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Skeleton } from '@/src/ui/Skeleton'
import { EmptyState } from '@/src/ui/EmptyState'
import { usePoolHistory } from '@/src/lib/indexer'

function usd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function PoolTab() {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')
  const history = usePoolHistory(1)
  const latest = history.data && history.data.length > 0 ? history.data[history.data.length - 1] : null

  return (
    <ScrollView contentContainerStyle={{ gap: space.md, paddingVertical: space.md }}>
      {history.isLoading ? (
        <Skeleton lines={4} />
      ) : !latest ? (
        <EmptyState text="No pool snapshot yet — first commit lands within 5 min of protocol bootstrap." />
      ) : (
        <Card>
          <Row label="Liquidity" value={`${usd(latest.capitalTotal)} dUSDC`} />
          <Row label="Locked" value={`${usd(latest.lockedTotal)} dUSDC`} />
          <Row label="Fees" value={`${usd(latest.feesAccrued)} dUSDC`} />
          <Text style={[caption, { color: colors.textTertiary }]}>Updated at slot {latest.slot} · every 5 min</Text>
          <Text style={[caption, { color: colors.textTertiary }]}>Values rounded to 100 dUSDC</Text>
        </Card>
      )}
    </ScrollView>
  )
}
