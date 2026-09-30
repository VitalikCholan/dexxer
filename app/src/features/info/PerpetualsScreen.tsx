// app/src/features/info/PerpetualsScreen.tsx
//
// "Learn more about Perpetuals" (C.6-A) — a newcomer's explainer written
// against how Dexxer actually works: oracle-priced, pool as counterparty,
// no order book, no funding, liquidation at the mark. Parameter values are
// not repeated here (they live on the Trade screen's About card) so the
// text cannot drift from the on-chain `Market`.
import { InfoArticle, type InfoSection } from './InfoArticle'

const SECTIONS: InfoSection[] = [
  {
    title: 'What a perpetual is',
    paragraphs: [
      'A perpetual future tracks the price of an asset — here SOL — without you owning it, and without an expiry date. You hold it until you close it or it is liquidated.',
      'Go Long if you expect the price to rise: you gain when it goes up and lose when it goes down. Go Short for the opposite.',
    ],
  },
  {
    title: 'Margin and leverage',
    paragraphs: [
      'Margin is the dUSDC you lock into a position. Leverage is the position size divided by that margin.',
      'Example: $20 of margin at 5× opens a $100 position. A 1% move in SOL changes its value by $1 — that is 5% of your margin. Higher leverage makes both gains and losses on your margin larger.',
      'Add margin to an open position to lower its leverage and move its liquidation price away. Margin comes back to your free balance only when you close.',
    ],
  },
  {
    title: 'Liquidation',
    paragraphs: [
      'If losses bring the margin left in a position down to the maintenance margin, the position is liquidated: it is closed automatically, a liquidation fee is charged, and you lose the margin in it.',
      'The liquidation price shown on your position is where that happens. It is checked against the mark price, not a single trade.',
    ],
  },
  {
    title: 'How prices work here',
    paragraphs: [
      'There is no order book. Every trade executes at the Pyth Lazer oracle price, and you trade against the protocol’s pool rather than another trader.',
      'The mark price is a moving average of the oracle price. It is steadier than the raw feed, which protects against being liquidated by a single spike. If the oracle is stale, opening is paused and liquidation checks are skipped.',
      'You pay a small fee on open and on close. There is no funding rate.',
    ],
  },
  {
    title: 'Privacy',
    paragraphs: [
      'Your open position lives in a MagicBlock private ephemeral rollup running in an Intel TDX enclave. Other traders, trackers, copy-trading bots and the Dexxer team cannot see it.',
      'After you close, the trade is published on-chain after a delay, without your wallet address. Deposits and withdrawals are ordinary Solana transactions and are public.',
    ],
  },
]

export function PerpetualsScreen() {
  return (
    <InfoArticle
      intro="Dexxer lets you trade SOL perpetuals privately from your phone. Here is what you need to know before your first trade."
      sections={SECTIONS}
    />
  )
}
