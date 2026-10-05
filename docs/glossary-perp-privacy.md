# Glossary: perps, liquidity, privacy

General market terms covered in the research for the project. Ordered by topic; within each, from basic to more advanced. Dexxer's own terms are in `CONTEXT.md`.

---

## 1. Basics

**Liquidity** — how easily an asset can be bought or sold without moving its price. A liquid market: many participants, a narrow spread, a large order fills almost at the on-screen price. A thin market: few participants, a sale takes weeks or requires a discount. The scarcest resource in DeFi: building an exchange is easy, finding those who will stand on the other side is hard.

**Liquid asset** — many buyers and sellers, the price is known every second (SOL, BTC, Apple stock).
**Illiquid asset** — trades are rare, there is no price, only an estimate (an apartment, a rare card, a stake in a business). It can be sold, but either over weeks or at a 20–40% discount.

**Spread** — the difference between the best buy and sell price.
**Slippage** — how much worse than the expected price an order executed.
**Depth** — how much can be bought or sold before the price moves noticeably.

**Derivative** — a contract whose value depends on the price of another asset. It is worth nothing by itself; a train ticket is not a train, but its price depends on the train.

**Futures** — an obligation to buy or sell an asset in the future at an agreed price. Both sides are obliged to perform.

**Perpetual contract (perp)** — a crypto invention: a futures contract without an expiry date. It can be held as long as you like; the funding rate keeps it pegged to spot.

**Option** — the right, but not the obligation, to buy or sell at a fixed price until a certain date. The buyer's maximum loss is the premium paid. Analogy: a deposit on an apartment that fixes the price for three months.

---

## 2. Trading mechanics

**Order book** — two columns of orders: buyers (bids) below, sellers (asks) above. Orders are not "long" and "short" but buys and sells at a specific price: the same buy can open a long for one person and close a short for another.

**Taker** — takes an existing order from the book, gets immediate execution, pays a higher fee.
**Maker** — places an order and waits, adds liquidity, pays less or receives a rebate.

**Market order** — "buy now at the best price". Execution is guaranteed, the price is not.
**Limit order** — "buy no higher than X". The price is guaranteed, execution is not.
**Stop-loss** — an automatic sale when the price falls to a set level; limits the loss.
**Take-profit** — an automatic sale when a target is reached; locks in the profit.
**DCA (dollar-cost averaging)** — splitting a large trade into a series of small ones over time or across price levels.
**Trailing order** — a stop that "follows" the price at a set distance, protecting profit.

**Leverage** — exposure larger than the capital put in. $1000 at 10x = a $10 000 position.

**Margin** — own capital locked as collateral for a position.
- **Initial margin** — how much must be put in to open.
- **Maintenance margin** — the minimum below which the position is force-closed.

**Cross margin** — the whole account balance backs all positions; the profit of one saves another, but one bad one can eat the whole account.
**Isolated margin** — each position has its own allocated margin; maximum losses are limited by it.

**Liquidation** — forced closing of a position when margin falls below maintenance. Exactly enough is taken to cover the debt, plus a liquidation fee. The higher the leverage, the closer the liquidation price: at 10x a ~9% move kills it, at 100x — less than a percent.

**Bad debt** — a situation where, in a sharp move, the position was not closed in time at the calculated price and the loss exceeded the margin. Covered by the protocol's insurance fund.

**Backstop** — the third step of the risk chain: if the market cannot absorb a liquidated position, it is taken by the insurance fund, a protocol vault or the counterparty pool itself. This is where venue architectures diverge most.

**ADL (auto-deleveraging)** — the fourth, last step: if the backstop is exhausted, the venue **forcibly reduces positions on the winning side** so the balance closes. The queue is ranked by unrealized profit, leverage and size — high-leverage positions are closed first. Rare, but documented at every serious venue.

**Wick** — a sharp short price spike that immediately reverts. The most common reason a trader who was right on substance gets liquidated.

**Path dependence** — the outcome depends on the *path* of the price, not only on the end point. Perps have it (a wick kills), an option does not (only the price at resolution matters).

**Funding rate** — periodic payments between traders that keep the perp price near spot. Perp above spot → longs pay shorts; below → the reverse. Paid every 1–8 hours. In essence, the cost of holding a position over time.

**Borrow rate** — the analogue at a peer-to-pool venue: a fee to the pool for borrowed capital, rising with pool utilization (at Jupiter ~13%/year at util 10%, up to 35% at util >80%).

**Theta** — in options: the charge for time, the "melting" of the contract's value as expiry approaches. Economically a relative of the funding rate: a different name, the same thing — you pay for time.

**ITM / ATM / OTM** — in / at / out of the money. In price options: the strike is below / equal to / above the current price. In binary instruments it simplifies to the contract price itself: 85¢ = ITM (the event is likely), 50¢ = ATM, 12¢ = OTM.

**The multiplier in a binary contract = 1 / probability.** A share at 10¢ gives 10x, at 80¢ — 1.25x. The market gives this multiplier for free; any amplification beyond it must be funded by someone's capital.

---

## 3. Liquidity models

**Liquidity pool** — a shared reservoir of assets that people trade against instead of looking for a specific counterparty. Participants (LPs) receive a share token and income from fees.

**LP (liquidity provider)** — someone who put funds into the pool.

**AMM (automated market maker)** — a mechanism where the price is set by a formula over the reserve ratio (`x·y=k`). It solved the problem of empty on-chain order books: a counterparty always exists, because the formula is the counterparty.

**Impermanent loss (IL)** — an LP's loss from a change in the price ratio in the pool: in the end they have less than if they had simply held the same coins.

