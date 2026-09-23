import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { BaseButton } from '@/components/solana/base-button'
import React, { useState } from 'react'
import { showError } from '@/utils/show-error'
import { disconnect as mwaDisconnect } from '@/src/lib/mwaAuth'

export function WalletUiButtonDisconnect({ label = 'Disconnect' }: { label?: string }) {
  const { disconnect, store } = useMobileWallet()
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  // Week 5, Task 6: `mwaAuth.disconnect` raw-deauthorizes the session on the
  // wallet's side (`disconnect()` alone never does — see `mwaAuth.ts`'s file
  // header) before clearing local state.
  async function handleDisconnect() {
    if (isDisconnecting) {
      return
    }
    setIsDisconnecting(true)
    try {
      await mwaDisconnect(disconnect, store)
    } catch (error) {
      showError('Could not disconnect wallet', error)
    } finally {
      setIsDisconnecting(false)
    }
  }

  return (
    <BaseButton
      disabled={isDisconnecting}
      label={isDisconnecting ? 'Disconnecting...' : label}
      onPress={() => void handleDisconnect()}
    />
  )
}
