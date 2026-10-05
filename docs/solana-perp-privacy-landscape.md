# Perp DEXs and privacy on Solana — a map of approaches

**Date:** 11 September 2026
**Source:** our own research for the Cloak project (a private mobile perp for Seeker)
**Data status:** collected from public sources (Soladex, DefiLlama, category reviews, official docs, a mainnet simulation of Jupiter Perps). Check the numbers before using them in a deck.

---

## Part 1. Liquidity, matching and venue architecture

The common problem of every DEX: **someone has to stand on the other side of the trade**. Sections 1.0–1.5 are six answers to that question (liquidity models); sections 1.6–1.8 are orthogonal axes: where orders are matched, why pools won on public chains and how a vault differs from an omnibus.

**Frame: what any perp DEX consists of.** Regardless of the model, it has three layers:
1. **Execution and chain** — where orders are matched and where state lives (own L1, a rollup, off-chain matching with on-chain settlement, or a program on a general-purpose chain).
2. **Liquidity, margin and LPs** — who the counterparty is and whose capital backs the positions.
3. **Risk, oracle, clearing** — on-chain oracles, margin modules, liquidation logic, risk buffers.

Cloak adds a **fourth layer — private accounting**, without touching the first three: execution and liquidity come from someone else's venue, the risk module is duplicated inside (internal liquidation that runs ahead).

### 1.0 Classic AMM (formula curve)

A shared pool of two assets; the price is set by a **formula over the reserve ratio** (constant product `x·y=k` or its variations). The trader trades against the pool, LPs receive a share of fees.

**Why it appeared:** the first DEXs tried to keep an order book on-chain, and it did not work — every order placement and cancellation costs a transaction, market makers find it unprofitable, the book is empty. The AMM made a counterparty always available, because the formula became the counterparty.

| + | − |
|---|---|
| A counterparty is always there, no waiting | The price comes from a formula, not the market → large slippage on large orders |
| Passive LP income without active management | Arbitrageurs constantly realign the pool with the outside market at the LPs' expense |
| Extremely simple, permissionless pool creation | **Impermanent loss (IL)**: on a sharp price move the LP has less than if they had just held the coins |
| Composability: any program can swap through CPI | Capital is spread over the whole price range instead of the zone of real trading |

**Status:** for spot on Solana it is gradually being displaced by the prop AMM (see 1.4). For derivatives it is almost never used in pure form.

### 1.1 Peer-to-pool (trader-to-LP) — the main perp model on Solana

The trader trades **against a shared pool**, but the price comes **from an oracle**, not from a formula. The pool is the counterparty to all trades; LPs effectively become the opposite side of the market.

| + | − |
|---|---|
| Almost zero slippage even on large orders | LPs hold one-sided exposure against the crowd of traders |
| Instant execution, no waiting for a counterparty | The borrow rate grows with pool utilization (up to 35%/year at Jupiter at util >80%) |
| **CPI compatibility** — a third-party program can open a position | Dependence on oracle quality: delay or manipulation = wrong liquidations |
| Transparent, predictable economics for an integrator | Depth is limited by pool size; new markets need new capital |

| Venue | Pool / token | Features |
|---|---|---|
| **Jupiter Perps** | JLP, ~$1.3–2.5B | The deepest pool on Solana; 5 markets; fees 6 bps open + 6 bps close + price impact + borrow (~13%/year at util 10%, up to 35% at util >80%); **opening is asynchronous** — the program creates a request, a permissioned keeper executes the fill |
| **GMTrade** (ex-GMXSOL) | Multi-pool GM Pool / GLV | A GMX V2 fork by GMX DAO vote, mainnet since March 2025; **#1 on Solana by 30-day volume**; ~90 markets: crypto + forex + commodities + indices + stocks through Chainlink Data Streams; claimed ~0.5 bps fees; LP risk isolated per market |
| **Flash.Trade** | FLP / FAF token | Pool-to-peer; up to 100x (really 20x on some assets); crypto, forex, gold; market/limit/SL/TP. **The program is closed** (the `flash-perpetuals` repo does not exist publicly); `flash-sdk-rust` for reading on-chain state; `examples-v2` (MIT, July 2026); **a fork of `magicblock-labs/session-keys` and `magicblock-grpc-example`** — i.e. a live Solana perp is already integrated with MagicBlock; plus its own MCP server for agents and a Yellowstone fork for indexing |
| **Adrena** | ALP | Third by volume on Solana in 2025; up to 100x; no liquidation fees |

### 1.2 Central Limit Order Book (CLOB)

A classic order book: makers place limit orders, takers take them. Matching is on-chain, off-chain with on-chain settlement, or on a dedicated chain.

| + | − |
|---|---|
| Precise price control: limit orders, visible depth | **Without professional market makers the book is empty** — the main reason on-chain order books die |
| No IL: the market maker manages its own inventory | On-chain matching is expensive; off-chain means trusting the operator |
| A familiar experience for a CEX trader | **Usually unsuitable for omnibus integration through CPI** |
| Natural pricing from supply and demand | Slippage on thin markets is worse than peer-to-pool |

| Venue | Where matching happens | Features |
|---|---|---|
| **Pacifica** | Its own Pacifica L1, off-chain matching + on-chain settlement | sub-20ms; $100B+ cumulative; taker from 0.04%; unified margin; **Android app since July 2026**; founder — Constance Wang (ex-FTX COO) |
| **Velocity** (ex-Drift) — *see 1.5, hybrid* | JIT auction → DLOB → AMM | After the 1 April 2026 exploit (~$295M, social engineering of the multisig, not a contract bug) — rebrand on 1 July, private beta, narrower scope; previously had **Delegated Accounts, Vaults and Builder Codes** — official primitives for third-party integrators |
| **Margin** (Solayer) | CLOB on Solana | Early: SOL perp only 2x, cross-margin only; crypto + commodities + stocks; leaderboard with PnL and Sharpe |
| **Phoenix** | On-chain/hybrid | USDC collateral, a separate deposit account, cross/isolated, TP/SL, referrals 20% fee share |
| **Raydium Perps / Saros** | Orderly Network (off-chain, multichain) | 70–100+ pairs, 50–100x, gasless |
| **Aster** (not Solana-native, but trades from Solana) | Two modes: **Pro** — an order book on BNB, Ethereum, **Solana**, Arbitrum; **Simple** — a **pool model** with its own fee system | Fees 0% maker / 0.04% taker on USDT perps. **Action: check Simple mode for CPI compatibility with Solana** — if the pool contract is deployed on Solana, it is a potential venue for the omnibus |