**Peer-to-pool (trader-to-LP)** — the pool is the counterparty, but the price comes **from an oracle**, not from a formula. Almost zero slippage; the risk of one-sided exposure for LPs. The main perp model on Solana (Jupiter, GMTrade, Flash, Adrena). **CPI-compatible** — a third-party program can open a position.

**CLOB (central limit order book)** — a classic order book. Matching is on-chain, off-chain or on a dedicated chain. Precise price control, but without market makers the book is empty.

**RFQ (request for quote)** — instead of a book, a quote request: the trader asks for a price, a market maker answers. The public book is replaced by one LP that quotes and hedges outside.

**Prop AMM (proprietary AMM)** — a pool with a closed off-chain quoting model instead of a static formula. The logic is deliberately not published: open market-making logic attracts predatory flow and MEV. ≈75% of DEX volume on Solana.

**Omnibus (pooled account)** — one position on a venue on behalf of many users; per-user accounting is kept separately. The source of privacy: there are physically no per-user positions on-chain.

**Netting** — mutual offsetting of opposite positions inside the system without going out to an external venue.

---

## 4. Solana infrastructure

**CPI (cross-program invocation)** — a call from one Solana program to another. What lets a program open a position on Jupiter Perps.

**PDA (program derived address)** — an address derived from a program and a set of seeds, without a private key. The program signs for it through `invoke_signed`. It can be the owner of a position on a venue.

**IDL (interface definition language)** — a machine-readable description of an Anchor program: instructions, account structures, events and **error codes**. It lets you decode `custom program error: 0x1773` into `SlippageExceeded`. The analogue of a source map in Sentry.

**Oracle** — a source of external data for an on-chain program. Pyth, Chainlink, Switchboard. It delivers **facts** (the price now), not forecasts.

**Keeper** — a permissioned executor of deferred actions. In Jupiter Perps the CPI only creates a request, and a keeper does the fill in a separate transaction — so opening is **not atomic**.

**Crank** — a periodic call that moves protocol state forward: margin checks, expiry, liquidation.

**Account contention (the fight for a write lock)** — transactions on Solana run in parallel only if they do not write to the same accounts; those that take a write lock on the same account are serialized. For the omnibus model this is a structural bottleneck: one position = one account = a shared queue under load.

**MWA (Mobile Wallet Adapter)** — the protocol for signing transactions with a mobile wallet on Android; a bottom sheet without switching apps.

**Seed Vault** — hardware key storage on Solana Mobile (Seeker); signing with biometrics.

**Session Keys** — an ephemeral key pair as a second signer plus a session-token PDA with expiry and scope. It allows trading without a wallet prompt for every action. Limitation: SPL Token does not understand session tokens, so token movement requires a separate signature.

**dApp Store** — a crypto-friendly app store on Seeker; listings are NFTs on Solana.

---

## 5. Privacy

**Privacy ≠ anonymity.** Privacy is the invisibility of activity to outsiders. Anonymity is breaking the link between a person and the funds. A wording used by both Aster and Vanish.

**MPC (multi-party computation)** — computation over encrypted data split into shares among nodes; no node sees the values. Arcium on Solana. A cryptographic trust model; expensive for frequently changing state.

**TEE (trusted execution environment)** — a hardware-isolated execution environment (Intel TDX). MagicBlock PER: private state in an SVM rollup with 10–50 ms latency. Fast, but the trust is in hardware, not cryptography.

**ZK (zero-knowledge proof)** — a proof that a computation is correct without revealing the data. Aztec, Paradex, Lighter, Aster Chain. Usually requires its own chain; generating a proof on a weak device takes 20–30 seconds.

**Shielded pool** — a deposit into a shared pool (shield), private activity inside, exit (unshield). Vanish, Turbine, Privacy Cash, RAILGUN.

**Hidden orders** — an order whose size and direction are not visible in the book until execution. It hides **intent**, not the position. Aster.

**Dark pool** — a venue where large orders execute without revealing intent to the market. In TradFi — up to 40% of a mature market's volume.

**13F disclosure model** — a position is private while held and public after close. Analogous to the quarterly position disclosure of institutional funds in the US. It gives audit and a track record without the copy tax.

**Programmable privacy** — combining open and closed data within one system: a contract reveals an aggregate while hiding individual records. An Aztec term.

**Notes and nullifiers** — a UTXO-like model of private state: an encrypted record (a "note") is spent by publishing a unique identifier that proves the spend without revealing the contents.

**View-only access** — the right to see private state without the right to change it. For audit, partners, tax services.

**Copy tax** — a trader's losses because copy bots mirror their entry and the price moves against them while they build the position.

**Liquidation hunting** — a strategy in which participants see the liquidation levels of large positions and have an incentive to push the price there.

**MEV (maximal extractable value)** — the value that can be extracted from transaction ordering: front-running, sandwich attacks, arbitrage.

---

## 6. Compliance

**AML screening** — checking addresses for links to illicit funds. Working vendors on Solana: Elliptic (AML, sanctions), Range (Solana-native monitoring).

**OFAC** — the US sanctions list; checking against it is mandatory for any financial product accessible from the US.

**One-in / one-out model** — the link between deposit and withdrawal stays transparent at the wallet level, only the activity inside is private. The key difference from a mixer. Vanish.

**Regulated Data** — data categories with special requirements under the dApp Store policy: government IDs, medical data, biometrics, **precise geolocation**, data of minors. The reason to geofence at the IP level rather than through GPS in the app.

**Geofencing** — restricting access by jurisdiction. In MagicBlock PER it is done at the network ingress, before the transaction executes.

---

*Compiled 11 September 2026 from research into the Solana ecosystem; the project-specific section on the rejected omnibus design was removed on 05.10.2026 (see git history).*
