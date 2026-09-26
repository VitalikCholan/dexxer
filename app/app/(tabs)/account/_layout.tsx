import { WalletUiDropdown } from '@/components/solana/wallet-ui-dropdown'
import { Stack } from 'expo-router'

export default function Layout() {
  return (
    <Stack screenOptions={{ headerTitle: 'Account', headerRight: () => <WalletUiDropdown /> }}>
      <Stack.Screen name="index" />
      {/* Week 6: kept as a devnet dev tool (self-funded L1 legs need ≥0.05 SOL), reached from Settings → Developer. */}
      <Stack.Screen name="airdrop" options={{ headerTitle: 'Airdrop (devnet)', headerRight: () => null }} />
    </Stack>
  )
}
