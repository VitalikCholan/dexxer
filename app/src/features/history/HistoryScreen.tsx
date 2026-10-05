// app/src/features/history/HistoryScreen.tsx
//
// Closed trades from the private `Positions` ring plus this device's archive
// (`useHistoryRows.ts`). Render only. ER slots carry no unix time, so the
// time shown is when this device first saw the record.
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { Page } from '@/src/ui/Page'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row as UiRow } from '@/src/ui/Row'
import { EmptyState } from '@/src/ui/EmptyState'
import { Skeleton } from '@/src/ui/Skeleton'
import { formatDusdc, formatSignedDusdc, formatUsd2 } from '@/src/lib/status'
import { pdas } from '@/src/lib/pdas'
import { useTradeSession } from '../trade/useTradeSession'
import { useHistoryRows } from './useHistoryRows'
import { reasonLabel } from './historyRows'

function fmtSize(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

export function HistoryScreen() {
  const { owner, conn, loading, error: sessionError } = useTradeSession()
  const positions = owner ? pdas.positions(owner) : null
  const { rows, live, archiveError, refreshing, onRefresh } = useHistoryRows(owner, conn, positions)

  const { colors, space } = useTheme()
  const heading = useTextStyle('title')
  const cardTitle = useTextStyle('bodyStrong')
  const caption = useTextStyle('caption')
  const error = sessionError ?? live.error ?? archiveError

  return (
    <Page>
      <ScrollView
        contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Text style={[heading, { color: colors.textPrimary }]}>History</Text>

        {error ? (
          <Text selectable style={[caption, { color: colors.short }]}>
            {error}
          </Text>
        ) : null}

        {loading ? (
          <Skeleton lines={3} />
        ) : !owner ? (
          <EmptyState text="Not connected — connect your wallet to see your trade history." />
        ) : rows.length === 0 ? (
          <EmptyState text="No closed trades yet" />
        ) : (
          <View style={{ gap: space.md }}>
            {rows.map((r) => (
              <Card key={r.key}>
                <Text style={[cardTitle, { color: colors.textPrimary }]}>
                  {`${reasonLabel(r.reason)} · ${r.side} ${fmtSize(r.size)} ${r.symbol}`}
                </Text>
                <UiRow label="Entry → Exit" value={`$${formatUsd2(r.entry)} → $${formatUsd2(r.exit)}`} mono />
                <UiRow label="PnL" value={formatSignedDusdc(r.pnl)} tone={r.pnl >= 0n ? 'success' : 'danger'} mono />
                <UiRow label="Fees" value={formatDusdc(r.fees)} mono />
                <Text style={[caption, { color: colors.textTertiary }]}>
                  seen {new Date(r.seenAt).toLocaleString()}
                </Text>
              </Card>
            ))}
          </View>
        )}
      </ScrollView>
    </Page>
  )
}
