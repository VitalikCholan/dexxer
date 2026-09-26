// app/src/features/trade/PositionScreen.tsx
//
// Task 8: live position view. `Connection.onAccountChange` over the TEE ws
// (session-token authenticated, same connection `useTradeSession` builds)
// gives fast pushes when they arrive, but task-7's emulator verification
// found the TEE validator's confirmation websocket unreliable
// (`useOnboarding.ts`/`tests/er/lib/env.ts`'s header comments) — so a 1s
// poll runs unconditionally alongside the subscription as the actual
// freshness guarantee (≤2s bar), not merely a fallback that only kicks in
// once the ws is observed to have failed. `Market.mark` gets the same
// treatment for the live price. uPnL/liq are read straight off `Position`
// (liq_price is already computed on-chain by open/increase); uPnL is
// computed client-side via `trade.ts`'s `computeUpnl`, mirroring
// `programs/dexxer_core/src/math.rs`'s `upnl` exactly (truncation toward
// zero).
//
// Task 9: `useLiveAccount` itself now lives in `src/lib/live.ts` (unchanged
// implementation), so History/Receipt can reuse it without importing this
// screen component.
import { router } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { Page } from '@/src/ui/Page'
import { Button } from '@/src/ui/Button'
import {
  decodeMarket,
  decodePosition,
  readUserAccountFreeMargin,
  type DecodedMarket,
  type DecodedPosition,
} from '@/src/lib/codecs'
import { computeUpnl } from '@/src/lib/trade'
import { useLiveAccount } from '@/src/lib/live'
import { useTradeSession } from './useTradeSession'
import { useOnboardingGate } from '../onboard/useOnboardingGate'

function decodeFreeMargin(data: Buffer): bigint {
  return readUserAccountFreeMargin(data)
}

function fmtUsd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(4)
}
function fmtSol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

export function PositionScreen() {
  const { owner, conn, accounts, loading, error: sessionError } = useTradeSession()
  const gate = useOnboardingGate()

  const position = useLiveAccount<DecodedPosition>(conn, accounts?.position ?? null, decodePosition)
  const market = useLiveAccount<DecodedMarket>(conn, accounts?.market ?? null, decodeMarket)
  const freeMargin = useLiveAccount<bigint>(conn, accounts?.userAccount ?? null, decodeFreeMargin)

  const pos = position.value
  const mark = market.value?.mark ?? null
  const isOpen = pos?.state === 'Open'
  const upnl = isOpen && mark !== null ? computeUpnl(pos.side, pos.size, pos.entry, mark) : null

  return (
    <Page>
      <ScrollView contentContainerStyle={{ gap: 16, paddingVertical: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700' }}>Position — SOL-PERP</Text>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Owner</Text>
          <Text selectable>{owner ? owner.toBase58() : 'not connected'}</Text>
        </View>

        {(gate.status === 'needs_setup' ? null : sessionError) || position.error || market.error || freeMargin.error ? (
          <Text selectable style={{ color: '#ef4444' }}>
            {(gate.status === 'needs_setup' ? null : sessionError) ??
              position.error ??
              market.error ??
              freeMargin.error}
          </Text>
        ) : null}

        {loading ? (
          <Text style={{ opacity: 0.6 }}>Loading session…</Text>
        ) : gate.status === 'needs_setup' ? (
          <View style={{ gap: 8 }}>
            <Text style={{ opacity: 0.6 }}>Your private account isn&apos;t set up on this device yet.</Text>
            <Button variant="primary" onPress={() => router.push('/onboard')}>
              Set up private account
            </Button>
          </View>
        ) : !isOpen ? (
          <Text style={{ opacity: 0.6 }}>
            {position.missing ? 'No Position account yet (open one on the Trade tab).' : 'No open position.'}
          </Text>
        ) : (
          <View style={{ gap: 8 }}>
            <Row label="State" value={pos.state} />
            <Row label="Side" value={pos.side} />
            <Row label="Size" value={`${fmtSol(pos.size)} SOL`} />
            <Row label="Entry" value={`$${fmtUsd(pos.entry)}`} />
            <Row label="Mark" value={mark !== null ? `$${fmtUsd(mark)}` : '—'} />
            <Row label="Liq. price" value={`$${fmtUsd(pos.liqPrice)}`} />
            <Row
              label="uPnL"
              value={upnl !== null ? `${upnl >= 0n ? '+' : ''}$${fmtUsd(upnl)}` : '—'}
              valueColor={upnl === null ? undefined : upnl >= 0n ? '#22c55e' : '#ef4444'}
            />
            <Row label="Margin" value={`$${fmtUsd(pos.margin)}`} />
          </View>
        )}

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Free margin</Text>
          <Text>{freeMargin.value !== null ? `$${fmtUsd(freeMargin.value)}` : '—'}</Text>
        </View>
      </ScrollView>
    </Page>
  )
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ opacity: 0.7 }}>{label}</Text>
      <Text style={{ fontWeight: '600', color: valueColor }}>{value}</Text>
    </View>
  )
}
