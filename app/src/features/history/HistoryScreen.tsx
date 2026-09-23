// app/src/features/history/HistoryScreen.tsx
//
// Task 9 (rewritten week 5, Task 6): closed-trade history. All the data
// plumbing — the live `DisclosureQueue` subscription, the slot poll, the
// commitment-hash store, the revealed-`Disclosure` lookup, and the
// queue+revealed merge — lives in `useHistoryRows.ts`; this file is render
// only. See that file's header for the full two-source lifecycle
// (`Position.closed` is no longer a source — week-5 Task 1's queue-first
// model retired it).
import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { AppPage } from '@/components/app-page'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row as UiRow } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Address } from '@/src/ui/Address'
import { EmptyState } from '@/src/ui/EmptyState'
import { Skeleton } from '@/src/ui/Skeleton'
import { formatUsd2 } from '@/src/lib/status'
import { useTradeSession } from '../trade/useTradeSession'
import { useHistoryRows } from './useHistoryRows'

function fmtSol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

export function HistoryScreen() {
  const { owner, conn, loading, error: sessionError } = useTradeSession()
  const { rows, dq, revealedError, refreshing, onRefresh } = useHistoryRows(owner, conn)
  const [explainerOpen, setExplainerOpen] = useState(false)

  const { colors, space } = useTheme()
  const heading = useTextStyle('title')
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')

  return (
    <AppPage>
      <ScrollView
        contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Text style={[heading, { color: colors.textPrimary }]}>History</Text>

        <Pressable onPress={() => setExplainerOpen((v) => !v)}>
          <Text style={[caption, { color: colors.textSecondary }]}>
            {explainerOpen ? '▾' : '▸'} Why do trades become public?
          </Text>
          {explainerOpen ? (
            <Text style={[caption, { color: colors.textTertiary, marginTop: 4 }]}>
              Your trades become public only after the delay — without your address.
            </Text>
          ) : null}
        </Pressable>

        {sessionError || dq.error || revealedError ? (
          <Text selectable style={{ color: colors.short }}>
            {sessionError ?? dq.error ?? revealedError}
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
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={[body, { color: colors.textPrimary, fontWeight: '600' }]}>
                    {r.side} {fmtSol(r.size)} SOL
                  </Text>
                  <Badge tone={r.tone}>{r.statusText}</Badge>
                </View>
                <UiRow label="Entry → Exit" value={`$${formatUsd2(r.entry)} → $${formatUsd2(r.exit)}`} mono />
                <UiRow
                  label="PnL"
                  value={`${r.pnl >= 0n ? '+' : ''}$${formatUsd2(r.pnl)}`}
                  tone={r.pnl >= 0n ? 'success' : 'danger'}
                />
                {r.explorerPubkey ? <Address pubkey={r.explorerPubkey} explorer /> : null}
              </Card>
            ))}
          </View>
        )}
      </ScrollView>
    </AppPage>
  )
}
