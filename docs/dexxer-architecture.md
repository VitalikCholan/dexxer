# Dexxer — architecture document (Solutions Architecture)

**Date:** 12 September 2026 · **Author role:** solutions architect in the Solana ecosystem · **Status:** design before the first line of code
**What we are building:** a private mobile perp for Seeker — our own perp core with positions in MagicBlock PER (Option 2, §2.1). The omnibus over an external venue (Option 1) remains as a second liquidity adapter for v1.
**Section status:** §0–§2 and §6–§10 are current for both options; **§2.1 is the target MVP architecture**; §1 and §3–§5 describe Option 1 and are to be read as the specification of the external adapter.

---

## 0. Constraints that drive every decision

| Constraint | Consequence |
|---|---|
| Solo developer, 4 weeks to demo | Every component is either off-the-shelf (venue, PER, MWA) or minimal. No in-house matching, pool or oracle |
| Privacy without custody is the main promise | Keys never leave Seed Vault; no server signs on the user's behalf; the backend is not a point of failure for funds |
| Public chain (Solana), not our own | Pool-based liquidity model (see landscape 1.7); distributed matching is unavailable; account contention is a reality |
| The venue is asynchronous (keeper) and liquidates the omnibus as a whole | Request state machine; two-layer liquidation; ADL allocation |
| Mobile UX | One tap via Session Keys; push; private-state read latency < 100 ms |

**Principle #1:** the on-chain program is the single source of truth for money; the backend is an accelerator and a convenience that can go down without loss to the user.
**Principle #2:** everything that can be made idempotent and retryable is made so. Keeper, crank, indexer, push — all must survive a restart.

---

## 0.1 Perp DEX ≠ HFT: what class of system we are building

A mistake in this framing costs weeks spent on the wrong problem.

**The HFT framing applies to venues with their own matching.** Hyperliquid, Bullet (0.1 ms), Pacifica (sub-20ms), Lighter compete on latency not out of vanity: a market maker will not quote a tight spread if it cannot cancel an order quickly (in an HFT flow, cancel/replace is 90%+ of messages). That is exactly why they all built their own execution layer.

**Pool-based venues are not HFT in any sense.** Price comes from the oracle, there is no matching, nothing to cancel. On Jupiter, opening is asynchronous altogether — and it works at billions in volume.

**Dexxer is a highly available event-driven ledger with a soft real-time risk loop.** A user takes one action every few minutes or hours. But three paths are time-sensitive after all, and confusing them with the rest is dangerous:

| Path | Class | Requirement |
|---|---|---|
| Liquidation crank | **soft real-time** | Fire before the venue does: within the time it takes price to traverse our margin buffer. Seconds, not minutes |
| Oracle freshness | soft real-time | Per-market staleness thresholds (GMX lesson: 15–280 s depending on the market) |
| Buyback quote | hard real-time | The moment we name a price we become a market maker, and latency means getting sniped. **That is why there is no secondary market in the MVP** |
| Everything else (open, close, reads, history) | best-effort | A one-second delay is acceptable |

**The load profile is not throughput but a correlated burst.** A thousand users with a few actions a day is a trivial flow. The problem: a sharp price move → everyone closes at once → the crank liquidates several at once → and everything writes to accounts that serialize. So our problem class is **a burst under correlated load with a write-lock constraint**, and it is cured with batching, priority queues, idempotency and backpressure, not kernel bypass and colocation.

**Two mirror-image mistakes we avoid:** optimizing latency like HFT (four weeks burn, no product) and treating the crank as an ordinary once-a-minute cron (we get wiped out on the first volatile weekend).

---

## 1. Architecture at a glance

```
┌──────────────── Mobile client (Expo / React Native, Android) ───────────────────┐
│  MWA connect · Seed Vault signature (deposit) · Session Key (trade) · push       │
│  reads the private position directly from PER via QFS (token = challenge sig)    │
└───────────┬─────────────────────────────────────────────────────┬────────────────┘
            │ RPC (own layer: 2 providers, fallback)              │ HTTPS (read-only)
            ▼                                                     ▼
┌───────────────────── Solana base layer ─────────────┐   ┌──── Backend (NestJS) ───────────┐
│  Dexxer Core program (Anchor)                       │   │  Indexer (Yellowstone gRPC /     │
│   ├─ UserVault / Margin PDA (public, per-user)      │◄──┤   Helius webhooks) → Postgres   │
│   ├─ OmnibusState PDA (aggregate, per market+side)  │   │  Crank runner (BullMQ):          │
│   ├─ SessionToken PDA (expiry, scope, action cap)   │   │   settle_fill · margin check ·   │
│   └─ Venue adapters ── CPI ──► Jupiter Perps /      │   │   internal liquidation ·         │
│                                GMTrade / Flash      │   │   aggregate batcher · disclosure │
│                                    ▲ keeper fill    │   │  Push service (Expo)             │
└────────────────────────────────────┼────────────────┘   │  Compliance gate (Elliptic/Range)│
                                     │                    └──────────────────────────────────┘
┌──────────── MagicBlock PER (TEE, 10–50 ms) ─────────┐
│  UserPosition PDA (private: size, side, entry,      │
│   margin, state) — EphemeralPermission: owner+viewer │
│  Pricing Oracle (Pyth Lazer in the ER)               │
│  Aggregate commit to the base layer in batches       │
└──────────────────────────────────────────────────────┘
```

**Who knows what:**
- The venue sees: one position per side from the omnibus PDA.
- The base layer sees: user deposits/withdrawals (public boundaries), the omnibus aggregate, session tokens.
- PER sees: per-user positions — only the owner and designated viewers.
- The backend sees: events and aggregates; **it does not see private positions** (it reads from PER only what it has permission for — i.e. nothing but aggregates).

---

## 2. Architectural approaches: two paths to a private perp

There are two fundamentally different ways to get a private leveraged position on Solana. They diverge on one question — **where the position lives**: on someone else's venue or in our program. Half of the architecture depends on the answer.

### Option 1 — Omnibus over someone else's venue (described in detail in §1, §3–5)

Our program holds one aggregated position on Jupiter / Flash / GMTrade / Adrena; per-user shares live in PER. The liquidity is someone else's, the privacy is ours.

| + | − |
|---|---|
| Zero own capital at risk; billions in liquidity from day one | Positions on someone else's venue → **the omnibus is mandatory**, otherwise the per-user record is public |
| We build neither a pool, nor an oracle integration, nor an insurance fund | Asynchronous keeper (Jupiter) → request state machine, entry price after the fact |
| We do not compete with the venue — we sit on top of it | The venue liquidates the omnibus as a whole → two-layer liquidation that has to front-run it |
| No solvency risk on us | ADL cuts the aggregated position → an allocation rule among participants |
| | One omnibus account → account contention, sharding, batching |
| | Dependence on the venue's ToS, API and survival (Drift: −$295M overnight) |

### Option 2 — Own perp DEX core + PER

We fork or build our own perp engine: pool, margin, funding, liquidations. Positions are accounts of **our** program, so they can simply be delegated into PER as separate private PDAs. Privacy becomes a natural property rather than a consequence of aggregation.

