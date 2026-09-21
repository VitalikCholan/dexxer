// app/src/features/trade/TradeScreen.tsx
//
// Task 8: side/size/margin form, Open button, Close button when a position
// is open. The entire point of the demo: Open/Close are signed by the
// SESSION key loaded from `expo-secure-store` (`useTradeSession`) and sent
// straight to the TEE connection — no MWA prompt, unlike every owner-signed
// step in onboarding.
//
// Limit price is auto-set to index ± 1%, side-aware
// (`programs/dexxer_core/src/instructions/trade.rs`'s `open_position`:
// `Side::Long => require(price <= limit_price)`, `Side::Short => require(price
// >= limit_price)` — so Long needs a limit at/above mark, Short at/below),
// read fresh right before building the tx rather than off a possibly-stale
// polled value.
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { AppPage } from '@/components/app-page'
import {
  closePosition,
  describeTxError,
  openPosition,
  readMarket,
  readPosition,
  type DecodedPosition,
} from '@/src/lib/program'
import { useTradeSession } from './useTradeSession'

type Side = 'long' | 'short'

function fmtUsd(microUsd: number): string {
  return (microUsd / 1_000_000).toFixed(2)
}

export function TradeScreen() {
  const { owner, session, conn, accounts, loading, error: sessionError } = useTradeSession()

  const [side, setSide] = useState<Side>('long')
  const [sizeSol, setSizeSol] = useState('0.1')
  const [marginUsd, setMarginUsd] = useState('20')
  const [mark, setMark] = useState<bigint | null>(null)
  const [position, setPosition] = useState<DecodedPosition | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSig, setLastSig] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!conn || !accounts) return
    try {
      const [pos, mkt] = await Promise.all([readPosition(conn, accounts.position), readMarket(conn, accounts.market)])
      setPosition(pos)
      setMark(mkt?.mark ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [conn, accounts])

  useEffect(() => {
    // `refresh` only sets state from its own async continuation (after
    // awaiting the account reads) — a legitimate "poll an external system,
    // setState from the callback" effect, not a synchronous setState.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const hasOpenPosition = position?.state === 'Open'

  const handleOpen = useCallback(async () => {
    if (!conn || !session || !accounts) return
    setBusy(true)
    setError(null)
    try {
      const mkt = await readMarket(conn, accounts.market)
      if (!mkt || mkt.mark === 0n) throw new Error('Market has no mark price yet')
      const markUsd = Number(mkt.mark) / 1_000_000
      const limitUsd = side === 'long' ? markUsd * 1.01 : markUsd * 0.99
      const sig = await openPosition(conn, session, accounts, side, Number(sizeSol), Number(marginUsd), limitUsd)
      setLastSig(sig)
      await refresh()
    } catch (e) {
      setError(describeTxError(e))
    } finally {
      setBusy(false)
    }
  }, [conn, session, accounts, side, sizeSol, marginUsd, refresh])

  const handleClose = useCallback(async () => {
    if (!conn || !session || !accounts) return
    setBusy(true)
    setError(null)
    try {
      const sig = await closePosition(conn, session, accounts)
      setLastSig(sig)
      await refresh()
    } catch (e) {
      setError(describeTxError(e))
    } finally {
      setBusy(false)
    }
  }, [conn, session, accounts, refresh])

  const markUsd = mark !== null ? Number(mark) / 1_000_000 : null
  const previewLimitUsd = markUsd !== null ? (side === 'long' ? markUsd * 1.01 : markUsd * 0.99) : null

  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: 16, paddingVertical: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700' }}>Trade — SOL-PERP</Text>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Owner</Text>
          <Text selectable>{owner ? owner.toBase58() : 'not connected (connect on Onboard tab)'}</Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Session key (signs below, no wallet prompt)</Text>
          <Text selectable>
            {session ? session.publicKey.toBase58() : loading ? 'loading…' : 'not set — finish onboarding first'}
          </Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: '600' }}>Mark</Text>
          <Text>{markUsd !== null ? `$${markUsd.toFixed(4)}` : '—'}</Text>
        </View>

        {sessionError || error ? (
          <Text selectable style={{ color: '#ef4444' }}>
            {sessionError ?? error}
          </Text>
        ) : null}

        {hasOpenPosition ? (
          <View style={{ gap: 8 }}>
            <Text style={{ fontWeight: '600' }}>Open position</Text>
            <Text>
              {position!.side} {(Number(position!.size) / 1_000_000_000).toFixed(4)} SOL @ $
              {fmtUsd(Number(position!.entry))}
            </Text>
            <Pressable
              onPress={() => void handleClose()}
              disabled={busy || !session}
              style={{
                backgroundColor: busy ? '#9993' : '#ef4444',
                borderRadius: 8,
                padding: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: 'white', fontWeight: '700' }}>{busy ? 'Working…' : 'Close'}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['long', 'short'] as Side[]).map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setSide(s)}
                  style={{
                    flex: 1,
                    borderRadius: 8,
                    padding: 10,
                    alignItems: 'center',
                    backgroundColor: side === s ? (s === 'long' ? '#22c55e' : '#ef4444') : '#3333',
                  }}
                >
                  <Text style={{ color: side === s ? 'white' : undefined, fontWeight: '700' }}>
                    {s === 'long' ? 'Long' : 'Short'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={{ gap: 4 }}>
              <Text style={{ fontWeight: '600' }}>Size (SOL)</Text>
              <TextInput
                value={sizeSol}
                onChangeText={setSizeSol}
                keyboardType="decimal-pad"
                style={{ borderWidth: 1, borderColor: '#3335', borderRadius: 8, padding: 10 }}
              />
            </View>

            <View style={{ gap: 4 }}>
              <Text style={{ fontWeight: '600' }}>Margin (dUSDC)</Text>
              <TextInput
                value={marginUsd}
                onChangeText={setMarginUsd}
                keyboardType="decimal-pad"
                style={{ borderWidth: 1, borderColor: '#3335', borderRadius: 8, padding: 10 }}
              />
            </View>

            <Text style={{ opacity: 0.7, fontSize: 12 }}>
              Limit auto-set to mark {side === 'long' ? '× 1.01' : '× 0.99'}
              {previewLimitUsd !== null ? ` (~$${previewLimitUsd.toFixed(4)})` : ''}
            </Text>

            <Pressable
              onPress={() => void handleOpen()}
              disabled={busy || !session || !conn}
              style={{
                backgroundColor: busy || !session ? '#9993' : '#3b82f6',
                borderRadius: 8,
                padding: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: 'white', fontWeight: '700' }}>{busy ? 'Working…' : 'Open'}</Text>
            </Pressable>
          </View>
        )}

        {lastSig ? (
          <View style={{ gap: 4 }}>
            <Text style={{ fontWeight: '600' }}>Last signature</Text>
            <Text selectable style={{ fontSize: 12 }}>
              {lastSig}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </AppPage>
  )
}
