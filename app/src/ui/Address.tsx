// app/src/ui/Address.tsx
import { Linking, Pressable, Text } from 'react-native'
import { useTheme } from '@/src/theme'
import { linkPressStyle, useTextStyle } from './styles'

export interface AddressProps {
  pubkey: string
  explorer?: boolean
}

function truncate(pubkey: string): string {
  if (pubkey.length <= 10) return pubkey
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`
}

export function Address({ pubkey, explorer }: AddressProps) {
  const { colors } = useTheme()
  const textStyle = useTextStyle('body', { mono: true })

  const label = <Text style={[textStyle, { color: colors.textPrimary }]}>{truncate(pubkey)}</Text>

  if (!explorer) return label

  return (
    <Pressable
      accessibilityRole="link"
      style={linkPressStyle}
      onPress={() => void Linking.openURL(`https://explorer.solana.com/address/${pubkey}?cluster=devnet`)}
    >
      {label}
    </Pressable>
  )
}