| + | − |
|---|---|
| **No omnibus needed** — per-user positions are private in PER directly | **The liquidity is ours**: LPs or own capital at risk, insurance fund, borrow curve |
| Gone: request state machine, after-the-fact price attribution, two-layer liquidation, ADL allocation among foreign shares | We are the trader's counterparty; a period when traders are right is our loss by design |
| Atomic fill, deterministic state, full control over risk parameters | Own oracle path, own liquidations, own backstop — everything the venue did in Option 1 |
| No dependence on someone else's ToS, API, keeper | Liquidity cold start — the same one that killed PsyOptions and Friktion |
| Privacy without aggregation → contention only on pool state, not on positions | We compete with Jupiter/GMTrade for traders and LPs rather than sitting on top of them |

**What stays common to both options:** PER for private state, Session Keys, the mobile front end, the compliance gate, 13F disclosure, the liquidation crank as a soft real-time loop.

### Fork candidates for Option 2

| Candidate | What it is | + | − | Role |
|---|---|---|---|---|
| **Percolator** (`aeyakovenko/percolator-prog` + the `percolator` crate, Yakovenko) | Risk engine v16 with **formal verification (Kani)**; one market = one slab account with an asset array; built for **Anchor v2 / Pinocchio**, platform-tools 1.52; LiteSVM, fuzz | The freshest toolchain; **"a predictable alternative to ADL"**: profit is a junior claim, deposit is senior, nobody withdraws more than exists (closes our ADL allocation problem at the design level); composable instruction set with a documented CPI binding; ecosystem — Percolator Launch (devnet), Syntx; Yakovenko's name for the judges | **"Educational research project, not production ready, not audited"** in big letters in the README; coin-margined (you deposit the token you trade) — check whether USDC margin exists | **Primary candidate.** To check: USDC margin, delegation of position accounts into PER, builds under our toolchain |
| **`solana-labs/perpetuals`** (Apache-2.0) and the **Flash**, **Adrena** forks | The official reference of the pool model; ~5.5K lines; audit report in the repository; taken to production twice | Simple, readable in a day, USDC-like custody; Adrena is potentially the most current fork with 2024–26 mainnet experience and no request fulfilment | The original is archived, 3 years old, Anchor 0.28.0, solana-program 1.16.9, pyth-sdk-solana 0.8.0 (outdated Pyth v1) → migration; Adrena's openness to be checked | Reference for pool math; fork — if Percolator does not fit |
| **Drift `protocol-v2`** (archived 03.09.2026 → `velocity-exchange/protocol-v2`, Anchor 0.29) | The most complete open perp DEX: DLOB, AMM, JIT, funding, liquidations, insurance fund, spot margin, vaults | It has everything | Tens of thousands of lines; toolchain Rust 1.70 / Solana 1.16; repository in a transitional state after the exploit | Reference for liquidation logic and the insurance fund, not a base for a solo dev in 4 weeks |
| **Brute** (`divi2806/brute`, 2026) | Hackathon devnet perp: vault custody, positions, funding, liquidation, fees; Pyth Hermes + on-chain verification; indexer; TP/SL keeper | Modern toolchain, a full set of components in a small footprint | Hackathon quality, license unknown | Reference for a modern stack, not a fork |
| **Syntx** (`psyto/syntx`, Apache-2.0) | Vault layer on top of Percolator with a VenueAdapter (6 methods), JupiterPerpsAdapter with TradeCpi, intent router, 32+ LiteSVM tests | An example of integrating with Percolator via CPI; ready-made adapters should an external venue ever be needed | Not a core; different privacy model (encrypted intent, trusted solver) | Source of adapters and tests |

### Rejected options (common to both options)

| Option | Why not |
|---|---|
| **Hybrid with a coordinator** — the backend holds an intent queue and submits to the program in its own name | The backend becomes critical and semi-custodial; we take aggregate batching as an element, not as the architecture |
| **API-first** (Bullet, Pacifica model) — a server signs requests to the venue | Directly contradicts "privacy without custody"; aggregation = we hold the key, no aggregation = no privacy |

### Choice

**Decision (updated, September 2026): primary is Option 2.** The reasons that accumulated after going through the MagicBlock documentation and the landscape:

1. **Ephemeral accounts** give "no per-user record exists" without an omnibus — the last structural advantage of Option 1 is gone.
2. **Option 1 lives only on mainnet or on a fork with an emulated keeper** (there is no Jupiter Perps on devnet), i.e. the riskiest part — the asynchronous fill — is exactly the part that cannot be tested honestly. Option 2 is fully testable on devnet, where PER, MWA and the oracle already exist.
3. **The risk engine in our own core lives inside the ER**; in Option 1 half of the system stays on the base layer with 400 ms and contention.
4. **Privacy becomes a property of the architecture**, not a consequence of aggregation — this pitches an order of magnitude better and does not require ADL allocation among foreign shares.
5. **NEAR × Hyperliquid took the Option 1 cell in September 2026** (Confidential Intents + Chain Signatures over an external venue) — there is no point competing there.

**The hybrid is kept as a framework:** the liquidity source is an adapter, not the foundation. Our own core is the first implementation of the interface; an external venue is the second, for large positions in v1, once there is an audit and capital. The gate "does CPI to someone else's venue work" stops being a demo blocker.

**Condition under which the decision holds:** check #1 from §2.1.12 — whether Percolator position accounts can be delegated into PER without rewriting the slab structure. If not, the base is not Percolator but the MagicBlock trading template + math from `solana-labs/perpetuals` (see §2.1.11).

---

## 2.1 Option 2 in detail — the target MVP architecture

*This section was written after a full review of the MagicBlock documentation (ER, PER, Ephemeral Accounts, Ephemeral SPL Token, Magic Actions, oracle, fees) and of the Solana privacy landscape. It replaces §1 and §3–5 wherever they describe the omnibus.*

### 2.1.1 The key change: the position does not exist on the base layer

MagicBlock ephemeral accounts are accounts that are created inside the rollup, live there and are closed there, **never being committed to Solana**. This removes Option 1's last structural advantage ("a per-user record physically does not exist"): now our own core has it too.

Consequence for the leak model: an action on a delegated account executes in the ER and **does not appear on L1**. The document previously assumed that every action leaves a trace on the base layer — that is wrong for delegated state.

### 2.1.2 Account layout

| Account | Type | Where it lives | Committed to L1 | Privacy |
|---|---|---|---|---|
| `Market` (parameters, cum_funding, OI limits) | Delegated | ER | Yes, in a batch | Public |
| `Pool` (collateral, coverage) | Delegated | ER | Yes, in a batch | Public aggregate |
| `UserAccount` (margin balance, sponsor for ephemeral accounts, nonce counter) | Delegated, **sponsor** | ER | Yes, rarely | `EphemeralPermission`: owner + session key |
| `Position` (size, side, entry, funding_snapshot, salt) | **Ephemeral** | ER only | **Never** | Does not exist outside the enclave |
| `ClosedPosition` (before disclosure) | **Ephemeral** | ER only | Never | Owner + auditor via permission |
| User / pool eATA | Delegated | ER | Rarely | A balance, not a position |
| Global Vault (`SPLxh1LV…`) | Regular | L1 | — | Public, shared by the whole MagicBlock ecosystem |
| `DisclosureCommitment` (hash) | Regular | L1 | Written by a Magic Action | Public hash, seeds = `[b"commit", nonce]` without owner |
| `Disclosure` (revealed record) | Regular | L1 | Magic Action after N days | Public |

