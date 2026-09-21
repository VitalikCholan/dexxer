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
// computed client-side via `program.ts`'s `computeUpnl`, mirroring
// `programs/dexxer_core/src/math.rs`'s `upnl` exactly (truncation toward
// zero).
import { useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Connection, PublicKey } from '@solana/web3.js'
import { AppPage } from '@/components/app-page'
import {
  computeUpnl,
  decodeMarket,
  decodePosition,
  readUserAccountFreeMargin,
  type DecodedMarket,
  type DecodedPosition,
} from '@/src/lib/program'
import { useTradeSession } from './useTradeSession'

function decodeFreeMargin(data: Buffer): bigint {
  return readUserAccountFreeMargin(data)
}

/**
 * Live account value: `onAccountChange` for fast pushes (best-effort — a
 * failed subscribe attempt is swallowed, never thrown) plus an
 * unconditional 1s poll, per file header. Both write into the same state,
 * whichever lands first/next wins.
 */
function useLiveAccount<T>(conn: Connection | null, pubkey: PublicKey | null, decode: (data: Buffer) => T) {
  const [value, setValue] = useState<T | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Reset stale state from a previous (conn, pubkey) pair before
    // (re-)subscribing — see useTradeSession.ts's identical justification.
    /* eslint-disable react-hooks/set-state-in-effect */
    setValue(null)
    setMissing(false)
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!conn || !pubkey) return
    let cancelled = false
    let subId: number | null = null

    async function refreshOnce() {
      try {
        const info = await conn!.getAccountInfo(pubkey!, 'confirmed')
        if (cancelled) return
        if (info) {
          setValue(decode(info.data))
          setMissing(false)
        } else {
          setValue(null)
          setMissing(true)
        }
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }

    void refreshOnce()
    try {
      subId = conn.onAccountChange(
        pubkey,
        (info) => {
          if (cancelled) return
          setValue(decode(info.data))
          setMissing(false)
          setError(null)
        },
        'confirmed',
      )
    } catch {
      // ws subscribe itself failed synchronously — the poll below still covers it.
    }
    const timer = setInterval(refreshOnce, 1000)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (subId !== null) conn.removeAccountChangeListener(subId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, pubkey?.toBase58()])

  return { value, missing, error }
}

function fmtUsd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(4)
}
function fmtSol(raw: bigint): string {
  return (Number(raw) / 1_000_000_000).toFixed(4)
}

export function PositionScreen() {
  const { owner, session, conn, accounts, loading, error: sessionError } = useTradeSession()

  const position = useLiveAccount<DecodedPosition>(conn, accounts?.position ?? null, decodePosition)
  const market = useLiveAccount<DecodedMarket>(conn, accounts?.market ?? null, decodeMarket)
  const freeMargin = useLiveAccount<bigint>(conn, accounts?.userAccount ?? null, decodeFreeMargin)

  const pos = position.value
  const mark = market.value?.mark ?? null
  const isOpen = pos?.state === 'Open'
  const upnl = isOpen && mark !== null ? computeUpnl(pos.side, pos.size, pos.entry, mark) : null

  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: 16, paddingVertical: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700' }}>Position — SOL-PERP</Text>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Owner</Text>
          <Text selectable>{owner ? owner.toBase58() : 'not connected (connect on Onboard tab)'}</Text>
        </View>

        {sessionError || position.error || market.error || freeMargin.error ? (
          <Text selectable style={{ color: '#ef4444' }}>
            {sessionError ?? position.error ?? market.error ?? freeMargin.error}
          </Text>
        ) : null}

        {loading || !session ? (
          <Text style={{ opacity: 0.6 }}>
            {loading ? 'Loading session…' : 'No session key yet — finish onboarding first'}
          </Text>
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
    </AppPage>
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
