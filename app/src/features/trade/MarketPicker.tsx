// app/src/features/trade/MarketPicker.tsx
//
// The market switch above the Trade header: one pill per market of the
// relayer's registry (`useMarkets`, SOL first; just SOL until it answers or
// when it fails). The choice is global and persisted (`useSelectedMarket`).
// A market whose opening is paused (`Market.paused_open`) gets a badge —
// closing still works there.
import { ScrollView, View } from 'react-native'
import { useTheme } from '@/src/theme'
import { Badge } from '@/src/ui/Badge'
import { Segment } from '@/src/ui/Segment'
import { DEFAULT_SYMBOL, useMarkets, useSelectedMarket } from '@/src/lib/markets'

export function MarketPicker() {
  const { space } = useTheme()
  const markets = useMarkets()
  const { symbol, setSymbol } = useSelectedMarket()
  const list = markets.data?.length ? markets.data : null
  const symbols = list ? list.map((m) => m.symbol) : [DEFAULT_SYMBOL]
  const paused = list?.find((m) => m.symbol === symbol)?.params.pausedOpen ?? false

  return (
    <View style={{ gap: space.xs }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Segment compact value={symbol} onChange={setSymbol} options={symbols.map((s) => ({ value: s, label: s }))} />
      </ScrollView>
      {paused ? <Badge tone="warning">{`Opening paused on ${symbol}-PERP`}</Badge> : null}
    </View>
  )
}
