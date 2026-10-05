# Perp DEX reference architecture on Solana

What every protocol in this category must have — regardless of the pricing model and the privacy layer. Written from a solution architect's point of view: invariants first, then components, then Solana specifics, then a checklist.

---

## 0. Three invariants everything follows from

A perp DEX is a system that keeps three promises at once:

1. **Solvency.** At any moment the sum of what the protocol owes traders and LPs does not exceed what it has. Every component below exists either to maintain this condition or to distribute losses fairly when it is broken.
2. **Fair price.** A position is opened, valued and closed at a price that neither a participant nor the operator can manipulate.
3. **Deterministic liquidation.** A position that is no longer collateralized is closed on time and by rules known in advance.

Everything else — funding, fees, orders, UI — serves these three.

---

## 1. Margin engine (accounting core)

The heart of the protocol. It lives fully on-chain (or in an SVM rollup that commits to L1).

### Entities

| Entity | What it stores |
|---|---|
| `Market` | Asset, oracle, risk parameters (max leverage, IMR, MMR, OI cap), funding state, price index |
| `Pool` / `Custody` | Collateral reserves, liabilities, LP shares, insurance fund |
| `UserAccount` | Collateral, margin mode, references to positions |
| `Position` | Market, side, size, entry price, accumulated funding, open time |

### What the engine must compute deterministically

- **Unrealized PnL** = `size × (mark − entry)`, taking the side into account
- **Equity** = `collateral + unrealizedPnL − pendingFunding − pendingFees`
- **Initial Margin** (IMR) — the minimum to open/increase
- **Maintenance Margin** (MMR) — the minimum to hold; below it → liquidation
- **Liquidation price** — the solution of the equation `equity(price) = MMR × notional`

### Margin modes

- **Isolated** — collateral is tied to the position. Simpler, isolates risk, worse capital efficiency.
- **Cross** — one collateral for all of the account's positions. Harder liquidation (which position to close first), better UX for active traders.

An MVP almost always starts with isolated.

### Arithmetic

- Only fixed-precision integers (u64/u128, `checked_*` operations).
- An explicit rounding direction: **in the protocol's favour** in every formula (fees up, payouts down). This is not a detail — rounding asymmetry over millions of operations becomes a vector for draining reserves.
- Separate decimals for price, size, collateral; conversion in one place.

---

## 2. Price layer (oracle & price semantics)

A perp has no price discovery of its own by definition (it is a derivative), so the price comes from outside. A mistake here is the most common cause of lost funds in the category.

### Sources

- **Pyth** (pull model: the client brings a signed update into the transaction; Lazer for low latency)
- **Switchboard** as a fallback/aggregation
- Our own **Pricing Oracle inside the ER**, if the architecture is on MagicBlock

### Two prices, not one

| Price | What for | Source |
|---|---|---|
| **Index** | What the asset is "really" worth | Oracle, CEX/spot aggregate |
| **Mark** | What positions are valued at and what triggers liquidation | Index + premium/EMA; smoothed, resistant to spikes |

Liquidating at a raw oracle print is a mistake: a single 2% spike for 400 ms wipes out hundreds of positions that would have been alive a second later.

### Mandatory checks on every read

- **Staleness**: `now − publish_time ≤ max_age` (typically 10–30 s for L1, less in an ER)
- **Confidence interval**: if `conf / price > threshold` — do not open new positions, liquidate carefully or pause
- **Deviation guard**: a difference between two sources > X% → pause the market
- **Status**: Pyth `Trading` vs `Halted`/`Unknown`

### Execution: entry price ≠ mark

- **Price impact** as a function of `size / available liquidity` (pool model) or of book depth
- **Spread** to cover the maker's/pool's risk
- An explicit **max slippage** from the user — an invariant the program checks, not the UI

---

## 3. Pricing and counterparty model

A fundamental choice that determines half of the rest of the architecture.

| Model | Who is the counterparty | Price | Pros | Cons | Examples |
|---|---|---|---|---|---|
| **Peer-to-pool** (oracle-priced) | LP pool | Oracle + impact | Simple, deep from day one, deterministic | LPs hold directional risk; no price discovery | Jupiter, Flash, Adrena, GMX |
| **vAMM** | Virtual curve, pool as backstop | Curve | Needs no makers | Hard calibration, risk of diverging from index | Perp v1, Drift v1 |
| **CLOB** | Other traders/makers | Book | Real price discovery | Cold start, dependence on makers, MEV | Phoenix, Bulk, dYdX |
| **RFQ** | A specific maker | Best quote | Price discovery without a public book; compatible with privacy | Needs real makers | Variational, Bullet |
| **Hybrid** | Pool + book/RFQ | Mixed | Best UX | Most complex | Drift v2, Jupiter+HumidiFi |

The Solana Foundation (June 2026) explicitly prioritizes models with two-sided flow (CLOB, RFQ) over pool models. For an MVP the pool remains the most realistic; RFQ is a natural v2.

---

## 4. Liquidity, pool risk and loss distribution

### Sources of capital

