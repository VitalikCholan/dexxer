import { Text, View } from 'react-native'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { ellipsify } from '@/utils/ellipsify'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { WalletUiButtonConnect } from '@/components/solana/wallet-ui-button-connect'
import { WalletUiButtonDisconnect } from '@/components/solana/wallet-ui-button-disconnect'

export function SettingsUiAccount() {
  const { account } = useMobileWallet()
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const body = useTextStyle('body')
  return (
    <View style={{ gap: space.sm }}>
      <Text style={[heading, { color: colors.textPrimary }]}>Account</Text>
      <Text style={[body, { color: colors.textSecondary }]}>
        {account ? `Connected to ${ellipsify(account.address.toString(), 8)}` : 'Connect your wallet.'}
      </Text>
      {account ? <WalletUiButtonDisconnect /> : <WalletUiButtonConnect />}
    </View>
  )
}