### 1.3 RFQ / single market maker

The public book is replaced by **one LP that quotes prices on request, hedges outside (CEX/DEX/OTC) and shares PnL with depositors**.

| + | − |
|---|---|
| Institutional depth without own capital: liquidity is aggregated from outside | Centralization: quality depends on one operator |
| Fast listing of new and exotic markets | No public book → worse pricing transparency |
| Custom derivatives, bilateral settlement | Composability is worse than in pool models |
| Depositors get a share of the market maker's PnL | Counterparty risk is concentrated |

**Example outside Solana:** Variational (Arbitrum) with the retail front end Omni — 450+ markets, zero fees. Structurally the closest relative of the omnibus model: many users inside, one entity outside.

### 1.4 Prop AMM (closed quoting logic) — the fastest growth

There is a pool, but the price comes **not from a static formula but from a closed off-chain model** that reacts to the market in real time. A hybrid of pool convenience and market-maker intelligence. Settlement, custody and accounting stay on-chain.

| + | − |
|---|---|
| Tighter spreads and better execution than formula AMMs and often than CEXs | The logic is closed: trust in the operator, the pricing cannot be audited |
| Dynamic inventory management → fewer stale quotes and mispricing | Pools are created by the protocol team, not permissionless |
| Flow segmentation: retail gets better terms than toxic bots | Gives no privacy at all to the **trader** — their swap is still public |
| Composability preserved (unlike RFQ) — routers route into it | Concentration: one player holds a large market share |

**Scale on Solana:** prop AMMs ≈ **75% of DEX volume**, of which over 60% is HumidiFi ($1B+ per day, ~35% of all spot); the segment grew from <10% to >70% in about a year. More detail — section 5.8.

### 1.5 Hybrid models (several processing layers for one order)

Instead of one mechanism — a sequence: the order passes through several layers, each compensating for the weakness of the previous one.

**Drift / Velocity (Solana): JIT auction → DLOB → AMM.**
An order first enters a **Just-In-Time auction** — a short window where market makers compete for the right to fill it. The unfilled remainder goes to the **DLOB** (a decentralized limit order book kept off-chain by keepers and executed on-chain). Whatever is not covered there falls to the **AMM** as the counterparty of last resort.

**Bluefin (Sui): external matching + on-chain settlement.**
Orders are matched off the blockchain, settlement and position state are on the network. An intermediate configuration between a fully on-chain book and fully off-chain matching.

**dYdX Chain: validators as market-making infrastructure.**
The chain's validators themselves keep the book in memory and match orders; only executed trades and positions go on-chain. The logic: writing thousands of placements and cancellations per second to the chain is economically pointless, so only the result goes into state.

**Hyperliquid: the book as part of state.**
The purest construction: the book lives directly in HyperCore state — every placement and cancellation is on-chain state, not an off-chain agreement between validators. Possible only on a specialized L1 built around this task; hence also the ~70% share of the perp DEX market.

**The trade-off at the infrastructure level (three options for any perp DEX):**
- **Own L1** (Hyperliquid) — full control, lowest latency; the price: building validators and securing the network.
- **Rollup** (Lighter, Reya) — Ethereum security with faster execution and cheaper settlement.
- **Off-chain matching + on-chain settlement** (dYdX, Bluefin) — less gas and latency; the price: trust in the off-chain infrastructure.
- **Network extension / application layer on top of a chain** (Bullet on Solana, MagicBlock ER/PER) — its own execution substrate with sub-millisecond latency, but **inside the ecosystem**: it inherits the throughput and liquidity of the base layer and commits state back. The fourth option, the most recent, which removes the "own chain or slow" dilemma.

| + | − |
|---|---|
| Better price from market-maker competition (JIT) while keeping guaranteed execution (AMM) | Several layers = several sets of assumptions and attack surfaces |
| Flexibility of limit orders together with an always-available counterparty | **Unpredictable entry price**: depends on who won the auction or what the book depth is at that millisecond |
| CEX performance without a centralized operator (dYdX, Hyperliquid) | Consistency of the off-chain book across validators is a separate hard problem (dYdX) |
| Verifiability of the book if it is in state (Hyperliquid) | Requires its own chain; traders and liquidity have to migrate |

**The Velocity lesson.** After the ~$295M exploit (social engineering of the multisig, not a bug in the mechanisms) the team is relaunching with a **deliberately narrowed scope**: perps only, USDT only, Isolated Markets and Amplify removed. Complexity was acknowledged as part of the problem — a useful precedent for anyone planning a multi-layer architecture.

**Why hybrids are worse for the omnibus model.** In JIT the price depends on the auction winner, in the DLOB on the book depth at a specific moment. For an aggregated position this means an unpredictable entry price that is then hard to attribute fairly to a specific user. In peer-to-pool the price comes from the oracle — deterministic, and per-user attribution is trivial. So the choice of pool venues is not only about CPI compatibility but also about **pricing predictability**.

### 1.6 The evolution of matching: off-chain → on-chain → distributed

A classification by **where orders are physically matched** (orthogonal to the liquidity model):

| Method | Who | + | − |
|---|---|---|---|
| **Off-chain matching** | Paradex, Aevo, Pacifica | Speed, book depth, execution quality | Dependence on centralized components; less transparency |
| **On-chain book** | Hyperliquid (in HyperCore state), Phoenix | Transparency and security, a trustless environment | Gas, latency, the need for optimizations |
| **Distributed matching** | dYdX v4, Hyperliquid | The book lives **in the mempool**; orders are matched during block production under mempool conditions. Transparency close to on-chain with off-chain performance | **Possible only on appchains where the developer controls the execution client** |

**Trend (per Logarithm Finance, 2024):** the share of off-chain matching is falling, the market is moving towards on-chain and distributed schemes.

**The consequence for us, important and final:** we build on a **public chain**, so distributed matching is unavailable to us by definition — public blockchains do not allow such deep integration with the execution client. This finally closes the question "why not build our own matching".

### 1.7 Why pools won specifically on public chains

Order-book DEXs dominated at first; by 2023 pool models had taken ~45% of perp volume. Three reasons, all three structural:

1. **The pool architecture needs less throughput and latency** — so it gives acceptable trade-offs on public execution layers, where a book chokes.
2. **No need to deposit or bridge assets** — a substantial advantage for the casual trader.
3. **Democratization of market making**: LPs earn fees and tokens, which creates depth without professional desks.

