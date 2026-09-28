// app/src/features/info/RiskDisclosureScreen.tsx
//
// "View risk disclosure" (C.6-A; also for the dApp Store listing). Every
// claim matches the program and the privacy model in CLAUDE.md: privacy is
// a TEE read filter (not from Intel or the operator), losses stop at the
// position's margin with bad debt on the pool, withdrawals are owner-signed
// with a minimum and a cooldown, the session key trades but cannot withdraw.
import { InfoArticle, type InfoSection } from './InfoArticle'

const SECTIONS: InfoSection[] = [
  {
    title: 'Experimental software',
    paragraphs: [
      'Dexxer runs on Solana devnet and MagicBlock’s devnet rollup. The program has not been audited. Bugs in it, in MagicBlock, in the oracle or in this app can cause losses or make funds temporarily unavailable.',
      'dUSDC is a test token issued by our faucet. It has no value and cannot be redeemed.',
    ],
  },
  {
    title: 'Leverage and liquidation',
    paragraphs: [
      'Leveraged trading can lose your whole margin quickly, including within minutes. The higher the leverage, the smaller the price move that liquidates you.',
      'Liquidation is checked every few seconds against the mark price and needs the price to stay past your liquidation price for several checks in a row. In a fast market the position can close at a worse price than the one shown. Your loss is limited to the margin in that position.',
    ],
  },
  {
    title: 'Prices and the oracle',
    paragraphs: [
      'All trades and liquidations use the Pyth Lazer price. If it is delayed, stale or far from the mark, opening is paused and liquidation checks are skipped until it recovers; the price can move a lot in the meantime.',
      'Each trade has a slippage limit of about 1% from the price you saw. If the price moves past it before the trade lands, the trade fails.',
    ],
  },
  {
    title: 'The pool',
    paragraphs: [
      'Your profits are paid from the protocol pool, and your losses go to it. Open-interest caps limit how much the pool can owe. Losses a liquidation cannot cover are recorded as the pool’s bad debt.',
    ],
  },
  {
    title: 'What privacy does and does not cover',
    paragraphs: [
      'Open positions are hidden by MagicBlock’s private rollup in an Intel TDX enclave: other traders, trackers, copy-trading bots and the Dexxer team cannot read them. This relies on Intel’s hardware and on MagicBlock operating it correctly — it does not protect you from Intel or from the operator. It is access control, not encryption.',
      'Closed trades are published on-chain after a delay, without your wallet address. Deposits, withdrawals and your balance changes on Solana are public.',
    ],
  },
  {
    title: 'Keys and access',
    paragraphs: [
      'A session key stored on this device signs your trades without a wallet prompt, until it expires or runs out of actions. It cannot withdraw — withdrawals always need your wallet.',
      'Withdrawals have a minimum of 1 dUSDC and a short cooldown between them. Margin in an open position cannot be withdrawn until you close it.',
    ],
  },
  {
    title: 'No advice',
    paragraphs: [
      'Nothing in this app is financial, investment or legal advice. Perpetual futures may be restricted where you live; you are responsible for complying with your local laws.',
    ],
  },
]

export function RiskDisclosureScreen() {
  return (
    <InfoArticle
      intro="Read this before trading. Perpetual futures with leverage are high-risk, and Dexxer is experimental."
      sections={SECTIONS}
      footer="Last updated 28 September 2026."
    />
  )
}
