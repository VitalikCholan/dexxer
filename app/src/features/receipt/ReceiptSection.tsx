// app/src/features/receipt/ReceiptSection.tsx
//
// Task 9: exit receipt. Public trustless-exit proof, spec §2.4.2 — `UserAccount`
// itself never lands on L1 as-is (CLAUDE.md privacy rule), so the only way to
// prove "my balance is accounted for" from the outside is: recompute this
// account's `leaf` from the private fields read over the owner's own TEE
// session, and check whether the current public `BalancesRoot` (committed
// with `Pool` every 5 min) already contains that exact leaf.
//
// Task 10: restyled onto the shared primitives (Card/Row/Badge) — logic
// unchanged, now mounted from `AccountScreen.tsx` instead of the old
// `account-feature.tsx`.
import { Text } from 'react-native'
import { PublicKey } from '@solana/web3.js'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Skeleton } from '@/src/ui/Skeleton'
import {
  decodeBalancesRoot,
  readUserAccountExitSalt,
  readUserAccountFreeMargin,
  type DecodedBalancesRoot,
} from '@/src/lib/codecs'
import { leafHex } from '@/src/lib/hashes'
import { formatDusdc } from '@/src/lib/status'
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

/** Stable PDA (no seeds beyond the constant) — computed once at module load, not per render. */
const BALANCES_ROOT_PDA = pdas.balancesRoot()

export function ReceiptSection() {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const { owner, conn, base, loading, error } = useTradeSession()
  const user = useLiveAccount(conn, base?.userAccount ?? null, decodeUserForReceipt)
  const root = useLiveAccount(baseConn, BALANCES_ROOT_PDA, decodeBalancesRoot)

  if (!owner) return null

  return (
    <Card title="Receipt">
      {error || user.error || root.error ? (
        <Text style={[caption, { color: colors.short }]}>{error ?? user.error ?? root.error}</Text>
      ) : loading || !conn || !base ? (
        <Skeleton lines={2} />
      ) : (
        <ReceiptBody owner={owner} user={user.value} root={root} />
      )}
    </Card>
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
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  let badge: { tone: 'pending' | 'success'; text: string }
  if (root.missing) {
    badge = { tone: 'pending', text: 'BalancesRoot not initialized yet' }
  } else if (!root.value || !user) {
    badge = { tone: 'pending', text: 'Loading…' }
  } else {
    const computed = leafHex(owner, user.freeMargin, user.exitSalt, root.value.rootSlot)
    const included = root.value.leaves.some((l) => Buffer.from(l).toString('hex') === computed)
    badge = included
      ? { tone: 'success', text: `Attested at slot ${root.value.rootSlot.toString()} ✓` }
      : { tone: 'pending', text: 'Not yet included — next commit ≤5 min' }
  }

  return (
    <>
      <Row label="Free margin" value={user ? formatDusdc(user.freeMargin) : '—'} mono />
      <Badge tone={badge.tone}>{badge.text}</Badge>
      <Text style={[caption, { color: colors.textSecondary }]}>
        Proof that the protocol owes you — without revealing how much.
      </Text>
    </>
  )
}