**Custody via Ephemeral SPL Token.** The real tokens sit in the Global Vault (a PDA from `[mint]`), while the eATA is a lightweight `u64` record that is delegated to the ER and mutated there in milliseconds. This removes the problem of "a program on L1 cannot see delegated accounts": margin accounting is entirely inside the rollup, tokens are on the base layer.

**The sponsor is the per-user `UserAccount`, not a protocol PDA.** A shared sponsor would become a hot account on every `create_ephemeral_position`.

### 2.1.3 Position lifecycle

| Step | Where | What happens |
|---|---|---|
| Onboarding | L1 → ER | `deposit` into the Global Vault → `delegate(UserAccount)` with attached **Delegation Actions**: `init_permission` + `set_privacy(true)`. One MWA signature instead of three |
| Opening | ER | Oracle check → `create_ephemeral_position` → serialization → margin debited from the user's eATA to the pool's eATA |
| Holding | ER | The crank re-marks positions every block; funding via a cumulative index |
| Commit | ER → L1 | Once every N minutes: `Pool`, `Market`, occasionally `UserAccount`. **No split of OI by side** |
| Closing | ER → L1 | PnL calculation → `ClosedPosition` with salt → a Magic Action `write_commitment(nonce, hash)` is added to the next commit |
| Disclosure | ER → L1 | After `reveal_after_slot` the crank adds `write_disclosure(...)` in a batch; `ClosedPosition` is closed, the rent is returned to the sponsor |
| Exit | ER → L1 | `commit_and_undelegate` — forbidden while there are open positions (cleanup gate following the Sealed-Bid pattern) |

### 2.1.4 Leak model — what a base-layer observer sees

A section the document did not have; it is needed both in the README and in the deck.

| Moment | Visible on L1 | Hidden |
|---|---|---|
| Deposit | Wallet, amount, time. Forever | — |
| Delegation | The fact of using Dexxer | — |
| Open / modify / partial close | **Nothing** | Everything |
| Aggregate commit | Total pool collateral, coverage bucket | Split by side, per-user deltas |
| Liquidation | The fact and the moment | The level — until it happens |
| Closing | The commitment hash | The contents until `reveal_after_slot` |
| Disclosure | Market, side, size, entry, exit, PnL | Liq level and BE lose their meaning |
| Withdrawal | Wallet, amount. Forever | — |

**What can be inferred indirectly:** total PnL over a period (`withdrawal − deposit`); an upper bound on the position (`collateral × max leverage`); the statistical distribution of liquidation levels in the pool.

**Mandatory mitigations — not optimizations, but privacy requirements:**

| Mitigation | What it closes |
|---|---|
| Commit at a **fixed interval**, never event-driven | An event-driven commit reveals the moment and scale of an action |
| Interval of **5 min at launch**, not 30 s | Small anonymity set: with a single active user, the delta = their position |
| Standardized deposit denominations (100/500/1000) | The amount as an identifier that survives the batch |
| Shared fee payer / relayer | The payer links all actions of a single user |
| Identical transaction shape for all actions | The action type is readable from the set of accounts |
| Protocol fees — in aggregate, never per-position | Fee × 1/rate = position size |
| Liquidation in the same crank batch as scheduled closes | The transaction shape reveals the event type |
| `DisclosureCommitment` seeds without owner | A PDA from the wallet = "this user closed a position just now" |

**Anonymity set — an honest limitation.** Batch privacy is proportional to other people's activity, and at launch there is none. Mitigation: an adaptive commit window under low activity. Dummy operations from our own capital — only with open documentation, otherwise it is volume inflation.

### 2.1.5 Disclosure: commit-then-reveal

```rust
// ER, ephemeral
pub struct ClosedPosition {
    owner, market, side, size,
    entry_price, exit_price, pnl,
    opened_slot, closed_slot,
    salt: [u8; 32],          // without salt the hash is brute-forced in minutes
    mode: DisclosureMode,
    reveal_after_slot: u64,
    nonce: u64,
}

pub enum DisclosureMode {
    Public { delay_slots: u64 },  // default ≈ 30 days
    Aggregate,                    // only total PnL over a period
    AuditorOnly,                  // never reaches L1
}

// L1, seeds = [b"commit", nonce]
pub struct DisclosureCommitment { hash: [u8; 32], batch_slot: u64 }

// L1, seeds = [b"disclosure", nonce]
pub struct Disclosure { /* ClosedPosition fields without mode/reveal */ }
```

Verification by anyone: `sha256(Disclosure) == DisclosureCommitment.hash`. The protocol cannot forge history after the fact.

**Three things that break the scheme if skipped:** missing salt (low entropy of the fields); owner in the commitment seeds; an `#[action]` handler without a check of the injected escrow signer — otherwise anyone can write a fake disclosure with an ordinary transaction from a wallet.

**Cost:** two Magic Actions ≈ 25–30k lamports per position. Disclosure is economically free.

**Why with a delay, not immediately.** Copy-trading works on live positions, strategy leakage on fresh history. 30 days kills both while keeping auditability. This is the 13F model (45-day lag), not concealment.

### 2.1.6 Risk engine and crank inside the ER

The risk engine must see positions in the clear — so the questions "where is the privacy" and "where is the risk engine" are one question. Answer: both in the TEE.

- **The crank scans ephemeral `Position` accounts inside the ER** — the same pattern as `end_auction` in the Sealed-Bid Auction template. Privacy does not get in the way of liquidation, because the crank is in the same enclave.
- **MagicBlock High-precision Scheduling** — the crank lives in the rollup as a scheduled task, not an external cron. Lesson from `percolator-cli`: one iteration per minute cannot keep up with `MAX_ACCRUAL_DT_SLOTS=10` and OI > 0; an internal loop of ~4 s or faster is needed.
- **Funding — a cumulative index on the market**, `position.funding_snapshot` on interaction. Never iterate over positions to accrue.
- **Liquidation by mark, with hysteresis.** Comparisons and branching inside the TEE are ordinary, with no cryptographic overhead. This is what neither ZK (you cannot force an insolvent party to prove insolvency) nor FHE (branching on ciphertext computes both branches) provides.

### 2.1.7 Oracle

Pyth Lazer via the MagicBlock Pricing Oracle: updates in ER accounts every **50–200 ms** depending on the asset, versus Solana's ~400 ms slots.

