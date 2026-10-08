// app/src/features/feedback/BugReportScreen.tsx
//
// Closed beta: "Report a problem". Reachable from Settings and from the
// Connect screen (a tester who cannot connect a wallet is exactly who needs
// it). The tester picks Bug / Idea and an area, describes it, optionally
// leaves a contact, and decides two things explicitly:
//   * "Include diagnostics" (on by default): build/device info is always sent;
//     this adds the screen they came from, the selected market and the
//     scrubbed event log (lib/diagnostics.ts).
//   * "Attach my wallet address" (off by default): sends the relayer session
//     header, from which the relayer takes the address. Offered only with a
//     live session; without one (the wallet is not on the beta list, or the
//     sign-in expired) a note says the address cannot be attached, instead of
//     an anonymous report going out while the preview promises the address.
// "Show what will be sent" renders the exact JSON body. Positions, balances,
// orders and keys are never part of it.
import { useEffect, useMemo, useState } from 'react'
import { router } from 'expo-router'
import { ScrollView, Switch, Text, View } from 'react-native'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Page } from '@/src/ui/Page'
import { Segment } from '@/src/ui/Segment'
import { Input } from '@/src/ui/Input'
import { Button } from '@/src/ui/Button'
import { showToast } from '@/src/ui/Toast'
import { appInfo } from '@/src/lib/appInfo'
import { recentEvents, record } from '@/src/lib/diagnostics'
import { currentScreen } from '@/src/lib/crashReporter'
import { hasRelayerSession, relayerAuthHeaders } from '@/src/lib/relayerAuth'
import { toPublicKey } from '@/src/lib/mwa/accounts'
import { useSelectedMarket } from '@/src/lib/markets'
import {
  CATEGORY_LABELS,
  FEEDBACK_CATEGORIES,
  MAX_MESSAGE,
  buildReport,
  sendReport,
  validateDraft,
  type FeedbackCategory,
} from '@/src/lib/feedback'

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  const { colors, space } = useTheme()
  const body = useTextStyle('body')
  const caption = useTextStyle('caption')
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[body, { color: colors.textPrimary }]}>{label}</Text>
        <Text style={[caption, { color: colors.textTertiary }]}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ true: colors.accent, false: colors.border }}
        thumbColor={colors.textPrimary}
      />
    </View>
  )
}

