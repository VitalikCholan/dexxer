import React, { Fragment } from 'react'
import { Linking, StyleSheet, Text } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { ellipsify } from '@/utils/ellipsify'
import { UiIconSymbol } from '@/src/ui/UiIconSymbol'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import * as Dropdown from '@rn-primitives/dropdown-menu'
import { WalletUiButtonConnect } from './WalletUiButtonConnect'
import { showError } from '@/utils/show-error'
import { disconnect as mwaDisconnect } from '@/src/lib/mwa/session'

// Week 6: one network profile — explorer links are devnet's (the template's cluster switcher is gone).
function useDropdownItems() {
  const { account, disconnect, store } = useMobileWallet()
  if (!account) {
    return []
  }
  // Dropdown.Item takes a sync handler, so every async action is caught here
  // instead of floating away as an unhandled rejection.
  return [
    {
      label: 'Copy Address',
      onPress: () => Clipboard.setString(account.address.toString()),
    },
    {
      label: 'View in Explorer',
      onPress: () => {
        Linking.openURL(`https://explorer.solana.com/address/${account.address.toString()}?cluster=devnet`).catch(
          (error: unknown) => showError('Could not open explorer', error),
        )
      },
    },
    {
      label: 'Disconnect',
      // Week 5, Task 6, fix round 1: this is a real entry point (Account tab
      // header) that called the raw hook `disconnect()` directly, bypassing
      // `mwa/session.ts`'s raw-deauthorize-on-the-wallet's-side step — see
      // `WalletUiButtonDisconnect.tsx` for the same fix and `mwa/session.ts`'s
      // file header for why the raw hook alone never reaches the wallet.
      onPress: () => {
        mwaDisconnect(disconnect, store).catch((error: unknown) => showError('Could not disconnect wallet', error))
      },
    },
  ]
}

export function WalletUiDropdown() {
  const { account } = useMobileWallet()
  const { colors, radius, space } = useTheme()
  const label = useTextStyle('bodyStrong')
  const backgroundColor = colors.surfaceAlt
  const borderColor = colors.border
  const textColor = colors.textPrimary

  const items = useDropdownItems()

  if (!account || !items.length) {
    return <WalletUiButtonConnect />
  }

  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        style={[
          styles.trigger,
          {
            backgroundColor,
            borderColor,
            borderRadius: radius.pill,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
          },
        ]}
      >
        <UiIconSymbol name="wallet.pass.fill" color={textColor} />
        <Text style={[label, { color: textColor }]}>{ellipsify(account.address.toString())}</Text>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Overlay style={StyleSheet.absoluteFill}>
          <Dropdown.Content
            style={{ ...styles.list, backgroundColor, borderColor, borderRadius: radius.lg, marginTop: space.sm }}
          >
            {items.map((item, index) => (
              <Fragment key={item.label}>
                <Dropdown.Item onPress={item.onPress} style={[styles.item, { borderColor }]}>
                  <Text style={[label, { color: textColor }]}>{item.label}</Text>
                </Dropdown.Item>
                {index < items.length - 1 && <Dropdown.Separator style={{ backgroundColor: borderColor, height: 1 }} />}
              </Fragment>
            ))}
          </Dropdown.Content>
        </Dropdown.Overlay>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

// Token-derived radii/spacing are applied inline where they are used; these are the structural bits.
export const styles = StyleSheet.create({
  trigger: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  list: {
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 8,
  },
  item: {
    padding: 12,
    flexWrap: 'nowrap',
  },
})
