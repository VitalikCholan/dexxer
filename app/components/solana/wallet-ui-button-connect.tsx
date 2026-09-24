import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { BaseButton } from '@/components/solana/base-button'
import React, { useState } from 'react'
import { showError } from '@/utils/show-error'
import { ensureAuthorized } from '@/src/lib/mwaAuth'

export function WalletUiButtonConnect({ label = 'Connect' }: { label?: string }) {
  const { connect, identity, store } = useMobileWallet()
  const [isConnecting, setIsConnecting] = useState(false)

  // The wallet can decline or fail the authorization request. Catch it here so it
  // never surfaces as an unhandled rejection, and let the user know what happened.
  //
  // Week 5, Task 6, fix round 1: routed through `mwaAuth.ensureAuthorized` —
  // this is a real connect entry point (Account tab's dropdown/Settings'
  // "Connect" fallback), and the raw `connect()` it used to call blindly
  // replays a stored `auth_token` regardless of app identity (see
  // `mwaAuth.ts`'s file header). Idempotent when the stored hash already
  // matches: no extra deauthorize/reauthorize round-trip, just `connect()`
  // as before.
  async function handleConnect() {
    if (isConnecting) {
      return
    }
    setIsConnecting(true)
    try {
      await ensureAuthorized(identity, connect, store)
    } catch (error) {
      showError('Could not connect wallet', error)
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <BaseButton
      disabled={isConnecting}
      label={isConnecting ? 'Connecting...' : label}
      onPress={() => void handleConnect()}
    />
  )
}
