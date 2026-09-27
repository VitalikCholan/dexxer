// app/src/features/onboard/useOnboardingGate.ts
//
// Read-only "where should this device land" check, shared by
// `app/app/(tabs)/index.tsx` (routing) and any screen that needs to offer a
// "Set up private account" action instead of a dead-end error (Account,
// Positions, Trade — see CLAUDE.md-adjacent task notes for the bug this
// closes: a fresh wallet had nowhere to go because `onboard` is `href: null`
// in the tab bar).
//
// Three checks, cheapest first, matching `useOnboarding.ts`'s
// `checkL1Progress` / `batchOnboarding.ts:356`'s delegation check:
//   1. Is a wallet connected at all (`useMobileWallet().account`)?
//   2. Is `UserAccount` delegated to the ER on L1 (`owner.equals(DELEGATION_PROGRAM_ID)`)?
//      Anything short of that — no account, or an undelegated one — means
//      onboarding hasn't finished.
//   3. Does this device hold a session `Keypair` (`session.ts`'s
//      `getSessionKeypair`, no generation, no MWA prompt)?
//
// Deliberately does not check on-chain session expiry (`UserAccount.sessionExpiry`)
// — that's `TradeScreen.tsx`'s `sessionExpired` concern (a *ready* device
// whose authorization lapsed), not a "device has never been set up" concern.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PublicKey } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { toPublicKey } from '@/src/lib/mwa/accounts'
import { baseConn } from '@/src/lib/solana'
import { pdas } from '@/src/lib/pdas'
import { getSessionKeypair } from '@/src/lib/session'

export type OnboardingGateStatus = 'loading' | 'no_wallet' | 'needs_setup' | 'ready'

export interface OnboardingGate {
  status: OnboardingGateStatus
  reason?: string
  refetch: () => void
}

async function checkGate(owner: PublicKey): Promise<{ status: OnboardingGateStatus; reason?: string }> {
  const userAccountInfo = await baseConn.getAccountInfo(pdas.userAccount(owner), 'confirmed')
  const delegated = userAccountInfo !== null && userAccountInfo.owner.equals(DELEGATION_PROGRAM_ID)
  if (!delegated) {
    return { status: 'needs_setup', reason: 'Private account not delegated to the rollup on this device yet' }
  }
  const session = await getSessionKeypair(owner)
  if (!session) {
    return { status: 'needs_setup', reason: 'No session key on this device yet' }
  }
  return { status: 'ready' }
}

export function useOnboardingGate(): OnboardingGate {
  const { account } = useMobileWallet()
  const owner = account ? toPublicKey(account.address) : null

  const query = useQuery({
    queryKey: ['onboarding-gate', owner?.toBase58() ?? null],
    queryFn: () => checkGate(owner!),
    enabled: owner !== null,
    staleTime: 10_000,
  })

  return useMemo((): OnboardingGate => {
    if (!owner) return { status: 'no_wallet', refetch: query.refetch }
    if (query.isLoading || query.data === undefined) return { status: 'loading', refetch: query.refetch }
    return { status: query.data.status, reason: query.data.reason, refetch: query.refetch }
  }, [owner, query.isLoading, query.data, query.refetch])
}
