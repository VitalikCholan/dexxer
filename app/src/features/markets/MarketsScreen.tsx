// app/src/features/markets/MarketsScreen.tsx
//
// "Select market" (spec 2026-10-05 market selector, §5.2): search, tabs,
// A–Z / 24h sort, favourites, position markers, the 16-slot counter. Prices
// come from the WS mark cache (observed, never fetched per market) and
// /tickers; selection is the global `useSelectedMarket`.
import { useState } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useQueries } from '@tanstack/react-query'
import { Page } from '@/src/ui/Page'
import { Input } from '@/src/ui/Input'
import { Segment } from '@/src/ui/Segment'
import { useTheme } from '@/src/theme'
import { useTextStyle } from '@/src/ui/styles'
import { DEFAULT_SYMBOL, useMarkets, useSelectedMarket } from '@/src/lib/markets'
import { useTickers } from '@/src/lib/tickers'
import { useFavorites } from '@/src/lib/favoritesStore'
import { QK, getJson, type Mark } from '@/src/lib/indexer'
import { parseMark } from '@/src/lib/indexerCodec'
import { useLiveAccount } from '@/src/lib/live'
import { decodePositions } from '@/src/lib/positions'
import { useTradeSession } from '../trade/useTradeSession'
import { filterRows, marketRows, slotUsage, sortRows, type MarketTab } from './marketList'
import { MarketRowView } from './MarketRowView'
import { useMarketsSort } from './useMarketsSort'

export function MarketsScreen() {
  const { colors, space } = useTheme()
  const title = useTextStyle('title')
  const caption = useTextStyle('caption')
  const markets = useMarkets()
  const tickers = useTickers(true)
  const favorites = useFavorites()
  const { symbol, setSymbol } = useSelectedMarket()
  const { conn, base } = useTradeSession()
  const positions = useLiveAccount(conn, base?.positions ?? null, decodePositions)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<MarketTab>('all')
  const [sort, setSort] = useMarketsSort()

  const symbols = (markets.data?.length ? markets.data : [{ symbol: DEFAULT_SYMBOL }]).map((m) => m.symbol)
  // Observe the WS-fed mark cache without fetching: `enabled: false` never issues /mark?market=X.
  const markQueries = useQueries({
    queries: symbols.map((s) => ({
      queryKey: QK.mark(s),
      queryFn: () => getJson(`/mark?market=${encodeURIComponent(s)}`, parseMark),
      enabled: false,
    })),
  })
  const marks: Record<string, bigint | null> = {}
  symbols.forEach((s, i) => (marks[s] = (markQueries[i].data as Mark | undefined)?.price ?? null))

  // A few dozen rows: recomputed per render (the React Compiler memoizes this component).
  const rows = sortRows(
    filterRows(
      marketRows({
        markets: markets.data ?? [],
        tickers: tickers.data ?? [],
        marks,
        positions: positions.value,
        favorites: favorites.list,
        selected: symbol,
      }),
      query,
      tab,
    ),
    sort,
  )
  const slots = slotUsage(positions.value)

  const empty =
    query.trim() !== ''
      ? `No markets match "${query.trim()}"`
      : tab === 'favorites'
        ? 'Tap ☆ to pin markets here'
        : tab === 'positions'
          ? 'No open positions'
          : null

  return (
    <Page>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[title, { color: colors.textPrimary }]}>Select market</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={() => router.back()}
          hitSlop={space.md}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={[title, { color: colors.textSecondary }]}>✕</Text>
        </Pressable>
      </View>
      <View style={{ gap: space.md }}>
        <Input label="Search" value={query} onChangeText={setQuery} hint="Ticker or name" keyboardType="default" />
        <Segment
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'All' },
            { value: 'favorites', label: '★ Favorites' },
            { value: 'positions', label: 'With positions' },
          ]}
        />
        <Segment
          compact
          value={sort}
          onChange={setSort}
          options={[
            { value: 'az', label: 'A–Z' },
            { value: 'up', label: '24h ▲' },
            { value: 'down', label: '24h ▼' },
          ]}
        />
        {!markets.data?.length && !markets.isLoading ? (
          <Text style={[caption, { color: colors.warning }]}>Market list unavailable — showing SOL</Text>
        ) : null}
        {slots ? (
          <Text style={[caption, { color: slots.used >= slots.max ? colors.warning : colors.textSecondary }]}>
            {slots.used >= slots.max
              ? `All ${slots.max} position slots are in use. Close a position to open on another market.`
              : `Open positions: ${slots.used} / ${slots.max}`}
          </Text>
        ) : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.symbol}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space.sm, paddingBottom: space.xl }}
        ListEmptyComponent={
          empty ? (
            <Text style={[caption, { color: colors.textSecondary, textAlign: 'center', padding: space.xl }]}>
              {empty}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <MarketRowView
            row={item}
            onSelect={() => {
              setSymbol(item.symbol)
              router.back()
            }}
            onToggleFavorite={() => favorites.toggle(item.symbol)}
          />
        )}
      />
    </Page>
  )
}
