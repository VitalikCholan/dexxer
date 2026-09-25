// app/src/features/account/AccountScreen.tsx
//
// Task 10: Account screen per design — owner address, session badge,
// Available/Locked balances, Deposit/Withdraw/Exit sheets, Receipt, Settings
// link. Deposit/Withdraw/Exit are owner-signed via MWA (accountTx.ts) —
// unlike Trade/Positions, `dexxer_core`'s user.rs instructions behind these
// actions are `owner: Signer`, not session-signed.
import { useCallback, useMemo, useState } from 'react'
import { router } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import Clipboard from '@react-native-clipboard/clipboard'
import { AppPage } from '@/components/app-page'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Button } from '@/src/ui/Button'
import { Address } from '@/src/ui/Address'
import { Skeleton } from '@/src/ui/Skeleton'
import { showToast } from '@/src/ui/Toast'
import { useTeeConnection } from '@/src/lib/er'
import { useMwaSigning } from '@/src/lib/mwaAuth'
import { useLiveAccount } from '@/src/lib/live'
import { decodeDisclosureQueue, decodePosition, decodeUserAccount } from '@/src/lib/codecs'
import { describeTxError } from '@/src/lib/errors'
import { formatSessionLeft } from '@/src/lib/status'
import { pdas } from '@/src/lib/pdas'
import { useTradeSession } from '../trade/useTradeSession'
import { useOnboardingGate } from '../onboard/useOnboardingGate'
import { SetupAccountCard } from '../onboard/SetupAccountCard'
import { ReceiptSection } from '../receipt/ReceiptSection'
import { DepositSheet } from './DepositSheet'
import { WithdrawSheet } from './WithdrawSheet'
import { ExitSheet, type ExitChecklist } from './ExitSheet'
import { buildAccountPdas, depositTx, exitTx, withdrawTx } from './accountTx'

function usd(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2)
}

type OpenSheet = 'deposit' | 'withdraw' | 'exit' | null

export function AccountScreen() {
  const { colors, space } = useTheme()
  const heading = useTextStyle('heading')

  const { account } = useMobileWallet()
  // Retry-wrapped `signTransactions` — a wallet's `reauthorize` rejection
  // (Phantom `-1`) self-heals with one fresh `authorize` prompt instead of
  // surfacing as `-1 authorization request failed` (`mwaAuth.ts`'s "Phantom
  // reauthorize bug" section).
  const { signTransactions } = useMwaSigning()
  const { getConnection } = useTeeConnection()
  const { owner, conn, accounts, loading, error } = useTradeSession()
  const gate = useOnboardingGate()
  const mwa = useMemo(() => ({ signTransactions, getConnection }), [signTransactions, getConnection])

  const dqPubkey = owner ? pdas.disclosureQueue(owner) : null
  const user = useLiveAccount(conn, accounts?.userAccount ?? null, decodeUserAccount)
  const position = useLiveAccount(conn, accounts?.position ?? null, decodePosition)
  const dq = useLiveAccount(conn, dqPubkey, decodeDisclosureQueue)

  const [sheet, setSheet] = useState<OpenSheet>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      showToast({ tone: 'success', text: `${label} confirmed` })
      setSheet(null)
    } catch (e) {
      console.error(`[dexxer] ${label} failed:`, e)
      showToast({ tone: 'danger', text: describeTxError(e) })
    } finally {
      setBusy(false)
    }
  }, [])

  const handleDeposit = useCallback(
    (amountUsd: number) => {
      if (!owner) return Promise.resolve()
      return run('Deposit', async () => depositTx(await buildAccountPdas(owner), mwa, amountUsd))
    },
    [owner, run, mwa],
  )
  const handleWithdraw = useCallback(
    (amountUsd: number) => {
      if (!owner) return Promise.resolve()
      return run('Withdraw', async () => withdrawTx(await buildAccountPdas(owner), mwa, amountUsd))
    },
    [owner, run, mwa],
  )
  const handleExit = useCallback(() => {
    if (!owner || !accounts || !dqPubkey) return Promise.resolve()
    return run('Exit', async () => exitTx(await buildAccountPdas(owner), mwa, accounts.position, dqPubkey))
  }, [owner, accounts, dqPubkey, run, mwa])

  if (!account) {
    return (
      <AppPage>
        <Text style={[heading, { color: colors.textPrimary }]}>Connect your wallet to view your account.</Text>
      </AppPage>
    )
  }

  // Approximate, re-evaluated on every push/re-render — same justified
  // impure-during-render read as TradeScreen.tsx's identical line.
  // eslint-disable-next-line react-hooks/purity
  const now = Math.floor(Date.now() / 1000)
  const expirySec = user.value ? Number(user.value.sessionExpiry) : 0
  const sessionActive = expirySec > now
  const sessionLabel = formatSessionLeft(expirySec, now)

  const checklist: ExitChecklist = {
    noOpenPosition: position.value === null || position.value.state === 'Empty',
    balanceWithdrawn: user.value === null || (user.value.freeMargin === 0n && user.value.lockedMargin === 0n),
  }
  // Informational only (week-5 Task 2 retired the `QueueNotEmpty` gate) —
  // how many still-queued trades will be revealed on schedule after exit.
  const pendingDisclosures = dq.value?.len ?? 0

  return (
    <AppPage>
      <ScrollView contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}>
        <View style={{ gap: space.xs }}>
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            <Address pubkey={owner!.toBase58()} explorer />
            <Button variant="ghost" onPress={() => Clipboard.setString(owner!.toBase58())}>
              Copy
            </Button>
          </View>
          <Badge tone={sessionActive ? 'success' : 'danger'}>{sessionLabel}</Badge>
        </View>

        {gate.status === 'needs_setup' ? null : error || user.error || position.error || dq.error ? (
          <Text style={{ color: colors.short }}>{error ?? user.error ?? position.error ?? dq.error}</Text>
        ) : null}

        {gate.status === 'needs_setup' ? (
          <SetupAccountCard />
        ) : loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Card title="Balances">
              <Row label="Available" value={user.value ? `${usd(user.value.freeMargin)} dUSDC` : '—'} mono />
              <Row label="Locked" value={user.value ? `${usd(user.value.lockedMargin)} dUSDC` : '—'} mono />
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button variant="primary" onPress={() => setSheet('deposit')}>
                    Deposit
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button variant="secondary" onPress={() => setSheet('withdraw')}>
                    Withdraw
                  </Button>
                </View>
              </View>
            </Card>

            <ReceiptSection />

            <Card title="Exit">
              <Text style={{ color: colors.textSecondary }}>Return your private accounts to L1, fields erased.</Text>
              <Button variant="destructive" onPress={() => setSheet('exit')}>
                Exit private account
              </Button>
            </Card>
          </>
        )}

        <Button variant="ghost" onPress={() => router.push('/settings')}>
          Settings
        </Button>

        <DepositSheet open={sheet === 'deposit'} onClose={() => setSheet(null)} busy={busy} onSubmit={handleDeposit} />
        <WithdrawSheet
          open={sheet === 'withdraw'}
          onClose={() => setSheet(null)}
          availableUsd={user.value ? usd(user.value.freeMargin) : '0.00'}
          busy={busy}
          onSubmit={handleWithdraw}
        />
        <ExitSheet
          open={sheet === 'exit'}
          onClose={() => setSheet(null)}
          checklist={checklist}
          pendingDisclosures={pendingDisclosures}
          busy={busy}
          onConfirm={handleExit}
        />
      </ScrollView>
    </AppPage>
  )
}