- **LP pool** with shares (a JLP-like token): income = fees + borrow + traders' PnL (inverse)
- The protocol's **own capital** (at launch often the only LP)
- **Insurance fund** — a separate buffer, replenished from fees and liquidation penalties

### Bad debt coverage cascade (must be defined in advance)

1. Position margin
2. Liquidation penalty / buffer
3. Insurance fund
4. **ADL** (Auto-Deleveraging): forced closing of profitable positions on the opposite side, ranked by profitability × leverage
5. **Socialized loss**: a proportional haircut for everyone

The alternative is **senior/junior** (Percolator): deposits are a senior claim, unrealized profit is junior; nobody withdraws more than exists. It removes the need for an insurance fund at the cost of a winner possibly receiving less than face value.

### Limits

- **OI cap** per market (absolute and relative to the pool)
- **Max position size** per account
- Pool **utilization cap**
- **Skew limits** — the maximum long/short asymmetry

---

## 5. Funding

The mechanism that keeps mark near index in the absence of delivery arbitrage.

- **Premium index** = `(mark − index) / index`, averaged over an interval
- **Rate** = `clamp(premium + interest, −cap, +cap)`
- **Interval**: 1 h is standard; on fast markets — continuous per-slot accrual
- **Direction**: the skewed side pays the opposite side (or the pool in peer-to-pool)
- **Implementation**: a global cumulative index `cumulative_funding_rate` on the market; a position stores a snapshot at open; `pending = size × (current − snapshot)`. Never iterate over positions to accrue.

---

## 6. Liquidation engine

### Trigger

`equity < MMR × notional` at the **mark** price, with hysteresis so the position does not flap at the boundary.

### Partial vs full

- **Full** — simpler, worse for the trader
- **Partial** — close enough to bring margin back above IMR + a buffer; requires an iterative calculation

### Who executes

| Model | Pros | Cons |
|---|---|---|
| **Permissionless liquidators** (bots for a reward) | Decentralized, self-organizing | Requires public positions; race conditions; MEV |
| **Permissioned keeper / crank** | Deterministic, compatible with privacy | Single point of failure; needs an SLA and a trustless fallback |

A private perp is forced by definition to choose the second — and therefore must have a **trustless exit**: the user can always close/withdraw through the base layer if the crank is dead.

### Economics

- **Liquidation fee** (0.5–2% of notional) → part to the liquidator, part to the insurance fund
- Closing order under cross margin: the riskiest position first
- Log every liquidation as an event with the reason and prices

### Latency

On L1 — a 400 ms slot + a queue. The real delay from crossing the threshold to execution: 1–3 s in a calm market, more under load. This determines the size of the MMR buffer. In an ER (10–50 ms blocks) the buffer can be reduced substantially — a direct economic gain for the trader.

---

## 7. Fees

| Fee | When | Typical |
|---|---|---|
| Open / close | On notional at entry/exit | 5–10 bps |
| Borrow / hourly | On notional for the holding time (peer-to-pool) | 0.005–0.02%/h |
| Funding | Between sides | Dynamic |
| Liquidation | On liquidation | 0.5–2% |
| Price impact | Implicit, in the price | A function of size |

