// app/src/features/trade/TokenInfoPanel.tsx
//
// C.7 «Token information» (the Info tab's first section): name / ticker / rank / launch date, the
// Overview · Utility and Mechanics · Ecosystem texts (collapsible), All-time
// high / low cards, the market-data table and Website / Whitepaper / Explorer /
// GitHub links. Everything comes from the relayer's `/assets/:symbol`; it is
// public market data and says nothing about the trader. The text and links are
// the repo's own, the numbers CoinGecko's — the tab keeps working with the
// text alone when the numbers are unavailable.
import { useState } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { linkPressStyle, useTextLinkHitSlop, useTextStyle } from '@/src/ui/styles'
import { Row } from '@/src/ui/Row'
import { Skeleton } from '@/src/ui/Skeleton'
import { Button } from '@/src/ui/Button'
import { ASSET_LINK_KEYS, useAsset, type AssetInfo, type AssetLinkKey } from '@/src/lib/assets'
import {
  formatCompactUsd,
  formatDate,
  formatPercent,
  formatPrice,
  formatRank,
  formatSupply,
  truncateText,
  updatedAgo,
} from './assetFormat'

const LINK_LABEL: Record<AssetLinkKey, string> = {
  website: 'Website',
  whitepaper: 'Whitepaper',
  explorer: 'Explorer',
  github: 'GitHub',
}

/** Collapsed length of each description, in characters. */
const COLLAPSED_CHARS = 140

function Section({ title, body }: { title: string; body: string }) {
  const { colors, space } = useTheme()
  const heading = useTextStyle('bodyStrong')
  const text = useTextStyle('body')
  const link = useTextStyle('caption')
  const linkHitSlop = useTextLinkHitSlop(link)
  const [open, setOpen] = useState(false)
  const short = truncateText(body, COLLAPSED_CHARS)

  return (
    <View style={{ gap: space.xs }}>
      <Text style={[heading, { color: colors.textPrimary }]}>{title}</Text>
      <Text style={[text, { color: colors.textSecondary }]}>{open ? body : short.text}</Text>
      {short.truncated ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          hitSlop={linkHitSlop}
          style={linkPressStyle}
        >
          <Text style={[link, { color: colors.accentText }]}>{open ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function PriceCard({ label, point }: { label: string; point: { price: number; date: string } | null }) {
  const { colors, space, radius } = useTheme()
  const micro = useTextStyle('micro')
  const value = useTextStyle('bodyStrong', { mono: true })
  const caption = useTextStyle('caption')
  return (
    <View
      style={{
        flex: 1,
        gap: space.xs,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: colors.surfaceAlt,
      }}
    >
      <Text style={[micro, { color: colors.textTertiary }]}>{label}</Text>
      <Text style={[value, { color: colors.textPrimary }]}>{point ? formatPrice(point.price) : '—'}</Text>
      <Text style={[caption, { color: colors.textSecondary }]}>{point ? formatDate(point.date) : '—'}</Text>
    </View>
  )
}

function open(url: string) {
  void Linking.openURL(url).catch(() => undefined)
}

export function TokenInfoBody({ asset, nowMs }: { asset: AssetInfo; nowMs: number }) {
  const { colors, space } = useTheme()
  const title = useTextStyle('heading')
  const caption = useTextStyle('caption')
  const micro = useTextStyle('micro')
  const m = asset.market
  const t = asset.ticker
  const links = ASSET_LINK_KEYS.filter((k) => asset.links[k] !== null)
  const updated = updatedAgo(asset.updatedAt, nowMs)

  return (
    <View style={{ gap: space.lg }}>
      <View style={{ gap: space.xs }}>
        <Text style={[title, { color: colors.textPrimary }]}>{`${asset.name} (${t})`}</Text>
        <Row label="Rank" value={formatRank(m?.rank ?? null)} mono />
        <Row label="Launched" value={formatDate(asset.launchDate)} />
      </View>

      <Section title="Overview" body={asset.overview} />
      <Section title="Utility and Mechanics" body={asset.utility} />
      <Section title="Ecosystem" body={asset.ecosystem} />

      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PriceCard label="All-time high" point={m?.ath ?? null} />
        <PriceCard label="All-time low" point={m?.atl ?? null} />
      </View>

      <View style={{ gap: space.xs }}>
        <Text style={[micro, { color: colors.textTertiary }]}>Market data</Text>
        <Row label="Market cap" value={formatCompactUsd(m?.marketCap ?? null)} mono />
        <Row label="Fully diluted market cap" value={formatCompactUsd(m?.fullyDilutedMarketCap ?? null)} mono />
        <Row label="24h volume (spot)" value={formatCompactUsd(m?.volume24h ?? null)} mono />
        <Row label="Market dominance" value={formatPercent(m?.dominance ?? null)} mono />
        <Row label="Circulating supply" value={formatSupply(m?.circulatingSupply ?? null, t)} mono />
        <Row label="Max. supply" value={formatSupply(m?.maxSupply ?? null, t)} mono />
        <Row label="Total supply" value={formatSupply(m?.totalSupply ?? null, t)} mono />
        <Row label="Circulating rate" value={formatPercent(m?.circulatingRate ?? null)} mono />
      </View>

      {links.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {links.map((k) => (
            <View key={k} style={{ minWidth: '45%', flexGrow: 1 }}>
              <Button variant="secondary" onPress={() => open(asset.links[k]!)}>
                {LINK_LABEL[k]}
              </Button>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={[caption, { color: colors.textTertiary }]}>
        {m === null
          ? 'Market data is temporarily unavailable. '
          : `Market data is sourced from CoinGecko and provided as is${asset.stale ? ' (the latest refresh failed, showing the last values)' : ''}${updated ? `. ${updated}` : ''}. `}
        It describes the underlying asset on spot markets, not this protocol. Not investment advice.
      </Text>
    </View>
  )
}

export function TokenInfoPanel({ symbol }: { symbol: string }) {
  const { colors } = useTheme()
  const caption = useTextStyle('caption')
  const q = useAsset(symbol)
  // eslint-disable-next-line react-hooks/purity -- display-only "updated N min ago"
  const nowMs = Date.now()

  if (q.isLoading) return <Skeleton lines={8} />
  if (q.isError || !q.data) {
    return (
      <Text style={[caption, { color: colors.textSecondary }]}>
        Token information is not available for {symbol} yet.
      </Text>
    )
  }
  return <TokenInfoBody asset={q.data} nowMs={nowMs} />
}