- **Mark ≠ raw print.** With updates every 50 ms, spikes are sharper, not softer. Mark = EMA/TWAP over index, computed by the crank in the ER, where it costs nothing.
- **Checks on every read:** staleness (for a perp the threshold is 1–2 s, not 60 as in the Oracle-Priced Purchase template), confidence interval, deviation guard against a second source, feed status.
- **Trust in the pusher.** The chain pusher is closed for now (they promise to open it). Mitigation: verify the Pyth Lazer signature in the program instead of trusting the pusher; or a deviation guard against Pyth pull on L1 at commit.
- **Check in week 0:** whether the oracle accounts are updated in the **TEE validator**, not only in the regional ERs. If not — a blocker.

### 2.1.8 Liquidity

A sequence, not a one-time choice:

| Stage | Mechanism | What it gives |
|---|---|---|
| MVP | Own capital, strict position and OI limits | The demo works without external capital |
| Core | **Internal netting** of longs against shorts | Capital serves many times more volume. The cheapest lever — build it in from the start |
| v1 | External hedge of the net delta (Jupiter or spot via a router) | Capital covers the gap, not the whole risk |
| v1 | Senior/junior instead of an insurance fund (Percolator) | Profit is a junior claim, deposit is senior; removes a class of insolvency scenarios |
| v2 | RFQ makers in PER (sealed-bid) | Real price discovery without a public book. An answer to the Solana Foundation thesis on pool models |

**Privacy of the protocol itself.** Hedge operations on L1 reveal the aggregate delta. Mitigations: windows with a random offset, splitting across venues, a spot route via Jupiter (the router itself will go to private prop-AMMs), partial hedging. Hedge wallet keys — inside the TEE; funding — not by direct transfer from the vault.

### 2.1.9 Rollup economics

| Item | Price | Note |
|---|---|---|
| Transaction in the ER | 0 | User actions are free |
| Delegation session | 300 000 lamports | Deducted from the deposit on undelegate |
| Commit (except the first) | 100 000 lamports | **The only recurring item** |
| Live fee from the 26th commit | 100 000 lamports / account | A delegated fee payer is required |
| Magic Action | ~10k per 200k CU + 5k callback | Disclosure |
| Ephemeral storage | `(bytes + 60) × 32` lamports | Returned on close |

**The commit interval determines both privacy and cost:** 30 s → ~105 SOL/year per market; 5 min → ~10 SOL/year. Both arguments pull in the same direction.

**A fee payer is mandatory from week 1:** without it the account stops at the 11th commit with `0xA0000000`. Required: `magic_fee_vault`, top-ups via `lamportsDelegatedTransferIx` (a fresh salt on every top-up), and per-user spending limits so that one user cannot drain the shared payer.

### 2.1.10 Trust model and recovery

| Layer | Trust | Confirmed by |
|---|---|---|
| State confidentiality | Intel TDX + ER operator | `verifyTeeRpcIntegrity` via Phala PCCS — the client verifies the attestation before the first request |
| Commit correctness | Fraud proof + Security Committee | MagicBlock mechanism |
| Custody of funds | Program `SPLxh1LV…` | Not our code — check the audit, upgrade authority, vault behavior on validator failure |
| Access to the position | `EphemeralPermission` | A filter at the TEE entrance, before the transaction is accepted |

**Wording, identical everywhere:** privacy from trackers, copy-bots, liquidation hunters and from us — **not from Intel** and not from a physical attack on the server. This is a hardware guarantee, not a cryptographic one. The same root of trust is used by Encifher, Inco, Jito BAM and NEAR Confidential Intents — the de facto standard of the category.

**Risk of losing ephemeral state.** The death of the rollup destroys `Position` along with it. The margin balance is recovered from the state of the last `UserAccount` commit; the parameters of an open position are not. This is the price of "does not exist on L1", and it must be stated in the README in plain text. For production: our own TEE validator (the `magicblock-validator` repository is open, Dstack as the environment) or an SLA with the operator.

**The session key must be in the `EphemeralPermission` members** — otherwise the TEE access token obtained by a session-key signature will not pass the filter.

**The Magic Router sees the transaction before the enclave** (it inspects writable accounts and instruction data for routing). Therefore trading actions go directly to the token-gated TEE endpoint; the Router is for public L1 operations. Simulation for showing the liquidation price before signing — explicitly against the ER endpoint, because the examples use `skipPreflight: true`.

### 2.1.11 Toolchain and build order

**Versions from the PER Quickstart:** Solana 3.1.9, Rust 1.89.0, **Anchor 1.0.2**, Node 24.10.0, `ephemeral-rollups-sdk` ≥ 0.14.

This changes the fork estimate: migrating `solana-labs/perpetuals` is not 0.26 → 0.30 but 0.26 → 1.0, because of the IDL break in 0.30. Hence the **plan inversion**: not "fork the perp and add MagicBlock", but **take the MagicBlock trading template and add perp math**.

| Step | Source |
|---|---|
| 1. Build Binary Prediction as is, on `devnet-tee` | Sessions, eATA custody, oracle, crank, commit — already wired together |
| 2. `Bet` → `Position`: size, leverage, side, entry | Our own |
| 3. Margin math (IMR/MMR, PnL, liq price) | `solana-labs/perpetuals` / Percolator — **formulas, not code** |
| 4. Crank: expiry → margin check by mark | Our own + Cranks docs |
| 5. Privacy: `init_permission` + `set_privacy` | `private-counter` |
| 6. Private `Position` as a sponsored PDA + scan in the crank + cleanup gate | `sealed-auction` |
| 7. Oracle validation in price-sensitive instructions | `oracle-priced-purchase` |
| 8. Funding | Last — not critical for the demo |

**MagicBlock Dev Skill** (`npx skills add https://github.com/magicblock-labs/magicblock-dev-skill`) — install it **first**: without it the agent will hallucinate an API that has changed with every version.

### 2.1.12 Week 0 checks — in order of criticality

1. **The structure of `Position` in Percolator** — whether it is a separate account or an array in the slab. If an array — per-user privacy cannot be built from it, and Percolator drops out as the base (the crate remains a source of math). *Crate v16 claims a "slab-free, account-local" risk model — probably so, but check in `percolator-prog`.*
2. **Oracle in the TEE validator** — whether Pyth Lazer accounts are updated in `devnet-tee`.
3. **eATA in the TEE validator** — whether Ephemeral SPL Token works there too.
4. **`EphemeralPermission` on an ephemeral account** — whether an account that does not exist on L1 can be made private.
5. **Forced undelegation after lifetime** — whether a user can exit if the validator is dead (read `delegation-program`).
6. **Read-only cloning of non-delegated accounts into the ER** — whether an ER instruction sees the fresh state of an L1 account.
7. Building `private-counter` on our own toolchain.

### 2.1.13 Weakness roadmap

Every limit of the solution has a named way of closing it — this is a separate slide in the deck.

