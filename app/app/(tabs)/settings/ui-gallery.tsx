// app/app/(tabs)/settings/ui-gallery.tsx
//
// Dev-only visual check for every app/src/ui/* primitive, in each documented
// variant/tone — task-8. Reachable from Account → Settings → Developer.
// Not part of any product flow, so it renders nothing outside __DEV__.
import { useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { Button } from '@/src/ui/Button'
import { Input } from '@/src/ui/Input'
import { Segment } from '@/src/ui/Segment'
import { LeverageSlider } from '@/src/ui/LeverageSlider'
import { Card } from '@/src/ui/Card'
import { Row } from '@/src/ui/Row'
import { Badge } from '@/src/ui/Badge'
import { Sheet } from '@/src/ui/Sheet'
import { showToast } from '@/src/ui/Toast'
import { Skeleton } from '@/src/ui/Skeleton'
import { EmptyState } from '@/src/ui/EmptyState'
import { Address } from '@/src/ui/Address'
import type { Tone } from '@/src/ui/styles'

const TONES: Tone[] = ['neutral', 'pending', 'success', 'warning', 'danger']
const SAMPLE_ADDRESS = '7nYcU7A1qF3XkJv6ZbP9m2LhWqRt4sN8dK5eG1cVxYzB'

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors, space } = useTheme()
  const headingStyle = useTextStyle('title')
  return (
    <View style={{ gap: space.md }}>
      <Text style={[headingStyle, { color: colors.textPrimary }]}>{title}</Text>
      <View style={{ gap: space.md }}>{children}</View>
    </View>
  )
}

export default function UiGalleryScreen() {
  // Hooks run unconditionally (rules-of-hooks) — __DEV__ is a build-time
  // constant, so which branch runs never changes across a component's
  // lifetime, but the early return still has to come after every hook call.
  const { colors, space } = useTheme()
  const [segmentValue, setSegmentValue] = useState<'long' | 'short'>('long')
  const [leverage, setLeverage] = useState(3)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [inputValue, setInputValue] = useState('12.5')

  if (!__DEV__) return null

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.xxl, paddingBottom: space.xxl * 2 }}
    >
      <Section title="Button">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <Button variant="primary" onPress={() => {}}>
            Primary
          </Button>
          <Button variant="secondary" onPress={() => {}}>
            Secondary
          </Button>
          <Button variant="destructive" onPress={() => {}}>
            Destructive
          </Button>
          <Button variant="ghost" onPress={() => {}}>
            Ghost
          </Button>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <Button variant="primary" loading onPress={() => {}}>
            Loading
          </Button>
          <Button variant="primary" disabled onPress={() => {}}>
            Disabled
          </Button>
        </View>
      </Section>

      <Section title="Input">
        <Input
          label="Amount"
          value={inputValue}
          onChangeText={setInputValue}
          suffix="dUSDC"
          hint="Available: 128.40 dUSDC"
          onMax={() => setInputValue('128.40')}
        />
      </Section>

      <Section title="Segment">
        <Segment
          options={[
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
          value={segmentValue}
          onChange={setSegmentValue}
          tone="long-short"
        />
        <Segment
          options={[
            { value: 'long', label: 'Market' },
            { value: 'short', label: 'Limit' },
          ]}
          value={segmentValue}
          onChange={setSegmentValue}
        />
      </Section>

      <Section title="LeverageSlider">
        <LeverageSlider value={leverage} onChange={setLeverage} />
      </Section>

      <Section title="Card">
        <Card title="Position">
          <Row label="Size" value="0.42 SOL" mono />
          <Row label="Entry" value="$132.10" mono />
          <Row label="PnL" value="+$12.40" tone="success" mono />
        </Card>
      </Section>

      <Section title="Row (tones)">
        <Card>
          {TONES.map((tone) => (
            <Row key={tone} label={tone} value="123.45" tone={tone} mono />
          ))}
        </Card>
      </Section>

      <Section title="Badge">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </View>
      </Section>

      <Section title="Sheet">
        <Button variant="secondary" onPress={() => setSheetOpen(true)}>
          Open sheet
        </Button>
        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Confirm close">
          <Row label="Size" value="0.42 SOL" mono />
          <Row label="Est. PnL" value="+$12.40" tone="success" mono />
          <Button variant="primary" onPress={() => setSheetOpen(false)}>
            Confirm
          </Button>
        </Sheet>
      </Section>

      <Section title="Toast">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {TONES.map((tone) => (
            <Button key={tone} variant="secondary" onPress={() => showToast({ tone, text: `${tone} toast` })}>
              {tone}
            </Button>
          ))}
        </View>
      </Section>

      <Section title="Skeleton">
        <Skeleton lines={3} />
      </Section>

      <Section title="EmptyState">
        <Card>
          <EmptyState text="No open positions yet." />
        </Card>
        <Card>
          <EmptyState text="Session expired." action={{ label: 'Reconnect', onPress: () => {} }} />
        </Card>
      </Section>

      <Section title="Address">
        <Address pubkey={SAMPLE_ADDRESS} />
        <Address pubkey={SAMPLE_ADDRESS} explorer />
      </Section>
    </ScrollView>
  )
}