**The most important observation:** on **appchains and rollups** the book dominates, on **public chains** — pools. Solana is a telling case: despite high throughput and minimal block time (arguments for on-chain books), the volume leader is **Jupiter — a pool exchange**.

So choosing peer-to-pool for the omnibus is not a matter of convenience but a fit with the structure of a public chain.

### 1.8 Vaults: the public twin of the omnibus

Order-book exchanges look for ways to give retail passive liquidity provision. **HLP at Hyperliquid** is a protocol vault that market-makes and liquidates, receiving part of the fees; users can create their own vaults, and this is effectively **formalized infrastructure for passive copy trading**. dYdX v4 announced similar LP vaults.

The construction is formally similar to our omnibus: many depositors, one position outside. **The difference is in purpose: a vault is public and created to be watched and copied; an omnibus is private and created not to be watched.** This is a ready answer to the question "how is your omnibus different from HLP".

### 1.9 The risk chain: margin → liquidation → backstop → ADL

Common to all three architectures, and it is precisely on the third and fourth steps that they diverge most.

| Step | What happens | Where architectures differ |
|---|---|---|
| **1. Margin** | A position must keep collateral above the maintenance threshold. The threshold is computed from the venue's **reference price** (a mix of external and internal data), not from the last trade — a protection against manipulation and a source of confusion when the chart briefly shows a price that triggered nothing | Thresholds depend on the asset and leverage |
| **2. Liquidation** | The venue closes the position, usually by pushing it into the market. If it closed near the expected price, the trader loses the margin, sometimes with a remainder | In a book — a liquidity gap; in a pool — the pool absorbs it |
| **3. Backstop** | If the market cannot absorb the position, something else takes it: an insurance fund from previous liquidations, a protocol vault (on depositors' balance) or the pool that was the counterparty anyway | **This is where the venue's real risk profile lives** |
| **4. Auto-deleveraging (ADL)** | If the backstop is exhausted, the venue **forcibly reduces positions on the winning side** so the balance closes. The queue is ranked by a combination of unrealized profit, leverage and size | Rare, but documented at every serious venue |

**A test for choosing a venue:** if a venue cannot explain in its own documentation what exactly happens at steps 3 and 4, its risk cannot be assessed.

**The consequence for the omnibus — a new design requirement.** ADL reduces **our aggregated position**, not a specific user's position. So we need:
- a rule for distributing a forced reduction among participants (pro rata? by leverage, like the venues themselves? by entry time?) — chosen in advance and described in the terms;
- to account for the fact that **an omnibus with high aggregated leverage stands first in the ADL queue** — one more argument for a conservative cap;
- a separate state in the PER sub-ledger for a partially reduced position.

Without this, the very first ADL turns privacy into a dispute about whose position was cut.

### 1.10 Leverage arithmetic (for the UI and for our own limits)

At **10x** roughly a **10%** adverse move wipes out the position (before fees and funding). At **50x** — roughly **2%**, and such moves happen several times a day in crypto. Reference prices, maintenance-margin buffers and partial liquidations change these numbers at the edges, but not the order of magnitude.

An observation about incentives worth its own line: a venue earns on notional, so a trader at 50x generates fifty times more fees from the same collateral, while the chances of surviving ordinary volatility fall accordingly. **High leverage is not a feature but a permission, and it pays off asymmetrically.** Plus the ADL queue ranks high-leverage positions first — venues know which accounts are fragile.

For our UI: show not "up to 50x" but the distance to liquidation as a percentage of price movement next to the leverage slider.

### 1.11 The graveyard and the pattern: on Solana pools survive, books leave for their own networks

| Protocol | What it did | What happened |
|---|---|---|
| **PsyOptions / PsyFi** | Permissionless option minting, an options AMM, covered-call vaults | The infrastructure exists, liquidity was not gathered; the category faded |
| **Friktion** | DOVs (automated vaults that sell options) | Shut down |
| **Zeta Markets** | Options → perps; **a fully on-chain CLOB on Solana**, 20x cross margin, SDK and CPI programs for market makers; **$15B+ volume** | **Ceased operations in May 2025**; the team left to build **Bullet** — a network extension on Solana (see below) |
| **Drift** | Hybrid JIT + DLOB + AMM | A ~$295M exploit (social engineering of the multisig), rebrand to **Velocity**, a private beta with a narrowed scope |
| **Jupiter, GMTrade, Flash, Adrena** | Peer-to-pool with oracle prices | **Alive, growing, dominant by volume** |

**A pattern, not a coincidence.** Successful order-book teams eventually build their own execution layer: dYdX (StarkEx → its own Cosmos chain), Aster (multichain → Aster Chain), Zeta ($15B of volume on Solana → Bullet). A book on a general-purpose chain runs into the fact that market making requires constant placing and cancelling of orders, and that is expensive and slow there. Pool models do not require it — and it is they that are alive on Solana.

**An important nuance in Zeta's case:** they chose not their own L1 but a **network extension on top of Solana** — an execution layer that stays in the ecosystem. So the "own chain or slow" dilemma has a third answer, and it is the one chosen by the team with the most perp experience on Solana.

**The consequence for us — a fourth independent confirmation of choosing peer-to-pool.** We are on a public chain, we do not build a book, we do not build our own network.

**A practical note:** Zeta's SDK and CPI programs were the official integration channel for market makers. The protocol is dead, but the code is a possible reference for "how a CPI integration with a perp protocol on Anchor is structured".

### A caveat about data quality: wash trading

The authors of industry reviews openly admit that **wash trading is a significant problem across the whole industry**, publicly claimed volumes cannot be verified, and **inflating volume is much easier than manipulating TVL**. So ranking by the **efficiency ratio — average daily volume / TVL** — is more reliable than bare volume.

**A practical consequence for choosing a venue:** before putting the omnibus on GMTrade because of its "first place by 30-day volume", compute volume/TVL for Jupiter, GMTrade, Flash and Adrena. A place by volume can be bought.

### On the horizon: Bullet (Solana network extension, the Zeta team)

After Zeta shut down (May 2025, $15B+ volume) the team is building **Bullet** — not a separate L1 but a **network extension on Solana**: an application-specific execution layer with its own substrate for DeFi, a claimed **0.1 ms transaction execution** and thousands of TPS, plus ZK cryptography for verifiability. Perps, spot and lending are built into the fabric of the network. The motivation in their words: Solana has the users, assets, liquidity and trading culture, but it lacked a professional-grade **dedicated execution layer**.

**Why this matters for our architecture.** Bullet and MagicBlock PER are solutions of the same class: a specialized execution layer on top of Solana with sub-millisecond latency and state committed to the base layer. The difference is in purpose (trading with built-in matching versus private state in a TEE). So **our choice of PER is conceptually confirmed by Solana's most experienced perp team**: to get fast trading on Solana you do not need to leave Solana — you need to build an execution layer.

**As a venue candidate — checked and crossed out (September 2026).** There is programmatic access, but it is a **REST/WebSocket API, not CPI**: `bullet-rust-sdk` (MIT, + WASM for JS/TS) is a REST client generated from OpenAPI through Progenitor, with its own transaction format `CallMessage` with namespaces `User / Public / Keeper / Vault / Admin`. Positions live **in the Bullet exchange state**, not as Solana accounts; signing is through `Keypair::from_hex(private_key)`.

This is structurally incompatible with the omnibus model, not merely inconvenient:
- we aggregate users → **our server holds the key and signs for them** = custody, i.e. what the product does not do;
- everyone signs themselves → **no aggregation, hence no privacy**. Plus Seed Vault does not give out the private key, and the SDK shows no "sign externally and relay" path.

So Bullet is an API-first exchange in the dYdX v3 / Hyperliquid model: privacy there would be a property of the operator, not of the architecture. **It stays as an architectural reference** (network extension = the same class as MagicBlock PER), not as a venue.

### Percolator (Solana) — deployed, formally verified, candidate #1 for forking our own core

Anatoly Yakovenko (Solana co-founder) is building **Percolator** — a permissionless perp protocol: `aeyakovenko/percolator-prog` (the program) + the `percolator` crate (risk engine v16). One market = one slab account with an array of assets; the **Router** nets portfolio exposure and routes atomically. Built for **Anchor v2 / Pinocchio entrypoint**, platform-tools 1.52; LiteSVM integration tests, a fuzz corpus, stateful fuzz; **formal verification of the risk engine (Kani proofs)**.

**Status changed from "on the horizon" to "deployed":** the program exists with a program ID, it is brought up in a local validator (Syntx does this in `setup-intent.ts`), and there is an ecosystem around it — **Percolator Launch** ("pump.fun for perps": a perp market for any SPL token in one click, up to 20x, vAMM for starting liquidity, an insurance fund; live on devnet, 365 commits) and **Syntx** (a vault layer with adapters).

**A design idea that closes our ADL problem at the architecture level:** "a predictable alternative to ADL" — profit is treated as a **junior claim** on the exchange balance, deposited capital as **senior**; no user can withdraw more than actually exists on the balance. Instead of forcibly reducing winning positions after the fact — an order of claims by construction.

**An honest caveat from their README in capital letters:** EDUCATIONAL RESEARCH PROJECT — NOT PRODUCTION READY — NOT AUDITED. Acceptable for a hackathon; for real funds — stop until an audit. And the model is **coin-margined** (you deposit the same token you trade) — check whether there is USDC margin or whether this is fundamental.

**Its role for us:** if liquidity does not have to be someone else's (Option 2 in the architecture), Percolator is the main candidate for forking our own core: the freshest toolchain, verified risk, a composable instruction set with a described CPI binding, Yakovenko's name for the judges. Week-0 check: build, USDC margin, delegating position accounts into PER.

### Candidates for forking our own core (Option 2) — summary

| Candidate | Licence / state | What for |
|---|---|---|
| **Percolator** | Open; educational, not audited; Anchor v2 / Pinocchio | **The base**, if it fits |
| **`solana-labs/perpetuals`** → Flash and Adrena forks | Apache-2.0; the original is archived (3 years, Anchor ~0.26), an audit report in the repo, ~5.5K lines | Only the formulas + the audit report. The Flash and Adrena forks are closed (`AdrenaFoundation/perpetuals` — an archived 2024 copy of solana-labs) |
| **Drift `protocol-v2`** (→ velocity-exchange) | Open; tens of thousands of lines; Rust 1.70 / Solana 1.16; transitional state after the exploit | A reference for liquidations and the insurance fund, not a base |
| **Brute** (`divi2806/brute`, 2026) | **No LICENSE → all rights reserved; do not take the code**; hackathon quality | A reference for a modern toolchain (Pyth Hermes + on-chain verification, indexer, TP/SL keeper) |
| **Syntx** (`psyto/syntx`) | Apache-2.0; Anchor 0.30.1 | An example of CPI integration with Percolator; ready-made VenueAdapters |

**What our own core changes:** the omnibus was needed only because positions lived on someone else's venue. If the core is ours, positions are accounts of our program and are delegated into PER directly; privacy is natural, without aggregation, a request state machine, two-layer liquidation and ADL distribution. In exchange, pool risk returns, along with the need for capital and an insurance fund — and here Percolator's senior/junior model is the best answer.

### Competitor fees (a reference for product economics)

| Venue | Maker | Taker | Note |
|---|---|---|---|
| Aster | **0%** | 0.04% | USDT perps, base tier |
| Hyperliquid | 0.015% | 0.045% | base tier |
| ApeX Omni | 0.02% | 0.05% | VIP discounts |
| GMX | 0.04% | 0.06% | the rate depends on the trade's impact on the open-interest balance |
| Jupiter Perps | — | 6 bps open + 6 bps close | + price impact + borrow ≈ 13 bps round-trip |
| GMTrade | — | claimed ~0.5 bps | **check on mainnet** |

Our reference: ~13 bps round-trip on Jupiter is the upper bound of the market. A privacy premium of 2–5 bps on top looks different depending on the venue: on Jupiter it is +25% to the cost of a trade, on GMTrade with its claimed 0.5 bps — multiples more in relative terms, but cheaper in absolute terms. **One more argument to check GMTrade first.**

### Summary: which model for what

| Model | Who is the counterparty | Entry price | Slippage | CPI compatibility | Where it is used |
|---|---|---|---|---|---|
| Classic AMM | Formula | Deterministic (formula) | High on volume | ✅ | Spot, long-tail tokens |
| Peer-to-pool | Pool at the oracle price | **Deterministic (oracle)** | Almost zero | ✅ | **Perps on Solana; our choice** |
| CLOB | Another trader | From book depth | Depends on depth | ⚠️ rarely | Perps for pros, a CEX-like experience |
| RFQ | One market maker | From the quote | Depends on the quote | ❌ | Exotics, institutional markets |
| Prop AMM | Pool with a closed model | From the closed model | Lowest | ✅ | Spot on Solana (dominant) |
| Hybrid (JIT+DLOB+AMM) | Depends on the layer | **Unpredictable** | Low | ⚠️ hard | Drift/Velocity, dYdX, Hyperliquid |

---

## Part 2. The layer on top of venues: aggregators and routers

A separate category: they hold no liquidity but route into venues. They differ by **who owns the position**.

| Product | Who owns the position | Venue | What it gives |
|---|---|---|---|
| **Ranger** | The user's wallet (no deposit, collateral allocated in real time) | Jupiter, Flash, Drift | Smart Order Router, aggregation of funding rates, OI and liquidations in one format |
| **Imperial** | **A smart contract owns the position** (per-user) | Jupiter, Flash, Phoenix, GMTrade | Routing by leverage/liquidity; DCA, trailing, indicator orders; One Click without signatures; Telegram bot; **Liquidation Map** (where other people's stop-losses cluster); leaderboard, points, referrals |
| **Lavarage** | The protocol (spot margin, not perp) | Jupiter (swap routing) | A position larger than the balance through a loan from SOL/USDC vaults; sign-in through email/social (Privy) |

**The key observation.** Imperial proved in production that **a program can own a position and execute trades on behalf of a user on several Solana venues**. But the position stays per-user — it is visible on-chain whose it is. Nobody aggregates several users into one position.

---

## Part 3. Privacy: what mechanisms exist

### 3.1 Technical approaches (pros and cons are in the "good for" / "bad for" columns)

| Approach | How it works | Trust model | Good for | Bad for |
|---|---|---|---|---|
| **MPC** (Arcium) | Data is split into shares among nodes (secret sharing); computation over ciphertext in an MXE — an account that binds the program, the computation definition and a cluster of Arx nodes. The Solana program makes a CPI `queue_computation`, the result comes back in a callback signed by the cluster. Toolchain: Arcis (a Rust framework and compiler), Anchor-compatible programs, a TS client | Cryptographic, **"at least one honest node"** (Cerberus) — stronger than a TEE, where you trust Intel and the operator | One-off computations over inputs from several parties: vote counting, sealed bids, dark-pool matching, **proof of solvency** | Frequently changing state: every update is an MPC round with latency and cost. **And more importantly — `detect-and-abort`:** on a detected protocol error the computation stops rather than returning a corrupted result; the application must itself handle the failure, retry, queue expiry and migration. For a liquidation loop this is disqualifying: a step that sometimes simply does not happen is unacceptable in risk logic |
| **TEE** (MagicBlock PER) | A delegated account lives in an SVM rollup inside Intel TDX; access by a permission list; 10–50 ms; emulated locally through the Query Filtering Service | Hardware: you trust Intel and the validator operator | Private state with frequent updates: positions, margin, the liquidation crank | A weaker trust model than MPC; code attestation must be checked separately (an MRTD/RTMR allowlist) |
| **ZK** (Paradex, Aster Chain, Lighter) | State is encrypted, correctness is proven by proofs; usually requires a dedicated chain for this | Cryptographic | Full control of the stack, privacy by construction | Needs its own chain; the trader has to migrate to another ecosystem |
| **Shielded pool** (Vanish, Turbine, Privacy Cash) | A deposit into a shared pool (shield), private activity inside, exit (unshield) | Depends on the implementation | Swaps, transfers, DCA, deposits | Does not hold complex state with leverage and liquidations |
| **Closed pricing logic** (prop AMM — HumidiFi, Solana) | The market maker quotes from an off-chain HFT model and internal risk metrics; settlement and custody on Solana; the logic is deliberately not published. The privacy is not cryptographic but structural — the model is simply closed | Trust in the operator; funds are not in custody | Execution quality: tighter spreads, fewer failed transactions, segmenting retail from toxic flow | Gives nothing for the *trader's* privacy — their swap is still public |
| **Protocol-level privacy** (Aztec — EVM L2) | Its own network with "programmable privacy": private functions run locally in the PXE on the user's device, only ZKPs go to the network; state is encrypted `notes` in a UTXO model with nullifiers; public and private logic are separated (private can call public, not the reverse) | Cryptographic (zk-SNARK, UltraPLONK) | Privacy by default for any application, flexible combination of open and closed data within one transaction | Its own language (Noir), EVM incompatibility, a complex multi-level architecture, higher hardware requirements; the risk of repeating Starknet's trajectory |
| **Shielded pool + cross-contract calls** (RAILGUN — the EVM benchmark) | The same plus cross-contract calls: in one block unshield → a multicall to external protocols → re-shield of the result; if any call fails, the whole transaction reverts | Cryptographic (ZK, Groth16) | Private interaction with any public protocol: swaps, LP, staking | EVM only (Ethereum, Arbitrum, Polygon, BSC); proof generation 20–30 s on weak devices — unacceptable for mobile trading |

### 3.2 What exactly is hidden — an important difference

| What is hidden | Who does it | Comment |
|---|---|---|
| **Source of funds** (the CEX/KYC ↔ trading wallet link) | Privacy Cash | SDK, in the dApp Store, recommended by Solana Mobile itself |
| **Network** (IP, logs) | UR Network | p2p VPN, native on Seeker, integrated with Seed Vault Wallet |
| **Transfers and DCA** | Turbine Cash | 0.30% per withdrawal; the recipient cannot trace the tx to the sender |
| **Spot swap** | Vanish | Shield → trade → unshield; routing through Solana aggregators; **one-in/one-out**: the deposit-withdrawal link is transparent, only the activity is private; Elliptic (AML/OFAC) + Range screening |
| **Messages** | Cherry | E2E, the key is generated from a wallet signature on the device; open GitHub |
| **An order before execution** | Aster (hidden orders, since June 2025), Aster Chain (ZK, March 2026) | Hides intent; after execution the position exists in their system |
| **Activity on a ZK layer** | ApeX Omni (zkLink X, ex-StarkEx) | Individual activity is private, balances and settlements are verified on-chain; privacy is a property of the layer, not a separate product. Multichain: Ethereum, BNB, Arbitrum, Mantle, Base, **Solana** (as a deposit chain) |
| **Transfer amount with public owners** | **Confidential Balances** (SPL Token-2022) | Amounts are encrypted, account owners are public; a confidential transfer does not change `pre/postTokenBalances`. **The limitation that makes it inapplicable for us: it is enabled at the mint level** — to make confidential USDC transfers, the extension must be in the USDC mint itself (owned by Circle). Our own wrapped token = liquidity fragmentation and new trust. Plus the cost: every transfer requires creating, verifying and closing three proof-context accounts (equality, ciphertext validity, range) — acceptable for a rare deposit, not for frequent actions. The auditor ElGamal key is also global per mint and assigned by its authority |
| **A market maker's pricing logic** | HumidiFi and other prop AMMs | A closed model as protection against predatory flow and MEV; ~75% of Solana DEX volume goes through prop AMMs, >60% of that is HumidiFi (the segment grew from <10% to >70% in a year) |
| **A position over its lifetime** (size, entry, liquidation, PnL) | **Paradex** (Starknet), Darklake/UniFi announcements, Umbra plans | On Solana — **not a single live one** |

### 3.2b The Foundation's official taxonomy: five dimensions of privacy

The Solana Docs open the privacy section with the right warning: "private" means different things in different models, and you need to define **what exactly** is hidden, **who should be able to inspect it** and **how much control the operator needs** — before choosing an integration path. Five dimensions:

1. **Amount confidentiality** — sizes and balances are hidden.
2. **Participant anonymity** — who exactly takes part.
3. **Control policies** — limits, permissions, transfer rules.
4. **Private execution** — computation over hidden state.
5. **Audit access** — who can look and under what conditions.

**Three official solutions against these dimensions:**

| Solution | What is private | What is public | Audit |
|---|---|---|---|
| **Confidential Balances** (Token-2022) | Balances and transfer amounts | Mint, token accounts, owners, the fact of taking part in a transaction | An optional global auditor ElGamal key on the mint: decrypts transfer amounts, does **not** reveal the full balance and does **not** give the right to move funds |
| **Solana Privacy Protocol (Rings)**, beta, Helius docs | Default Ring: asset and amount; Custom Rings: can be confidential **or** anonymous | Default Ring: sender and recipient | Custom Rings are Solana programs that add a transfer policy, reporting, compliance and auditor visibility |
| **Private Channels** | All activity inside the channel | Deposits and withdrawals on mainnet | The operator decides whom to give visibility |

**What a perp protocol with private positions needs from this:** all five dimensions at once. That is why no single mechanism covers the task, and the construction is assembled from layers: aggregation gives participant anonymity, the TEE private execution, the on-chain program policies, 13F disclosure and a public coverage ratio audit.

**Rings as a candidate:** the closest of the official options to our construction (four dimensions natively), but it is a layer of **balances and transfers**, not an execution layer — it most likely does not cover a position's frequently changing state with margin recalculations. A realistic role is a deposit/margin layer, not a replacement for PER. Beta status; check three things in the Helius docs: whether a Custom Ring holds state with frequent updates, whether there is access from another program through CPI, whether the beta is fit for a demo.

**Private Channels as an anti-pattern and a reference at once:** a model with a trusted operator (RBAC, JWT, sequencer) — exactly what we do not want to be; but their **SMT exclusion proof** is a ready mechanism for forced on-chain withdrawal of funds independently of the off-chain layer, open under MIT. The shape of the architecture is the same as ours: on-chain escrow → private execution on the side → settlement back. So the Foundation itself ships this pattern as legitimate — a useful argument for the pitch.

### 3.3 Privacy vs anonymity

A wording worth reproducing exactly (used by both Aster and Vanish): **privacy is not anonymity.** Privacy is the invisibility of activity to outside observers; anonymity is breaking the link between a person and the funds. Vanish explicitly distances itself from mixers: the deposit↔withdrawal link is kept, only what happened inside is hidden.

For compliance this is fundamental: **transparent boundaries + a private middle + screening on entry and exit** is a construction that passes AML requirements; full unlinkability does not.

---

## Part 4. Mobility

| Product | Format | Solana stack | Privacy |
|---|---|---|---|
| **Jupiter Mobile** | Native app, #1 in the dApp Store | ✅ MWA, Seed Vault | ❌ |
| **Drift** | App, #4 in the dApp Store | ✅ | ❌ |
| **Pacifica** | Android app (July 2026) | ❌ not in the dApp Store | ❌ |
| **Aster Mobile** | Google Play + App Store | ❌ EVM wallet; a public complaint that Phantom does not work on Seeker; **not in the dApp Store** | ⚠️ hidden orders |
| **Lighter** | App Store + Google Play (`com.zklighter.app`) | ❌ | ⚠️ ZK rollup, not private positions |
| **Imperial** | A mobile session through a private link in the browser + Telegram bot | ❌ | ❌ |
| **Fensory, Cashflow** | Native Seeker apps (yield, xStocks) | ✅ | ❌ |

**Conclusion:** mobile perps exist; there are two Solana-native mobile perps (Jupiter, Drift) — both public; there are no private mobile perps anywhere.

---

## Part 5. Key mechanisms worth knowing when building

### 5.1 Omnibus (pooled account)
One position on a venue on behalf of many users; per-user accounting is off-chain or in a private layer. The source of privacy: **there are physically no per-user positions on-chain**, not encryption on top of public data.

Confirmed by a mainnet simulation on Jupiter Perps: owner validation passes with an off-curve PDA, `allowIncreasePosition = true`; the Position PDA is derived from (owner, pool, custody, collateralCustody, side) → one omnibus owner = one position per side.

**The price of the construction:** socialized risk. The venue liquidates the omnibus as a whole by aggregated margin, so we need our own internal liquidation that runs ahead, a higher per-user margin threshold and a cap on aggregated leverage.

**A second risk that is often missed: thin-market manipulation.** The JELLYJELLY case on Hyperliquid (March 2025, ~$12M of losses): an attacker opened a large position in an illiquid asset and moved the spot price to harm the counterparty pool. An omnibus on a thin market becomes a target of the same attack — and all participants of the aggregated position suffer. **The mitigation is simple and mandatory: trade only liquid markets (SOL, BTC, ETH), do not let the omnibus into the long tail.**

**A fourth property, specific to Solana: aggregation buys privacy at the price of serialization.** Transactions on Solana run in parallel only if they do not take write locks on the same accounts. The omnibus is one account per side, so all user actions compete for one lock, and the queue forms precisely under load. Mitigation: keep per-user state in separate PDAs (in PER it is separate anyway), and update the shared aggregate in batches through the crank, not on every action. This is checked by a load run, not by reasoning: real execution conditions on Solana depend on slot timing, account locking, compute limits and network congestion — a mathematical model does not predict them.

**A third requirement, from the Lighter lesson: an exit path that does not depend on us.** If the PER operator is unavailable or the protocol is stopped, the user must be able to prove their share of the omnibus and take it. Without this, privacy turns into dependence on our availability — and that is the first thing a technical reviewer will ask.

### 5.2 Session Keys
An ephemeral key pair as a second signer + a session-token PDA with expiry and scope. It allows trading without a wallet prompt for every action. Limitation: **SPL Token does not understand session tokens**, so token movement (a margin deposit) requires a separate signature and an approve to a limited program authority.

### 5.3 Asynchronous fill (keeper model)
In Jupiter Perps opening is not atomic: the CPI creates a position request, a permissioned keeper executes it in a separate transaction. Consequences: a delay between request and execution, the entry price is known only after the fact, a slippage parameter, a TTL on pending and handling of failed/expired are needed.

### 5.4 Disclosure after the fact (13F model)
A position is private while held and public after close. It gives audit, a verified track record and a leaderboard without the copy tax. The analogue is the quarterly position disclosure of institutional funds in the US.

### 5.5 Compliance layer
A working template on Solana (Vanish Integrity Framework): real-time screening of every deposit and withdrawal through **Elliptic** (AML, OFAC, sanctions lists) and **Range** (Solana-native monitoring, 90+ chains). Plus geofencing at the network-ingress level (the PER ingress in MagicBlock does IP geofencing and OFAC screening before the transaction executes) — this allows not collecting precise geolocation in the app, which matters for the dApp Store policy (precise geolocation = Regulated Data).

**Regulatory context 2026 (moving fast).** The CFTC approved BTCPERP as the first regulated perpetual contract and issued a no-action letter for converting perpetual-like products; at the same time CME is suing the CFTC, arguing that perps are swaps and should fall under Dodd-Frank. The expected direction is a split market: a regulated onshore version with lower leverage, identification and a right of appeal, and an offshore permissionless one with the opposite set. The practical conclusion: build geofencing and a compliance layer in from the start, write jurisdictional disclosures before launch.

### 5.6 Lessons from RAILGUN Relay Adapt (EVM, but the pattern carries over)

RAILGUN has kept in production for years a construction structurally identical to an omnibus: the external protocol sees only an intermediary contract behind which stands the private accounting of many users. Three details worth considering when building on Solana:

1. **A cookbook / recipes as a way of organizing code.** The typical sequence of calls to a venue (approve → action) is moved into a library of "recipes" that itself computes fees and builds the transaction fields. Translation: each venue's adapter should be a recipe, not a branch in the core — adding GMTrade or Flash should mean adding an adapter.
2. **An explicit and complete list of what returns to private accounting.** In RAILGUN everything not listed in `relayAdaptShieldERC20Addresses` cannot be recovered. Our analogue: when a position closes, the remaining margin, PnL and dust from partial closes must be explicitly accounted for — otherwise funds get stuck on the omnibus PDA without attribution to a user. A class of bugs that is hard to detect after the fact.
3. **The fee is charged before the action.** For them the 0.25% unshield fee reduces the amount before the swap, so all calculations are done from the post-fee amount. Same for us: the venue fee (6 bps at Jupiter) is charged before opening, and per-user accounting must operate on the net amount.

Plus a separate primitive worth carrying over: **view-only wallets** — access to view private balances without the right to spend. For us this is an audit of the omnibus by a partner and a way for a trader to share their position without handing over keys. In PER it is implemented by a permission list.

### 5.7 Lessons from Aztec (EVM L2, a pattern and a regulatory precedent)

**Programmable privacy** is the exact name of the construction we are heading towards: open and closed data are combined within one system, and the protocol itself decides what is public. In Aztec a contract can reveal the number of DAO participants while hiding the specific addresses. Our analogue: a public omnibus aggregate (coverage ratio, total exposure) with private per-user positions.

**Separating the rights "to see" and "to spend".** In Aztec three key pairs are tied to every address: a nullifier key (spending a note), an incoming viewing key (decrypting incoming), an outgoing viewing key (tracking outgoing). For us this is the design of the permission list in PER: owner (changes the position), viewer (auditor, partner, tax service — sees, does not touch), optionally a delegated trader. Implemented by configuration, not cryptography.

**The regulatory lesson — the most important.** Aztec Connect (a private gateway to DeFi) shut down in March 2023, about half a year after the US sanctions against Tornado Cash; FTX blocked accounts for transfers through it. Under MiCA European exchanges delisted anonymous assets (Monero). The key conclusion of observers: combining public and private state is an **option for compliance**, because it gives the regulator a control point; Aztec Connect technically had no such point, and that became its vulnerability.

This is the third independent proof of the same thesis after Vanish (transparent boundaries + screening) and the 13F model: **full opacity is a regulatory risk, selective transparency is a regulatory advantage.** Our configuration (a private position while held, a public aggregate always, full disclosure after close) is not a compromise for convenience but the most robust one possible.

**An argument against our own stack.** Aztec requires a new language (Noir) and is incompatible with EVM; observers openly ask whether it will repeat Starknet's trajectory — a loud launch and a decline due to a lack of demand for that level of protection. The same applies to Paradex and Aster Chain. Our choice is the opposite: a private layer on top of an existing ecosystem, without migrating traders and without a new language.

### 5.8 Prop AMM: Solana has already chosen opacity where it gives a better price

**HumidiFi** is the largest Solana DEX by volume: >$1B per day, ~35% of all spot DEX activity; integrated into Jupiter, DFlow, Titan, OKX Router. It is a **proprietary AMM**: quotes are generated off-chain by an HFT model from real market data and internal risk metrics, while settlement, custody and accounting stay on Solana.

The justification for closedness is their own: **opening internal market-making logic historically leads to predatory flow and toxic MEV, which worsens outcomes for retail users.** Instead of blocking addresses, their engine adapts to bad behaviour in real time.

The structural shift this created: **prop AMMs are now ~75% of Solana DEX volume** (of which HumidiFi is over 60%), and the segment grew from <10% to >70% share in about a year.

**Why this is the strongest market argument for privacy in trading.** Three quarters of Solana spot volume already executes against non-public logic — and the market gained from it: tighter spreads, fewer failed transactions, worse conditions for toxic flow. Pricing transparency turned out to be not a value but a vulnerability.

A wording for the pitch: *Solana has already chosen opacity where it gives a better price. We do the same from the other side of the table — we hide not the market maker's quote but the trader's position.*

**A practical note:** HumidiFi is building a "universal liquidity layer" with issuer-centric pools managed by separate desks. If the omnibus ever needs better execution than the Jupiter pool, this is a potential partner, not a competitor.

**Careful with domains:** there is an SEO clone `humidifi.trade` that poses as a perp DEX with its own "EDGE chain", StarkEx and a direct APK link. The real site is `humidifi.xyz`.

### 5.9 Patterns from GMX (the EVM benchmark of the pool model; GMTrade on Solana is its fork)

**Delegated trading is documented as a supported scenario.** The GMX docs have a separate section "Delegated trading integration" for those building delegated or one-click trading on top of the protocol. So the pattern "a program trades on behalf of a user" is not a hack but an official integration path. Since GMTrade on Solana is a GMX V2 fork, their delegation model may carry over.

**GMX Account — a direct analogue of the omnibus by vocabulary.** A separate trading balance on Arbitrum tied to the same wallet; deposits from other chains are bridged automatically (Stargate + LayerZero). The key wording from the docs: these are **two ways of providing funds for positions, not two separate position accounts** — positions belong to the wallet regardless of the margin source. Ready language for explaining our construction.

**One-Click Trading — the EVM analogue of Session Keys, with a security model worth copying:**
- the sub-account key is stored locally, trades are signed automatically;
- **funds from closing positions can return only to the user's own wallet**;
- **the number of actions without a signature is limited by an authorized limit** (authorized 10 — after the tenth, a signature window again);
- an honestly named risk: compromise of the environment = key leak, and the action limit is the only insurance.

The last point is an addition to our session-token PDA: we had expiry and scope, but no limit on the number of actions.

**Per-market staleness thresholds.** Oracle price freshness in GMX is not one constant but a per-market parameter: from 15 seconds (stocks, indices) to 280 seconds (natural gas off-hours). Plus off-hours thresholds apply for another 10 minutes after the market opens, so as not to reject reports at the transition. For our liquidation crank this means: the price staleness threshold must be configured per market, not set globally.

**An argument for the pain slide from the incumbent.** The first paragraph of their docs: GMX uses oracle pricing from aggregated exchange data, **which reduces the risk of liquidation from temporary wicks**. The largest pool perp DEX of the EVM world names wick liquidations as a problem it was specifically designed to avoid.

**Dynamic risk parameters as an example of maturity.** For TradFi markets GMX switches configuration between on-hours and off-hours: lowers max leverage (100x → 25x on gold), raises the liquidation factor (0.5% → 0.8%), increases fees and borrow, narrows open-interest limits. The interface warns when a position may approach liquidation after the switch. For us this is a model of how the omnibus caps should behave in periods of low liquidity.

---

## Part 6. Summary matrix

| Cell | State on Solana |
|---|---|
| Public perps, peer-to-pool | ✅ Jupiter, GMTrade, Flash, Adrena; **Percolator** (deployed, formally verified, permissionless) |
| Public perps, CLOB | ✅ Pacifica, Velocity, Margin, Phoenix |
| Perp routing/aggregation | ✅ Ranger (from the wallet), Imperial (contract owner) |
| Private transfers / deposits / DCA | ✅ Privacy Cash, Turbine, Vanish |
| Private messages | ✅ Cherry |
| Private network traffic | ✅ UR Network |
| Confidential computation | ✅ Arcium (MPC), MagicBlock PER (TEE) |
| Mobile perps | ✅ Jupiter Mobile, Drift (public) |
| Private pricing logic (prop AMM) | ✅ HumidiFi and others — ~75% of DEX volume |
| **A private leveraged position** | ❌ **empty** |
| **A private perp in the dApp Store / on Seeker** | ❌ **empty** |

---

## Sources

Soladex (project reviews, updates July–September 2026): Lavarage, Margin, Flash.Trade, Phoenix, Imperial, Ranger, Fensory, Cashflow, Cherry, Vanish, Turbine Cash, Arcium, Privacy Cash · DefiLlama (perps/chain/solana) · awesome-perp-dex (GitHub, curated list 2026) · Messari/Blockworks (Paradex) · The Defiant (Aster hidden orders, Aster Chain) · Solana Mobile Docs and Publisher Policy (21.07.2026) · MagicBlock Docs (PER, Session Keys, Pricing Oracle, prediction markets guide) · Google Play (Aster Mobile, Lighter) · the official x402 and Agent Registry pages on solana.com · Arcium Docs (MXE, Arx nodes, Cerberus detect-and-abort, Arcis, "Private DeFi: encrypted positions" as the canonical use case) · GitHub org flash-trade (flash-perpetuals as a fork of solana-labs/perpetuals, flash-sdk-rust, MagicBlock session-keys fork, magicblock-grpc-example, MCP) · Solana Docs, "Privacy for Financial Applications" (five dimensions, Confidential Balances / Rings / Private Channels), "Private Channels" (SMT exclusion proof, MIT, Foundation GitHub), "Confidential Balances" (auditor keys, proof accounts), "MEV Protection with Jito DontFront" · Solana Docs, "Add Solana to Your Exchange" (priority fees on write-locked accounts, blockhash expiration, versioned tx v1, Token-2022 Confidential Balances) · Bullet docs (network extension on Solana, 0.1 ms execution, built-in perps/spot/lending) · Zeta Markets docs (shutdown disclaimer, May 2025; $15B+ volume, CLOB, SDK/CPI) · crypto.news, "What is a perp DEX? The three architectures, compared" (July 2026) — the risk chain with ADL, leverage arithmetic, regulatory snapshot · Logarithm Finance, "PerpDex Design Overview" (November 2024) — evolution of base layers, matching classification, pools vs books on public chains, vaults, the wash-trading caveat and the volume/TVL metric · Bitium Blog, "Learn the Architecture of Perpetual DEXs + How to Build One" (October 2025) and "On-Chain Copytrading in 2026: Perpetual DEX Vaults" (January 2026) — the three-layer frame, infrastructure trade-offs, Lighter's trustless exit · MEXC/BitcoinEthereumNews — Percolator (Anatoly Yakovenko, sharded slabs) · Incrypted, "Derivative platforms: how they work" (August 2026) — architecture classification, fees, Bluefin, the JELLYJELLY case · GMX Docs (trading overview, delegated trading, One-Click Trading, TradFi risk windows) · ApeX Omni (2026 reviews: zkLink X, multichain, Solana as a deposit chain) · HumidiFi Litepaper (humidifi.xyz — prop AMM, market shares) · Aztec (architecture overview: PXE, notes/nullifiers, three keys, portals; Aztec Connect history) · RAILGUN Developer Guide (cross-contract calls, Cookbook, view-only wallets) · our own mainnet simulation of Jupiter Perps (September 2026).

**Caveat:** volumes, fees and protocol statuses change quickly; some numbers are from secondary sources. Check primary sources before using them in public materials.
