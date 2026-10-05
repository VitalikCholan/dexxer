// app/src/features/receipt/PoolSnapshotCard.tsx
//
// Account -> "Pool snapshot": the latest public `Pool` snapshot
// (`usePoolHistory()`) — the coarsened aggregate that leaves the private ER every
// 5 minutes (`commit_aggregate`). Mapping: Liquidity = capital_total, Locked =
// locked_total (margin backing open positions), Fees = fees_accrued.
import { Text } from 'react-native'
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

export function PoolSnapshotCard() {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const history = usePoolHistory(1)
  const latest = history.data && history.data.length > 0 ? history.data[history.data.length - 1] : null

  return (
    <Card title="Pool snapshot">
      {history.isLoading ? (
        <Skeleton lines={3} />
      ) : !latest ? (
        <EmptyState text="No pool snapshot yet — first commit lands within 5 min of protocol bootstrap." />
      ) : (
        <>
          <Row label="Liquidity" value={`${usd(latest.capitalTotal)} dUSDC`} mono />
          <Row label="Locked" value={`${usd(latest.lockedTotal)} dUSDC`} mono />
          <Row label="Fees" value={`${usd(latest.feesAccrued)} dUSDC`} mono />
          <Text style={[caption, { color: colors.textTertiary }]}>Updated at slot {latest.slot} · every 5 min</Text>
          <Text style={[caption, { color: colors.textTertiary }]}>Values rounded to 100 dUSDC</Text>
        </>
      )}
    </Card>
  )
}