**Routing** — defined in the program, not in governance: the share for LPs / insurance fund / treasury / (per the foundation's thesis) the base layer.

---

## 8. Order types and execution

Solana has no native scheduling, so anything that does not execute instantly requires a keeper.

- **Market** — atomically in one transaction
- **Limit / Stop / TP / SL** — an on-chain record + a keeper that triggers on price; a reward for the keeper
- **Request → Fill** (two-phase): the user creates a request, a keeper executes it at the next oracle price. Protects against front-running and oracle manipulation in the same transaction. Standard in Jupiter/GMX.
- **Reduce-only**, **post-only** — flags the program must enforce

---

## 9. Solana account model specifics

### PDA design

```
Market        [b"market", market_id]
Pool          [b"pool", pool_id]
Custody       [b"custody", pool, mint]          ← token vault
UserAccount   [b"user", owner]
Position      [b"position", owner, market, side]   ← or an index for several
Order         [b"order", owner, nonce]
```

### Limits and consequences

- **10 MB max account**, but in practice: `zero_copy` for large structures, `Box<Account>` on the Anchor stack
- **Compute budget**: 200k CU default, up to 1.4M on request. A liquidation with an oracle and several CPIs easily eats 300–500k — the budget must be set explicitly
- **Contention**: a hot account (pool, market) in every transaction = serialization. Mitigations: batching, splitting into shards, moving into an ER
- **Rent**: ~0.002 SOL per 200–300-byte position; at scale — a cost line; close closed positions and return the rent
- **Versioned tx + Address Lookup Tables**: mandatory when a transaction has > 30 accounts (oracles + custody + positions)
- **Token-2022**: support it if the collateral may have extensions; Confidential Balances is a separate story

### Anchor constraints as the first line of security

- `has_one`, `seeds`, `bump`, `constraint =` on every account
- Owner checks on all external accounts (oracle, token accounts)
- Never trust `remaining_accounts` without explicit validation

---

## 10. Keeper / crank infrastructure

An off-chain component without which the on-chain program does not work. It must be in the architecture document as a first-class citizen.

| Task | Frequency | Who |
|---|---|---|
| Liquidations | Every slot / ER block | Crank |
| Funding index update | Interval | Crank, or lazily on first interaction |
| Limit/stop execution | Reaction to price | Keeper |
| Oracle pull updates | Before every action | Client or crank |
| ER → L1 state commit | Interval / threshold | ER operator |

Requirements: idempotency, retries, lag monitoring, alerts, **and a documented scenario for when the crank is dead**.

---

## 11. Administration and governance

- **Upgrade authority** → a multisig (Squads), not a single key
- **Timelock** on risk parameter changes
- **Guardian / pause** — a separate key with the right only to stop (opening new positions), not to change
- Market parameters in an account, not in code: change without a redeploy
- A public changelog of parameters

---

## 12. Security

### Perp-specific vectors

- **Oracle manipulation** in the same transaction → two-phase execution or a `publish_time` check
- **Sandwich on open/close** → max slippage + Jito bundles / DontFront
- **Rounding drain** → audit the rounding direction in every formula
- **Bad debt from an insufficient MMR** → stress tests on historical volatility
- **Stale funding index** → lazy update on every interaction with the market
- **Liquidation griefing** → minimum position size, a limit on the count
- **CPI reentrancy** (not in Solana in the classic sense, but possible through callback patterns)

### Process

- Formal verification of core invariants where possible (Percolator as an example)
- Fuzzing of the margin math (`proptest`)
- An independent audit **before** real money — no exceptions
- Bug bounty
- A public threat model document

---

## 13. Observability and indexing

- **Anchor events** on every state change: open, close, liquidate, funding_settle, deposit, withdraw
- **Indexer** (Helius webhooks / Geyser / our own) → position history, PnL, volumes
- **Public pool metrics**: TVL, OI, utilization, coverage ratio, insurance fund
- A keeper status dashboard: lag, errors, last successful crank

For a private perp: events remain, but aggregated; per-user history is only for the owner (or after disclosure).

---

## 14. Client and SDK

- **IDL** published; TS SDK generated (Codama/Anchor)
- Building a transaction with: oracle update, ALT, compute budget, priority fee
- **Simulation** before sending — mandatory for perps (show the user the liquidation price before signing)
- Handling asynchronous fills (request → fill): a "pending execution" UI state
- Mobile: MWA + Session Keys, so as not to sign every action

---

## 15. Compliance and boundaries

- Geo-blocking on the frontend (not in the program — it is permissionless)
- Address screening on deposit/withdrawal (Chainalysis/TRM API or an on-chain registry)
- Terms of use, leverage disclaimers
- For private protocols: an explicit disclosure model (to whom, when, what) — this is part of the architecture, not a legal appendix

---

## 16. Checklist "protocol ready for real money"

**Core**
- [ ] All margin formulas in one module with edge-case tests
- [ ] Rounding direction documented and verified
- [ ] Bad debt cascade defined and implemented to the last step
- [ ] Funding through a cumulative index, no iteration

**Price**
- [ ] Mark ≠ raw oracle; there is smoothing
- [ ] Staleness, confidence, deviation — checked on every read
- [ ] Two-phase execution or equivalent protection against oracle manipulation

**Liquidation**
- [ ] Trigger by mark, with hysteresis
- [ ] Partial liquidation or a justified refusal of it
- [ ] Trustless exit on keeper failure
- [ ] MMR stress test on the asset's historical volatility

**Solana**
- [ ] A PDA scheme without hot spots or with a contention mitigation plan
- [ ] Compute budget set explicitly on heavy instructions
- [ ] ALTs for transactions with many accounts
- [ ] Anchor constraints on every account

**Operations**
- [ ] Keeper is idempotent, monitored, has a failure runbook
- [ ] Upgrade authority is a multisig; guardian separate
- [ ] Risk parameters in accounts, with a timelock

**Security**
- [ ] Independent audit
- [ ] Fuzzing of the margin math
- [ ] Public threat model

**Transparency**
- [ ] Open-source core
- [ ] Public solvency metrics
- [ ] Indexer and event history

---

## Appendix: where a private perp deviates from the reference

| Component | Reference | Private perp |
|---|---|---|
| Liquidators | Permissionless bots | Permissioned crank in a TEE + trustless exit |
| Positions | Public PDAs | Delegated into PER, read by permission |
| Metrics | Per-market long/short OI | An aggregate without a split by side; coverage in buckets |
| History | Public | Disclosure after the fact (13F model) |
| Indexer | Reads everything | Reads only public events and aggregates |
| Push notifications | A backend watches positions | Locally in the client or a notifier inside the TEE |
| Limit/stop orders | Public record + keeper | A record in the ER; keeper = the same crank |

Everything else — the margin math, oracle discipline, the bad debt cascade, governance, audit — stays unchanged. Privacy is a layer over the reference, not a replacement for it.
