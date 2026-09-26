// Check 10: does `onAccountChange` over the token-authenticated TEE WS
// endpoint fire when running from React Native / Hermes?
//
// Trigger a change from outside the app while this is listening, e.g.:
//   tap "Run Check 8 (increment)" — it increments this same wallet's counter
// (Check 8 must be onboarded first). Expect the callback to
// fire within 60 s (LISTEN_TIMEOUT_MS); latency in ms is shown once it does.
import { useEffect, useRef, useState } from 'react'
import { Button, Text, View } from 'react-native'
import { Connection, PublicKey } from '@solana/web3.js'
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { pickSignature, toPublicKey } from './mwa'
import { TEE_RPC } from '../lib/solana'
import { ensureAuthorized } from '../lib/mwa/session'

const PROGRAM_ID = new PublicKey('2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7')
const TEE_WS = TEE_RPC.replace(/^https/, 'wss')
const LISTEN_TIMEOUT_MS = 60_000

export function Check10() {
  const { account, connect, identity, store, signMessages } = useMobileWallet()
  const [out, setOut] = useState(
    'Tap Run, then within 60 s tap "Run Check 8 (increment)" above — it mutates this wallet’s counter (Onboard first).',
  )
  const [busy, setBusy] = useState(false)
  const connRef = useRef<Connection | null>(null)
  const subIdRef = useRef<number | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cleanup() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (connRef.current && subIdRef.current !== null) {
      connRef.current.removeAccountChangeListener(subIdRef.current).catch(() => {})
    }
    connRef.current = null
    subIdRef.current = null
  }

  useEffect(() => cleanup, [])

  async function run() {
    cleanup()
    setBusy(true)
    setOut('connecting…')
    try {
      // Week 5, Task 6, fix round 1: routed through `mwa/session.ts`'s `ensureAuthorized` — see `mwa/session.ts`'s file header.
      const wallet = account ?? (await ensureAuthorized(identity, connect, store))
      const owner = toPublicKey(wallet.address)
      const auth = await getAuthToken(TEE_RPC, owner, async (m) => pickSignature(m, await signMessages(m), owner))
      const tee = new Connection(`${TEE_RPC}?token=${auth.token}`, {
        wsEndpoint: `${TEE_WS}?token=${auth.token}`,
        commitment: 'confirmed',
      })
      connRef.current = tee

      const [counter] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('counter'), owner.toBytes()],
        PROGRAM_ID,
      )

      const t0 = Date.now()
      setOut(`subscribed to ${counter.toBase58()}, waiting for a change…`)
      const subId = tee.onAccountChange(counter, (info) => {
        setOut(`CHECK 10 PASS update after ${Date.now() - t0}ms, ${info.data.length} bytes`)
        cleanup()
        setBusy(false)
      })
      subIdRef.current = subId

      timeoutRef.current = setTimeout(() => {
        setOut(`CHECK 10 FAIL no update within ${LISTEN_TIMEOUT_MS}ms — consider a 1s poll fallback (spec §5.5)`)
        cleanup()
        setBusy(false)
      }, LISTEN_TIMEOUT_MS)
    } catch (e) {
      setOut('CHECK 10 FAIL ' + String(e))
      cleanup()
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontWeight: '600' }}>Check 10: WS accountSubscribe with token</Text>
      <Button title="Run Check 10" onPress={() => void run()} disabled={busy} />
      <Text selectable>{out}</Text>
    </View>
  )
}