| Weakness | Closed by | When |
|---|---|---|
| The position is public | MagicBlock PER | MVP |
| History is readable immediately | Commit-then-reveal with a delay | MVP |
| The deposit is attributed to the wallet | Umbra / Confidential Balances / Rings — `deposit(source)` as a pluggable interface | v2 |
| The protocol's hedge is visible | Jito BAM (pre-execution privacy at the scheduler level) | v1 |
| Trust in the ER operator | Own TEE validator (Dstack + `magicblock-validator`) | v1 |
| "How do you know the aggregate is honest" | Bonsol: a ZK proof of `liabilities ≤ reserves` without revealing positions | v2 |
| No price discovery (pool model) | RFQ in PER (sealed-bid), per the Solana Foundation thesis | v2 |

### 2.1.14 What this changes in the competitive framing

The landscape shifted a week before launch, and the document records it:

- **Aster** — the world's second-largest perp DEX by volume; a private L1 with ZK encryption of orders, stealth addresses and Viewer Pass, privacy by default. The thesis "nobody hides the position" no longer holds.
- **NEAR × Hyperliquid** — confidential perps via Confidential Intents (private FAR shard + TEE bridge) and Chain Signatures. This is **literally Option 1**, implemented from the outside: it hides the owner, not the position (the Hyperliquid book stays public).
- **Paradex** — a private perp on an L3 on top of Starknet: an off-chain book in a single AWS region, encrypted state diffs on Ethereum, decryption keys held by a Privacy Council of three parties.

**New wording of the thesis:** the private perp is already winning on other chains. On Solana — with the largest mobile audience and Seeker — it does not exist. We are not proving demand; we are bringing proven demand to where it is not served.

**What keeps Dexxer distinct:** it hides precisely **what** (the position configuration), not just **who**; without its own chain and token; mobile with self-custody via Seed Vault.

---

## 3. Components

### 3.1 On-chain: Dexxer Core (Anchor)

**Accounts (PDA):**
- `UserVault` — seeds `["vault", owner]`; public; holds deposited USDC/USDT, a free-margin counter, a reference to the active session.
- `OmnibusState` — seeds `["omnibus", market, side]`; public aggregate: total exposure, total margin, coverage ratio, buffer, `pending_delta` for the batch.
- `SessionToken` — seeds `["session", owner, session_pubkey]`; `expiry`, `scope` (bitmask of allowed instructions), `actions_left` (a cap on the number of actions — the GMX One-Click lesson), `max_size`.
- `Request` — seeds `["req", owner, nonce]`; state machine for interaction with the venue.
- `Disclosure` — seeds `["disc", owner, position_id]`; public record after close (13F).

**Instructions (public layer):**
`deposit`, `withdraw`, `create_session`, `revoke_session`, `request_open`, `request_close`, `add_margin`, `settle_fill` (crank), `liquidate_internal` (crank), `commit_aggregate` (crank), `disclose` (crank/owner), `apply_adl` (crank, with the chosen allocation rule), `pause`/`unpause` (admin, multisig + timelock).

**Venue adapters** — separate modules following the Adapter pattern (see §5): `jupiter_perps`, `gmtrade`, `flash`. Shared trait: `open(delta) → RequestId`, `close(delta) → RequestId`, `read_position() → AggPos`, `fees(size) → Fee`, `staleness_threshold(market)`.

### 3.2 PER (MagicBlock)

- `UserPosition` — seeds `["pos", owner, market]`; delegated to the ER with `EphemeralPermission { members: [owner, viewers...] }`; fields: `size`, `side`, `entry_price?`, `margin_allocated`, `state`, `request_id`, `opened_at`, `adl_reduced_by`.
- The liquidation crank runs **inside the ER** (10–50 ms blocks) reading the Pricing Oracle — so the per-user margin check is cheap and frequent.
- Commit to the base layer: **only the aggregate** and only in batches (every N slots or on a change > X%) — this is the main mitigation of account contention.

### 3.3 Backend (NestJS) — "allowed to fail"

- **Indexer:** Yellowstone gRPC (Geyser) or Helius webhooks → program events → Postgres. Source for the dashboard, push, analytics. Idempotent on `(signature, event_index)`.
- **Crank runner (BullMQ):** queues `settle-fill`, `margin-check` (trigger from the ER), `internal-liquidation`, `aggregate-batch`, `disclosure`. Every job is idempotent on a state key; retry with exponential backoff; DLQ.
- **Push service:** Expo Notifications; events `Filled`, `NearLiquidation`, `Liquidated`, `Closed`, `ADLApplied`. Fan-out through a queue, dedup on `(user, event, position_id)`.
- **Compliance gate:** address screening on the first deposit and on withdrawal (Elliptic/Range); the result is cached with a TTL; geo — at the PER ingress, not here.
- **RPC:** our own minimal layer — two providers (Helius + backup), health-check, failover on errors and timeouts, OpenTelemetry. Separate clients for the risk and user loops.

### 3.4 Mobile client (Expo/RN)

- MWA for connect and the **single** deposit signature (approve to a limited program authority).
- The Session Key is generated locally (secure storage) and registered via `create_session`; trades are then signed with it.
- Reading the private position — **directly from the PER via QFS** (token = signed challenge), without our backend.
- Local state cache + optimistic UI for `requested → pending`; reconciliation from events.
- The push token is registered with the backend; the backend does not know the position — only that an event happened for the owner.

---

## 4. System design under load

### 4.1 Where it breaks — and how we fix it

| Bottleneck | Symptom under load | Mitigation |
|---|---|---|
| **Account contention on OmnibusState** | All actions serialize on a single write-lock; a queue at the moment of a sharp move | Per-user actions write only to their own PDAs (`UserVault`, `Request`, PER `UserPosition`); the aggregate is updated **only by the crank in a batch**. The user path does not touch `OmnibusState` |
| **Aggregate sharding** | Even the batcher becomes a bottleneck with many markets | `OmnibusState` per `(market, side)` — natural shards (the same principle as Percolator slabs). Cranks across shards run in parallel |
| **Venue keeper (async fill)** | Pendings accumulate, entry price unknown | TTL on `Request` → `expired` with automatic margin refund; `settle_fill` reads the position delta, does not assume it; slippage in every request |
| **RPC** | Rate limits, provider outage | Own layer: two providers with health-check and failover; **separate clients for the risk and user loops** — UI traffic cannot eat the connections the crank needs; reads — from the indexer, not from RPC |
| **PER throughput** | Many `UserPosition` updates | Writes in the ER are cheap (10–50 ms blocks); keep positions as separate PDAs, not an array in one account |
| **Intent queue** | One queue account = the same write-lock as the aggregate | **Sharded queue**: N shards (≈16), a user lands in `hash(pubkey) % N`. Instead of one queue — 16 parallel ones |
| **Request burst in peak minutes** | The queue grows faster than it is processed | **Asymmetric backpressure**: above the threshold new **opens** are rejected with an honest message, **closes and margin top-ups always go through**. Exit takes priority over entry |
| **Push fan-out** | Thousands of notifications per second during a crash | Queue with batching to Expo; priority `NearLiquidation` > everything else; dedup |
| **Indexer lags** | Dashboard shows stale data | CQRS: the UI shows "state as of block N"; critical data (the position) is read from the PER directly |
| **Compliance API down** | Deposits are blocked | Fail-closed for deposits, fail-open for withdrawals (do not hold funds because of a vendor outage) + result cache |

