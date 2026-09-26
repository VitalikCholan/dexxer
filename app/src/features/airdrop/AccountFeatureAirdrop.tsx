import { ActivityIndicator, Text, View } from 'react-native'
import { PublicKey } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Button } from '@/src/ui/Button'
import { useRequestAirdrop } from '@/src/features/airdrop/useRequestAirdrop'

/** Devnet dev tool (Settings -> Developer): 1 SOL to the connected wallet via the public devnet RPC. */
export function AccountFeatureAirdrop({ back }: { back: () => void }) {
  const { account } = useMobileWallet()
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')
  const caption = useTextStyle('caption')
  const amount = 1
  const requestAirdrop = useRequestAirdrop({ address: account?.address as PublicKey })

  return (
    <View style={{ gap: space.md }}>
      <Text style={[heading, { color: colors.textPrimary }]}>Request a 1 SOL airdrop to the connected wallet.</Text>
      {requestAirdrop.isPending ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Button
          variant="primary"
          onPress={() => {
            requestAirdrop
              .mutateAsync(amount)
              .then(() => {
                console.log(`Requested airdrop of ${amount} SOL to ${account?.address}`)
                back()
              })
              .catch((err) => console.log(`Error requesting airdrop: ${err}`, err))
          }}
        >
          Request Airdrop
        </Button>
      )}
      {requestAirdrop.isError ? (
        <Text style={[caption, { color: colors.short }]}>{`${requestAirdrop.error.message}`}</Text>
      ) : null}
    </View>
  )
}
