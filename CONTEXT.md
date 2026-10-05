# Dexxer

A private perpetual DEX for Solana Seeker: only the trader sees their position, the world sees only the coarsened state of the pool. This file is the project glossary and nothing else: rules and decisions live in `CLAUDE.md` and the spec, general market terms in `docs/glossary-perp-privacy.md`.

## Language

### Layers and privacy

**L1**:
The Solana base layer, where everything is public. Custody, onboarding and the public derived accounts live here.
_Avoid_: base, mainchain, devnet (that is a network, not a layer)

**ER**:
The MagicBlock ephemeral rollup, where all trading runs over delegated accounts.
_Avoid_: rollup, L2, PER (PER is an ER with privacy, see below)

**PER**:
An ER inside a TEE that serves an account for reading only to its members.
_Avoid_: private chain, encrypted state (privacy here is a read filter, not encryption)

**Delegated account**:
An account owned on L1 by the Delegation Program and changed only in the ER.

**Private account**:
A delegated account with a member list; a non-member cannot read it. It never reaches L1 as is.
_Avoid_: permissioned account, encrypted account

**Member**:
A key in a private account's list that the TEE allows to read it.
_Avoid_: participant, viewer

**Public derived account**:
A separate public account through which private state reaches L1 in anonymized form: **Pool** and **BalancesRoot**.

**Commit**:
The periodic write of **Pool** and **BalancesRoot** from the ER to L1, at a fixed interval and never in response to a trader's action.
_Avoid_: settle, sync; always call a git commit "git commit"

### Roles

**Owner**:
The trader's wallet. It signs onboarding, deposit, withdrawal and exit.
_Avoid_: user, client

**Session key**:
A temporary key on the device with which the owner trades without a wallet prompt for every action.
_Avoid_: session (unqualified), session token

**Crank**:
The protocol's privileged key, a member of every trader's private accounts. The only server key that sees private state.
_Avoid_: keeper, bot

**Admin**:
The key that creates markets and changes protocol parameters.

**Fee payer**:
The relayer's key that pays fees and rent for sponsored transactions.
_Avoid_: sponsor (as the name of the key)

**Rent payer**:
Whoever paid the rent of a trader's accounts and gets it back after exit.

**Relayer**:
The only privileged service: it ticks markets, makes the commit, sponsors onboarding and serves public data. It stores no private state.
_Avoid_: backend, server, indexer (the indexer is only its public part)

**Janitor**:
The part of the relayer that closes traders' accounts after exit and returns the rent.

**Scheduler**:
The ER mechanism that calls scheduled tasks by itself, without the relayer.
_Avoid_: scheduler-crank, cron

### Trader accounts

**UserAccount**:
The trader's private account with their margin.

**Positions**:
The trader's private account with all their slots, history and orders.
_Avoid_: Position (a per-market position account is the old model, it no longer exists)

**Slot**:
A place in **Positions** for one open position. One position per market; the market is recorded in the slot itself.
_Avoid_: unqualified "slot" when Solana slots are discussed nearby — then say "position slot"

**Position**:
An open slot: side, size, margin and entry price on one market.

**History**:
The ring of the latest closes in **Positions**, visible only to the owner. A new close pushes out the oldest.
_Avoid_: disclosures, ledger (trades are not disclosed)

**Archive**:
A copy of the history on the device that keeps records already pushed out of the ring.

**Order**:
A trader's conditional order (limit, stop, TP, SL, trailing) in **Positions**, executed by the liquidation task.
_Avoid_: order-book order (there is no order book)

**Free margin**:
The trader's margin not tied to any position; it can be withdrawn.

**Locked margin**:
Margin allocated to open positions. Every position has its own (isolated).

### Market and pool

**Market**:
One perp, identified by its symbol. It has its own parameters, feed and mark.

**Symbol**:
The market's name (`SOL`, `BTC`), which is also its address.
_Avoid_: ticker, coin, pair

**Market registry**:
The list of markets that the relayer publishes for the app.

**MarketRisk**:
The market's private account with open interest. It is not served outside.

**PoolLive**:
The pool's private working state, written by every trading and money action.

**Pool**:
The public pool snapshot, coarsened in favour of a reader of solvency. Updated only by the commit.
_Avoid_: unqualified "pool" when it matters whether it is the live state or the snapshot