### 4.1b Two loops that do not interfere with each other

Physical separation, not logical:

| | Risk loop (soft real-time) | User loop (best-effort) |
|---|---|---|
| What it does | Oracle read → margin recalculation → internal liquidation → aggregate commit | Open, close, read positions, history |
| Guarantees | Time budget, independent of the number of open apps | May degrade: the user can wait a second |
| Resources | Separate queues, workers, RPC connections, limits | Separate |
| Priority in the crank | Liquidations → closes → opens | — |
| Priority fees | Raised during volatility | Normal |

Invariant rule: **UI traffic cannot interfere with liquidation, and the crank's work cannot take down the API.**

### 4.1c API layer: what and why

| Type | What for | Notes |
|---|---|---|
| **REST** | Actions (open, close, top up) and state queries (positions, history, market parameters) | Request-response, infrequent calls, cached on the client |
| **WebSocket** | Live updates: PnL, distance to liquidation, transitions `pending → filled`, `near_liquidation`, `adl_reduced` | Mandatory: **snapshot on connect** + deltas, sequential message numbers, reconnect with exponential backoff. A mobile connection drops on network change and when the app is backgrounded |
| **Push (Expo Notifications)** | Critical events while the app is closed: approaching liquidation, fill, ADL | Not an alternative to WS but a different channel for a different scenario. Optional and can be turned off (Publisher Policy requirement) |
| **Incoming webhooks (Helius)** | Signal about a change in the omnibus position instead of constant polling of venue state | May not arrive or may arrive twice → idempotency + **fallback polling**. The risk loop cannot rely on webhooks alone |
| **Yellowstone Geyser gRPC** | In reserve: a stream of account updates with lower latency than `accountSubscribe`, if WS is not enough for the crank | gRPC **as a client to a provider**, not as our public API |

**What is absent:** gRPC as a public API (in RN it needs grpc-web or a proxy, no gain for our profile), outgoing webhooks for users (a mobile user has no endpoint — push plays that role), GraphQL.

**Decision we make at the start:** the WebSocket server is a **separate process from the REST API**. A thousand open connections and a burst of HTTP requests must not interfere with each other — the same loop isolation, only at the transport level.

### 4.1d Solana transaction mechanics: three rules that affect us directly

**Priority fees are queried per write-locked account, not "in general".** `getRecentPrioritizationFees` takes account pubkeys and returns `max(minimum fees across these accounts)`. Without parameters it returns the lowest fee to get into a block — usually zero, i.e. a useless estimate.

For us: the liquidation crank queries the fee **specifically for the omnibus account (and the queue shard)**, because these are the hot accounts being contended for. Otherwise, at a moment of volatility we get zero and the transaction fails exactly when it is critical. The risk loop — with a raised fee, the user loop — with a normal one.

Plus: explicitly set `setComputeUnitLimit` to the CU actually consumed (measure with a run) rather than leaving the default — that is both cheaper and better for throughput.

**Retry is safe only after the blockhash has expired.** Resending a transaction that "does not look confirmed" while the blockhash is alive is a double-execution risk. Rule for the outbox worker: before a retry check `isBlockhashValid`; while the blockhash is alive — wait, do not resend. The idempotency key protects the logic from duplication, `isBlockhashValid` — the network level.

**The indexer is configured for versioned transactions from the start.** `maxSupportedTransactionVersion: 1` and `encoding: "jsonParsed"` from day one:
- one unsupported version in a block breaks the whole `getBlock`, while `getSignaturesForAddress` does not fail on versions — i.e. without opt-in, v1 transactions are visible in the signature list but cannot be fetched;
- `jsonParsed` includes all account keys (including from lookup tables) in `accountKeys`, so `preBalances/postBalances` resolve without manual work;
- **in the v1 format, compute and fee limits live in the `transactionConfig` object, not in ComputeBudget instructions** — any parser that looks for fees among instructions will show zero for v1; and v1 does not use address lookup tables.

### 4.2 Capacity estimate (MVP → v1)

- **On-chain:** one user action = 1 transaction ~ (1 write to `UserVault` + 1 to `Request` + 1 to the PER). Without touching the aggregate — parallel across users. The limit is chain TPS and CU per transaction, not our design.
- **Aggregate crank:** 1 transaction per `(market, side)` per batch; with 3 markets × 2 sides × a batch every 2 s — ~3 TPS. Negligible.
- **Liquidation crank in the ER:** per-user margin check — O(1) read; with 10k positions and 50 ms blocks — a pass over all of them in seconds, if we keep a sorted structure (see §5).
- **Backend:** NestJS + BullMQ on one instance handles thousands of jobs/s; Postgres with event partitioning by day. For the hackathon — one container; for v1 — 2 replicas behind an LB, Redis for queues, a Postgres read replica.

### 4.3 Resilience

- **Circuit breaker** on every external call (venue CPI via staleness check, RPC, Elliptic, Expo).
- **Protocol pause** (`pause`) as a separate instruction under a multisig with a timelock — the Drift lesson: the biggest threat is people with keys, not code.
- **Idempotency** everywhere: crank jobs on `(request_id, state)`, indexer on `(signature, idx)`, push on `(user, event, id)`. Plus the network level: a transaction retry — only after the blockhash has expired (`isBlockhashValid`), otherwise a double-execution risk.
- **Graceful degradation:** if the backend is down — the user can still `request_close` and `withdraw` directly via the program; the push will not arrive, the position will not suffer.

---

## 5. Big O — where complexity actually matters

| Operation | Naive | Target | How |
|---|---|---|---|
| Open/close a position (per user) | O(1) | O(1) | Write to own PDAs; the aggregate is not touched |
| Update the aggregate | O(n) over users | **O(1)** | Running sums: `total_size += delta`, `total_margin += delta`; never recompute from scratch |
| Margin check of all positions (crank) | O(n) | **O(k log n)**, k — candidates | Keep an index of positions by `liq_price` (heap / sorted list in the ER); check only those whose liquidation price is within ±δ of the current one |
| Internal liquidation | O(1) per position | O(1) | One decrease-request + running sums update |
| ADL allocation across participants | O(n) | O(n), but **rarely** | One pass; pro rata by `size` or by leverage; in batches of m users per transaction via `remaining_accounts` |
| Long/short netting (v1.1) | O(n²) naive | O(n) | Two running sums; the difference is netted, not pairs |
| User reading a position | O(1) | O(1) | Direct PDA read from the PER via QFS |
| Looking up a user's sessions/requests | O(n) scan | O(1) | Deterministic seeds — the address is computed, not searched |
| Indexer: aggregates for the dashboard | O(n) per query | O(1) | Materialized views / incremental counters in Postgres |

**Why the usual notation is misleading here.** On-chain cost is measured not only in algorithm steps but in **the number of accounts in a transaction** (≈64 max, and every write-lock is serialization) and **compute units** (200k by default, up to 1.4M on request). Two typical traps:
- an instruction that takes a vector of users and loops over it: looks acceptable for n=50, but hits the account and CU limits. The right way is a **fixed batch of 8–16 positions per transaction**, a large volume in several transactions;
- searching for liquidation candidates with a linear scan: with 1k positions and the crank every few seconds, that is thousands of reads per cycle. **Buckets by liquidation threshold** reduce this to dozens.

