// app/src/features/receipt/ReceiptSection.tsx
//
// Task 9: exit receipt. Public trustless-exit proof, spec §2.4.2 — `UserAccount`
// itself never lands on L1 as-is (CLAUDE.md privacy rule), so the only way to
// prove "my balance is accounted for" from the outside is: recompute this
// account's `leaf` from the private fields read over the owner's own TEE
// session, and check whether the current public `BalancesRoot` (committed
// with `Pool` every 5 min) already contains that exact leaf.
//
// Embedded in the Account tab (`app/components/account/account-feature.tsx`)
// rather than a file directly under `app/app/(tabs)/account/*`: that
// directory only holds route stubs (`index.tsx` renders `<AccountFeature/>`
// as the entire screen, already wrapped in its own `AppPage`+`ScrollView`);
// the actual account UI content lives in `components/account/account-feature.tsx`,
// so that's where a new section has to slot in to share the existing scroll
// container instead of fighting it for `flex: 1`. Deviates from the week-3
// plan's literal file glob for that reason — noted in the task-9 report.
import { Text, View } from 'react-native'
import { PublicKey } from '@solana/web3.js'
import { AppText } from '@/components/app-text'
import { AppView } from '@/components/app-view'
import {
  decodeBalancesRoot,
  leafHex,
  readUserAccountExitSalt,
  readUserAccountFreeMargin,
  type DecodedBalancesRoot,
} from '@/src/lib/program'
import { pdas } from '@/src/lib/pdas'
import { baseConn } from '@/src/lib/solana'
import { useLiveAccount, type LiveAccount } from '@/src/lib/live'
import { useTradeSession } from '../trade/useTradeSession'

interface UserForReceipt {
  freeMargin: bigint
  exitSalt: Uint8Array
}

function decodeUserForReceipt(data: Buffer): UserForReceipt {
  return { freeMargin: readUserAccountFreeMargin(data), exitSalt: readUserAccountExitSalt(data) }
}

function fmtUsd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(4)
}

/** Stable PDA (no seeds beyond the constant) — computed once at module load, not per render. */
const BALANCES_ROOT_PDA = pdas.balancesRoot()

export function ReceiptSection() {
  const { owner, conn, accounts, loading, error } = useTradeSession()
  const user = useLiveAccount(conn, accounts?.userAccount ?? null, decodeUserForReceipt)
  const root = useLiveAccount(baseConn, BALANCES_ROOT_PDA, decodeBalancesRoot)

  // No wallet connected: the rest of the Account tab already shows a
  // "Connect your wallet" prompt — stay silent rather than duplicate it.
  if (!owner) return null

  return (
    <AppView style={{ marginTop: 16, gap: 8, width: '100%' }}>
      <AppText type="defaultSemiBold">Exit receipt</AppText>

      {error || user.error || root.error ? (
        <Text selectable style={{ color: '#ef4444' }}>
          {error ?? user.error ?? root.error}
        </Text>
      ) : loading ? (
        <AppText style={{ opacity: 0.6 }}>Loading session…</AppText>
      ) : !conn || !accounts ? (
        <AppText style={{ opacity: 0.6 }}>Finish onboarding first (Onboard tab) to see your exit receipt.</AppText>
      ) : (
        <ReceiptBody owner={owner} user={user.value} root={root} />
      )}
    </AppView>
  )
}

function ReceiptBody({
  owner,
  user,
  root,
}: {
  owner: PublicKey
  user: UserForReceipt | null
  root: LiveAccount<DecodedBalancesRoot>
}) {
  let status: string
  if (root.missing) {
    status = 'BalancesRoot not initialized yet on this deployment.'
  } else if (!root.value || !user) {
    status = 'Loading…'
  } else {
    const computed = leafHex(owner, user.freeMargin, user.exitSalt, root.value.rootSlot)
    const included = root.value.leaves.some((l) => Buffer.from(l).toString('hex') === computed)
    status = included
      ? `Attested by the public root at slot ${root.value.rootSlot.toString()} ✓`
      : 'Not yet included in the public root (next commit ≤5 min).'
  }

  return (
    <View style={{ gap: 4, width: '100%' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <AppText style={{ opacity: 0.7 }}>Free margin</AppText>
        <AppText style={{ fontWeight: '600' }}>{user ? `$${fmtUsd(user.freeMargin)}` : '—'}</AppText>
      </View>
      <AppText style={{ opacity: 0.7 }}>{status}</AppText>
    </View>
  )
}
