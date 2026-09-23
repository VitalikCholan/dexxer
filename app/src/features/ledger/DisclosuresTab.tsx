// app/src/features/ledger/DisclosuresTab.tsx
//
// Task 10: the public 13F disclosure feed (`useDisclosures()`, Task 9) —
// side/size/entry→exit/PnL/reveal time, no owner. `Disclosure.owner` is
// always `Pubkey::default()` on-chain by design (spec §2.3) — the caption
// makes that explicit rather than leaving a blank/zero address implicit.
import { ScrollView, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Skeleton } from '@/src/ui/Skeleton'
import { EmptyState } from '@/src/ui/EmptyState'
import { useDisclosures } from '@/src/lib/indexer'

function usd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2)
}
function sol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

export function DisclosuresTab() {
  const { colors, space } = useTheme()
  const caption = useTextStyle('caption')
  const disclosures = useDisclosures(50)

  return (
    <ScrollView contentContainerStyle={{ gap: space.md, paddingVertical: space.md }}>
      <Text style={[caption, { color: colors.textTertiary }]}>Trader: hidden by design</Text>
      {disclosures.isLoading ? (
        <Skeleton lines={4} />
      ) : !disclosures.data || disclosures.data.length === 0 ? (
        <EmptyState text="No disclosures yet." />
      ) : (
        disclosures.data.map((d) => (
          <Card key={d.pubkey}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[caption, { color: colors.textPrimary }]}>
                {d.side} {sol(d.size)} SOL
              </Text>
              <Text style={[caption, { color: colors.textTertiary }]}>{new Date(d.ts).toLocaleString()}</Text>
            </View>
            <Row label="Entry → Exit" value={`$${usd(d.entry)} → $${usd(d.exit)}`} mono />
            <Row
              label="PnL"
              value={`${d.pnl >= 0n ? '+' : ''}$${usd(d.pnl)}`}
              tone={d.pnl >= 0n ? 'success' : 'danger'}
            />
          </Card>
        ))
      )}
    </ScrollView>
  )
}