**Account sizes (rent):** `UserPosition` ~120 bytes; `Request` ~96; `SessionToken` ~80; `OmnibusState` ~160. Compute `space` explicitly, `#[account(zero_copy)]` for hot accounts, a `version: u8` field in each for migrations.

**Compute units:** CPI into the venue is the most expensive instruction (~100–200k CU from Jupiter's code); keep our own logic < 50k CU; the liquidation crank in the ER — a separate budget, not the base layer.

---

## 6. Design patterns — which and why

| Pattern | Where | Why |
|---|---|---|
| **Adapter** | Venue adapters (`jupiter_perps`, `gmtrade`, `flash`) | Adding a venue = adding a module; the core does not know venue details. The Cookbook lesson from RAILGUN |
| **State Machine** | `Request`: `requested → pending → filled \| failed \| expired`; `UserPosition`: `open → reducing → closed → disclosed` | Asynchronous keeper without races; every transition is a separate instruction with guards |
| **Strategy** | ADL allocation rule (`ProRataBySize`, `ByLeverage`, `FIFO`) | Chosen in advance, changed via config, described in the terms |
| **Saga / Compensation** | `request_open` → (keeper fill) → `settle_fill`; on `expired` — compensation refunds the margin | No atomicity between us and the venue — compensating steps are needed |
| **Outbox + Event Sourcing** | The program emits events (`anchor emit!`); the indexer builds state from events | The backend recovers from scratch from events; no "true" state in Postgres |
| **CQRS** | Writes — to the program; reads — from the indexer (public) or from the PER (private) | Separates the hot write path from heavy reads |
| **Circuit Breaker** | Own RPC layer; staleness-check before CPI; compliance vendors | Do not drag dependency failures into the critical path |
| **Idempotent Consumer** | All crank jobs and the indexer | Restart without duplicating actions |
| **Batching** | `commit_aggregate` every N slots; ADL by m users per tx; push to Expo | The main answer to account contention and rate limits |
| **Backpressure (asymmetric)** | Queue depth threshold: new opens are rejected, closes and margin top-ups always go through | Exit takes priority over entry — a basic rule of risk systems |
| **Sharding** | `OmnibusState` per `(market, side)`; intent queue in ≈16 shards by `hash(pubkey)` | Parallel cranks, smaller blast radius, avoiding write-lock contention |
| **Bulkhead** | Separate queues, workers and RPC clients for the risk and user loops; WS as a separate process from REST | A push jam does not block liquidations; a UI burst does not take connections from the crank |
| **Pending → apply → available** | Margin inflow: incoming funds first go to a "pending" zone, an explicit action moves them to available | The pattern is confirmed by the Token-2022 Confidential Balances standard; it solves asynchronous inflow under deterministic accounting — the same shape as our request state machine |
| **Time-to-live** | `Request.expiry`, `SessionToken.expiry` | Nothing hangs forever |
| **Capability tokens** | `SessionToken` with scope + action cap | Minimal rights for minimal time |
| **Guard / Precondition** | Every instruction checks `state`, `expiry`, `scope`, oracle staleness | Anchor `constraint`s + explicit `require!` |
| **Versioned accounts** | A `version` field in every PDA | Migrations without redeploy panic |

Anchor specifics: PDA seeds as an "index" (the address is computed, not searched); `remaining_accounts` for batches; `zero_copy` for hot accounts; do **not** use `init_if_needed` for accounts holding money (a class of known vulnerabilities); every CPI — with an explicit check of the venue `program_id`.

---

## 7. Tech stack

| Layer | Choice | Why exactly this |
|---|---|---|
| On-chain | **Rust + Anchor 1.0**, `ephemeral-rollups-sdk` (MagicBlock), `anchor-spl` | Ecosystem standard; the ER SDK provides delegation and permissions with two macros. *Verify the specifics of the macros and IDL generation against the current 1.0 docs* |
| Private state | **MagicBlock PER** (Intel TDX); locally — `mb-stack` + QFS | 10–50 ms latency; local TEE emulation without hardware |
| Prices | **MagicBlock Pricing Oracle** (Pyth Lazer in the ER) for margin; the venue uses its own oracle for the fill | No latency gap between price and state in the ER |
| Venue | **Jupiter Perps** (base), **GMTrade** (check first — fees), **Flash** (has `flash-sdk-rust` for reading on-chain state + `examples-v2`, MIT), Adrena | **v1, not MVP.** Peer-to-pool = CPI + deterministic price (landscape 1.5, 1.7) |
| Session Keys | `magicblock-labs/session-keys`; cross-check with the `flash-trade/session-keys` fork | **Flash is already integrated with MagicBlock** (there is also `magicblock-grpc-example` in Rust) — external confirmation of the stack by a live perp DEX on Solana |
| Local development | LiteSVM/proptest → `mb-stack` → devnet + `devnet-tee-as` (spec §6.3). Surfpool is not needed | Jupiter Perps is not on devnet |
| Backend | **TypeScript / NestJS**; **Postgres** — the single off-chain source of truth (event projection, outbox, partitions by day); **BullMQ + Redis — only as a queue broker, not a cache** | The stack the author is fastest in. Redis does not cache state: the projection in Postgres is already fast, and a second layer of truth causes desync and the "showed the old position after close" bug |
| RPC | **Own minimal layer** (~150 lines): two providers (Helius primary, Triton/public backup), health-check, failover on errors and timeouts, **separate clients for the risk and user loops** | We deliberately do not use kitguard. Without this layer the first RPC failure stops the crank |
| Mobile | **Expo / React Native**, `@solana-mobile/mobile-wallet-adapter-protocol`, Expo SecureStore (session key), **Expo Notifications** | Solana Mobile template; MWA is Android-only |
| WebSocket client | The `ManagedWebsocket` pattern from `bullet-rust-sdk` (MIT, has WASM bindings): auto-reconnect, exponential backoff, **resubscribe after reconnect**, dead-stream detection, backoff reset after stable uptime, subscription dedup | Exactly what a mobile client needs, where the connection drops on every network change and app backgrounding. Take it as a reference or via WASM |
| Compliance | **Elliptic** (AML/OFAC) + **Range** (Solana-native monitoring); geo — PER ingress | The same stack as Vanish; we do not collect GPS |
| Observability | **OpenTelemetry** (traces from the client to the crank), Grafana/Loki or Axiom | Without traces, async flows cannot be debugged |
| CI/CD | GitHub Actions: `anchor test` (LiteSVM), Surfpool integration tests, `cargo audit`, EAS Build for the APK | One pipeline for the program, backend and app |

**What is deliberately absent from the stack:** ElizaOS/agent frameworks, own matching, own oracle, kitguard, Kubernetes (one or two containers on Fly/Railway are enough until v1), GraphQL, **Redis as a cache layer**.

**On caching separately.** A cache is needed when the source of truth is slow. Our source of truth is the chain and the PER, and the off-chain projection already lives in Postgres and, on indexed queries, returns a position in milliseconds for our profile (a thousand users × a few actions per day). Instead of a cache — three indexes for hot queries (position by owner, open positions by risk bucket, events by position) and cursor pagination in history. The only exception where Redis as a state store is justified is hot risk buckets, once there is more than one worker; until then in-memory is enough.

---

## 7.5 MEV: where we are vulnerable and where not

**Sandwich on position open — low risk.** In a pool venue the price comes from the oracle, not a curve; our trade does not move the price itself, so a classic sandwich earns almost nothing here. The price impact fee is computed by a formula from size, not from the pool state after someone else's trade.

**Where the risk is real:** deposit and withdrawal, if they include a conversion (SOL→USDC) — that is an ordinary AMM swap with all the consequences; and any spot legs, if they appear.

**The irony of aggregation:** the omnibus makes trades **larger** than individual ones, so wherever a sandwich is still possible, we are a fatter target.

**Jito DontFront.** Add a read-only account with the `jitodontfront` prefix to any instruction → the block engine forces our transaction to index 0 in the bundle, i.e. a front-run is impossible. Submit via `https://mainnet.block-engine.jito.wtf/api/v1/transactions`, base64.

**Our decision that contradicts the official recommendation.** The docs advise a unique dontfront pubkey per application to distinguish your own usage in on-chain data. For us that is a **fingerprint**: all Dexxer transactions become tagged with a shared marker, and a tracker only needs to search for that key to isolate our flow. Therefore — **the canonical `jitodontfront111...111`**, which many use: dissolve into others' flow rather than mark our own.

**Limitations to know:** it works only via the Jito block engine (transactions sent directly to validators are not protected), **does not work on devnet and localhost** — we cannot verify this behavior on Surfpool; for bundles, dontfront transactions must be contiguous at the start and share a signer, so if we ever pack liquidations into a bundle — all are signed by the same crank key.

**The main line of defense remains different** (and the docs confirm this): tight slippage in every request, adequate tips and priority fees, optimized CU.

---

## 8. Security — the trust model, named explicitly

- **User keys** — only in the Seed Vault; we never see them. The Session Key is a separate key with limited scope, TTL and an action cap; withdrawal — only to the owner's wallet (the GMX lesson).
- **Admin keys** — multisig (Squads) + timelock on upgrades and on changes to risk parameters. The Drift lesson ($295M): the biggest threat is social engineering of signers.
- **TEE trust** — we name it honestly: privacy from trackers, copy-bots and from us; not from Intel and not from the validator operator. Verify code attestation (allowlist MRTD/RTMR), not just quote freshness. **And we admit it out loud:** Arcium's MPC model ("at least one honest node") is cryptographically stronger than ours; we choose TEE for latency and predictable failure semantics, not because it is more secure.
- **Why Arcium is not in the risk loop** — not only because of MPC round latency. Cerberus works in a **detect-and-abort** model: on a detected protocol error the computation stops, and the application must handle the failure, retry and migration itself. A liquidation check step that sometimes simply does not happen while the price moves is unacceptable. **Where Arcium fits:** a periodic **proof of omnibus solvency** — the sum of liabilities against collateral, computed over private positions with only the total published. A rare computation, a public result, a cryptographic guarantee exactly where it is most needed — in the trust of LPs and auditors. A v2 candidate (see §9).
- **Venue risk** — inherited in full; we reduce concentration with an exposure limit per venue.
- **Oracle risk** — staleness per market (the GMX lesson), a conservative gap between our margin threshold and the venue's threshold.
- **Trustless exit** — the user can prove their share of the omnibus and exit without our backend and without the cooperation of the PER operator (minimum: `request_close` + `withdraw` work directly through the program; maximum — a share proof from the aggregate commit).
  **Reference mechanism: Sparse Merkle Tree exclusion proof** from Solana Private Channels (Foundation, MIT, open GitHub) — the escrow program accepts a proof and releases funds on-chain regardless of whether the off-chain layer is alive. This is exactly the primitive we were missing; in our case the tree leaf is the user's share in the omnibus as of the last aggregate commit. Read their escrow and SMT mechanics as a reference; **do not take it wholesale** — not audited, access is permissioned (RBAC + JWT), and a centralized sequencer stands between deposit and exit.
- **Viewer key rotation** — a rule from the CB standard that is easy to miss: rotation applies only to future records, **old keys must be retained** for the auditor's historical access. A class of bug that surfaces a year later.
- **Audit** — mandatory before real money; for the hackathon — `cargo audit`, the Anchor security checklist, LiteSVM tests for every state machine transition.

---

## 9. Architecture maturity by phase

| Phase | What exists | What is deliberately absent |
|---|---|---|
| **MVP (hackathon)** | One venue (Jupiter or GMTrade), SOL-PERP, omnibus + PER, session keys, internal liquidation, push, 13F disclosure, one backend container, Surfpool | Netting, multi-venue, real TDX (local QFS), ADL allocation only as config without a live test |
| **v1** | A second venue behind the adapter, devnet-tee → mainnet-tee, ADL allocation tested, compliance gate, multisig+timelock, audit | Netting, own risk capital |
| **v1.1** | Internal netting (the protocol is the counterparty for the netted part), a buffer from fees, allocation of the omnibus across venues by limits | — |
| **v2** | Percolator as a venue, if it matures (atomic routing, portfolio netting); **proof of solvency via Arcium MXE** — a rare computation over private positions with a public total, Anchor-compatible integration via `queue_computation` + callback | Bullet crossed out: API-first, not CPI |

---

## 10. Open questions (closed by code, not by a document)

1. Can the PER sustain the update frequency of `UserPosition` with 1k+ active positions and the crank in every block.
2. Is a deterministic proof of omnibus share from the aggregate commit (for trustless exit) possible without disclosing other positions.
3. Which ADL allocation rule is least contentious for users — pro rata is easier to explain, by leverage is fairer.
4. GMTrade: is it really ~0.5 bps and is the fill atomic — this changes venue priority and half of §4.1.
5. Session Keys SDK in React Native — does it work, or do we write the on-chain part ourselves.
6. **Percolator as the core of Option 2:** is there USDC margin (or only coin-margined); can position accounts be delegated to the PER without rewriting the slab structure; does it build under our toolchain (Anchor 1.0 vs their Anchor v2 / Pinocchio entrypoint). Plus check the openness of Adrena as a current fork of `solana-labs/perpetuals`.
7. Solana Privacy Protocol (Rings, beta): can a Custom Ring hold state with frequent updates, is there external CPI, is the beta suitable for a demo. If so — a candidate for the deposit/margin layer (a native Foundation solution weighs more in the pitch than our own).
8. SMT exclusion proof for trustless exit: what exactly is the leaf (the share in the omnibus at commit time) and can it be proven without disclosing other positions.

---

*The document lives together with dexxer-plan.md (calendar and risks) and solana-perp-privacy-landscape.md (market and mechanisms). In case of divergence, the code in the repository wins.*