export function BugReportScreen() {
  const { colors, space, radius } = useTheme()
  const heading = useTextStyle('heading')
  const micro = useTextStyle('micro')
  const caption = useTextStyle('caption')
  const mono = useTextStyle('caption', { mono: true })
  const { account } = useMobileWallet()
  const { symbol } = useSelectedMarket()

  const [kind, setKind] = useState<'bug' | 'idea'>('bug')
  const [category, setCategory] = useState<FeedbackCategory>('trading')
  const [message, setMessage] = useState('')
  const [contact, setContact] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [attachWallet, setAttachWallet] = useState(false)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  // Whether `owner` has a live relayer session, tagged with the owner it was read for, so a wallet
  // switch never shows the previous wallet's answer.
  const [session, setSession] = useState<{ owner: string; live: boolean } | null>(null)

  const owner = account ? toPublicKey(account.address).toBase58() : null
  useEffect(() => {
    if (!owner) return
    let current = true
    hasRelayerSession(toPublicKey(owner)).then(
      (live) => {
        if (current) setSession({ owner, live })
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [owner])
  const canAttach = owner !== null && session?.owner === owner && session.live

  const screen = currentScreen()
  const problem = validateDraft({ message, contact })
  const body = useMemo(
    () =>
      buildReport(
        { kind, category, message, contact, includeDiagnostics, screen, market: symbol },
        appInfo(),
        includeDiagnostics ? recentEvents() : [],
      ),
    [kind, category, message, contact, includeDiagnostics, screen, symbol],
  )

  async function submit() {
    if (problem || busy) return
    setBusy(true)
    try {
      const attach = attachWallet && canAttach && owner !== null
      const headers = attach ? await relayerAuthHeaders(toPublicKey(owner)) : {}
      if (attach && !headers.authorization) {
        // The sign-in expired while the screen was open: say so rather than send anonymously.
        setSession({ owner, live: false })
        setAttachWallet(false)
        showToast({
          tone: 'warning',
          text: 'Your sign-in expired, so the wallet address cannot be attached. Send again to report without it.',
          log: 'feedback: wallet not attached, no relayer session',
        })
        return
      }
      const id = await sendReport(body, headers)
      record('info', 'feedback', `report sent #${id}`)
      showToast({ tone: 'success', text: `Thanks — report #${id} sent` })
      if (router.canGoBack()) router.back()
    } catch (e) {
      showToast({ tone: 'danger', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <ScrollView
        contentContainerStyle={{ gap: space.lg, paddingVertical: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <Text accessibilityRole="header" style={[heading, { color: colors.textPrimary }]}>
          Report a problem
        </Text>
        <Segment
          value={kind}
          onChange={setKind}
          options={[
            { value: 'bug', label: 'Something is wrong' },
            { value: 'idea', label: 'Idea' },
          ]}
        />
        <View style={{ gap: space.xs }}>
          <Text style={[micro, { color: colors.textSecondary }]}>Area</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {FEEDBACK_CATEGORIES.map((c) => (
              <Segment
                key={c}
                compact
                value={category === c ? c : ''}
                onChange={() => setCategory(c)}
                options={[{ value: c, label: CATEGORY_LABELS[c] }]}
              />
            ))}
          </View>
        </View>
        <Input
          label={kind === 'bug' ? 'What happened? What did you expect?' : 'Your idea'}
          value={message}
          onChangeText={setMessage}
          keyboardType="default"
          autoCapitalize="sentences"
          multiline
          maxLength={MAX_MESSAGE}
          placeholder={kind === 'bug' ? 'Steps, what you saw, what you expected' : 'What would make Dexxer better?'}
          hint={`${message.trim().length}/${MAX_MESSAGE}`}
        />
        <Input
          label="Contact (optional)"
          value={contact}
          onChangeText={setContact}
          keyboardType="default"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Telegram @handle or e-mail"
          hint="Only if you want us to get back to you"
        />
        <ToggleRow
          label="Include diagnostics"
          hint="Screen, selected market and a log of recent app events — no amounts, balances, positions or keys"
          value={includeDiagnostics}
          onChange={setIncludeDiagnostics}
        />
        {canAttach ? (
          <ToggleRow
            label="Attach my wallet address"
            hint="Helps us check your onboarding on-chain. Your positions stay private either way"
            value={attachWallet}
            onChange={setAttachWallet}
          />
        ) : owner !== null ? (
          <Text style={[caption, { color: colors.textTertiary }]}>
            Your wallet address can&apos;t be attached: this wallet has no Dexxer sign-in (it is not on the beta list,
            or the sign-in expired). The report is sent without it.
          </Text>
        ) : null}
        <Text
          accessibilityRole="button"
          onPress={() => setPreview((p) => !p)}
          style={[caption, { color: colors.accentText }]}
        >
          {preview ? 'Hide what will be sent' : 'Show what will be sent'}
        </Text>
        {preview ? (
          <View style={{ padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface }}>
            <Text selectable style={[mono, { color: colors.textSecondary }]}>
              {JSON.stringify(body, null, 2)}
              {attachWallet && canAttach ? '\n\n+ your wallet address (from your relayer sign-in)' : ''}
            </Text>
          </View>
        ) : null}
        {problem && message.length > 0 ? <Text style={[caption, { color: colors.short }]}>{problem}</Text> : null}
        <Button variant="primary" loading={busy} disabled={problem !== null} onPress={() => void submit()}>
          Send report
        </Button>
        <Text style={[caption, { color: colors.textTertiary }]}>
          Reports go to the Dexxer team only. Crash reports are sent automatically on the next launch unless you turn
          them off in Settings.
        </Text>
      </ScrollView>
    </Page>
  )
}
