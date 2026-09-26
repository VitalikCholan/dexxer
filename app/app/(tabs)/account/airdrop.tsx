import { useRouter } from 'expo-router'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { Page } from '@/src/ui/Page'
import { AccountFeatureAirdrop } from '@/components/account/account-feature-airdrop'

export default function Airdrop() {
  const router = useRouter()
  const { account } = useMobileWallet()

  if (!account) {
    return router.replace('/(tabs)/account')
  }

  return (
    <Page>
      <AccountFeatureAirdrop back={() => router.navigate('/(tabs)/account')} />
    </Page>
  )
}
