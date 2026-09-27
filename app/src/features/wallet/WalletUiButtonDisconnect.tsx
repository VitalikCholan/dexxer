import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { Button } from '@/src/ui/Button'
import React, { useState } from 'react'
import { showError } from '@/utils/show-error'
import { disconnect as mwaDisconnect } from '@/src/lib/mwa/session'

export function WalletUiButtonDisconnect({ label = 'Disconnect' }: { label?: string }) {
  const { disconnect, store } = useMobileWallet()
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  // Week 5, Task 6: `mwa/session.ts`'s `disconnect` raw-deauthorizes the session on the
  // wallet's side (`disconnect()` alone never does — see `mwa/session.ts`'s file
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
    <Button variant="secondary" loading={isDisconnecting} onPress={() => void handleDisconnect()}>
      {isDisconnecting ? 'Disconnecting...' : label}
    </Button>
  )
}
