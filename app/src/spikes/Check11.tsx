// Check 11: does `verifyTeeRpcIntegrity` (TDX quote verification, uses
// @phala/dcap-qvl under the hood) work under Hermes in React Native?
//
// verifyTeeRpcIntegrity resolves with no value on success and throws on
// failure — there is no boolean return. Expected outcome on Hermes: a
// WebAssembly-related error (Hermes has no WebAssembly global), which is
// itself a valid, informative result for spec risk #6 (shim vs. v1 with an
// honest note). The raw error text is shown verbatim either way.
import { useState } from 'react'
import { Button, Text, View } from 'react-native'
import { verifyTeeRpcIntegrity } from '@magicblock-labs/ephemeral-rollups-sdk'
import { TEE_RPC } from '../lib/solana'

export function Check11() {
  const [out, setOut] = useState('Tap Run to attempt TEE RPC integrity (TDX quote) verification under Hermes.')
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setOut('running…')
    const t0 = Date.now()
    try {
      await verifyTeeRpcIntegrity(TEE_RPC)
      setOut(`CHECK 11 PASS in ${Date.now() - t0}ms`)
    } catch (e) {
      setOut(`CHECK 11 FAIL after ${Date.now() - t0}ms — ` + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontWeight: '600' }}>Check 11: verifyTeeRpcIntegrity under Hermes</Text>
      <Button title="Run Check 11" onPress={() => void run()} disabled={busy} />
      <Text selectable>{out}</Text>
    </View>
  )
}