**BalancesRoot**:
The public root over traders' balances, against which a trader proves their balance.

**Receipt**:
The proof of a trader's balance against **BalancesRoot**.
_Avoid_: disclosure receipt, proof of trade

**FeeEscrow**:
The protocol's shared account that pays for commits and scheduler tasks.

### Price and liquidation

**Index**:
The price from the oracle.

**Mark**:
The market's smoothed price, used for PnL and liquidation.
_Avoid_: price (unqualified), oracle price

**Print**:
One price update from the oracle.

**Accepted print**:
A new print that passed the oracle checks. Only it moves the market's sample counter.

**Sample**:
The sequence number of an accepted print on a market. A liquidation tick is counted once per sample.

**Stale**:
The state of a market whose latest print is too old. There are no liquidations while the price is stale.

**Crank tick**:
One call that updates a market's mark from a fresh print and checks the candidates passed to it.
_Avoid_: tick (unqualified) — "tick" also names a price record in the relayer DB and a liquidation tick

**Candidate**:
A trader with an open position on a market whom the crank tick checks for liquidation.

**Liquidation tick**:
One check in which a position was found liquidatable. A position is liquidated after several such ticks in a row.

**Hysteresis**:
The number of consecutive liquidation ticks required to liquidate. It protects against a single price spike.

**Liquidation task**:
A scheduled check of one (trader, market) pair that liquidates the position and executes orders without the relayer.
_Avoid_: liquidation crank, keeper

### Trader journey

**Onboarding**:
Creating and delegating a trader's accounts and issuing the session key, with one confirmation.

**Leg**:
One onboarding transaction.
_Avoid_: step, stage

**Sponsored**:
A leg paid by the fee payer because the owner has no SOL.

**Self-funded**:
A leg paid by the owner.

**Relayer session**:
Proof of wallet ownership that opens sponsoring to the owner. It gives no access to private state.
_Avoid_: session (unqualified), login, auth token

**Deposit / Withdrawal**:
The movement of dUSDC between the owner's wallet and free margin.

**Exit**:
Returning a trader's accounts from the ER to L1 when there are no positions and no margin.
_Avoid_: exit with debt, partial exit (they no longer exist), undelegate (that is the instruction name)

**Exited**:
The trader's state between exit and the janitor closing their accounts. Onboarding waits in this state.

**dUSDC**:
The protocol's test stablecoin on devnet, issued by the faucet.
_Avoid_: USDC

### Chart

**Timeframe**:
The candle interval the trader chooses.

**Tier**:
One of the three stored candle sizes from which all timeframes are built.

**Backfill**:
Historical candles from an external source that fill the time before our ticks existed. An oracle candle always wins.

## Relationships

- An **Owner** has one **UserAccount** and one **Positions**; both are private accounts whose members are the owner, the session key and the crank
- **Positions** holds slots, the **History** and orders; a **Slot** belongs to one **Market**
- A **Position** takes **Locked margin** from **Free margin** and returns it on close
- A **Crank tick** gives a **Market** a new **Sample**; a **Liquidation task** only reads the market, so nobody is liquidated without crank ticks
- **PoolLive** changes on every action; **Pool** and **BalancesRoot** are updated only by the **Commit**
- **Exit** moves the trader to **Exited**; the **Janitor** closes the accounts and returns the rent to the **Rent payer**

## Flagged ambiguities

- "crank" meant the key, the call and the scheduled task. Resolved: **Crank** is the key; the call is a **Crank tick**; the per-trader task is a **Liquidation task**.
- "session" meant both the trading key and access to the relayer. Resolved: **Session key** versus **Relayer session**.
- "slot" means a position's place, a Solana slot (separately on L1 and in the ER) and a nonce number. Resolved: **Slot** is only a position's place; the rest always carry a qualifier ("ER slot", "L1 slot").
- "tick" means a crank tick, a liquidation tick and a price record in the DB. Resolved: always qualified.
- "Position" used to be a separate per-market account. Resolved: the account is **Positions**, one position is a **Slot**.
- "disclosure", `Disclosure`, `Commitment`, `DisclosureQueue` — a cancelled model. These words are no longer in the project language; a trader's own history is the **History**.
