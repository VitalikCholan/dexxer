# Dexxer

A private perpetual DEX for Solana Seeker, built on MagicBlock Private
Ephemeral Rollups (PER, TEE). A position is visible only to its owner —
trackers, copy bots and we ourselves see only what is public by design: a
coarsened pool snapshot, the `BalancesRoot` receipt and a 13F disclosure
without an address.

## What it is

Dexxer is its own perp core (not an omnibus over Jupiter, not a fork of an
existing protocol) on the MagicBlock template: a position is a delegated PDA
inside a TEE (Intel TDX) with the permission list `[owner, session, crank]`.
No account with position fields is committed to L1 before close — the base
layer shows only an account under the Delegation Program with its onboarding
bytes, without a single trade field. Privacy here is a **read filter in the
TEE**, not encryption: L1 has no such filter, so a raw private account never
lands there as is; everything that must leave goes out only through a
separate public derived account (`Pool` snapshot, `BalancesRoot`,
`Commitment`/`Disclosure`). The privacy claim is: from trackers, copy bots
and from us; **not** from Intel and not from the MagicBlock operator.

```mermaid
flowchart LR
    W[Wallet<br/>MWA / Seed Vault] --> APP[Mobile app<br/>owner-conn · session-conn]
    APP -- owner/session TEE --> ER
    subgraph ER["MagicBlock PER (TEE)"]
        POS["Position / UserAccount / DisclosureQueue<br/>permissioned [owner, session, crank]"]
        PL["PoolLive / MarketRisk<br/>permissioned [crank, admin]"]
    end
    CRANK[services/relayer<br/>crank · indexer · sponsor] -- crank/fee_payer --> ER
    ER -- "commit_aggregate, ~5 min batch" --> L1
    subgraph L1["Solana L1 (public)"]
        POOL["Pool — snapshot, 100 dUSDC step"]
        ROOT["BalancesRoot"]
        DISC["Commitment / Disclosure"]
    end
    CRANK -- "reads only public data + oracle" --> L1
    APP -- "reads public data directly" --> L1
```

## What has been built (MVP, weeks 0–4)

- **Week 0** — 10/11 spike checks PASS (privacy in the TEE, eSPL,
  scheduler, MWA with an ER blockhash, `verifyTeeRpcIntegrity` on Hermes).
- **Week 1** — perp core without privacy: margin, liquidation, crank,
  pool invariant; toolchain pitfalls documented (nightly for LiteSVM).
- **Week 2** — privacy (`[owner, session, crank]`), devnet-tee deployment of
  `dexxer_core`, `withdraw`, scheduler + `commit_aggregate` through a
  delegated `FeeEscrow`, mobile skeleton (TEE connection, session store,
  Trade/Position).
- **Week 3** — 13F disclosure (commit-then-reveal through `commit_aggregate`),
  `BalancesRoot` (zero-copy, keccak256), `undelegate_user`/trustless exit,
  History/Receipt screens, first CI.
- **Week 4** — `PoolLive` private aggregate + `Pool` as a public coarsened
  snapshot (risk #24 closed), `services/relayer` on Railway (crank + public
  indexer + `/sponsor`), onboarding in ≤2 signatures with sponsored rent,
  `i64::MAX` scheduler on the live schedule (mark backstop), design tokens +
  5-tab UI from Claude Design mockups.
- **Week 5** — reliability without the relayer: per-position
  `liquidation_check` (the scheduler in the TEE actually liquidates, not only
  moves the mark — risk #18 fully closed), close frees the position at once
  and pushes a record into `DisclosureQueue` (`mark_committed` removed),
  reveal in one cycle at zero delay, exit with disclosure debt (partial
  `undelegate_user` + `close_orphan_queue`/`close_exited_user`), **0-SOL
  onboarding** (`DelegateUser.payer`, new `/sponsor` shapes — measured 0
  lamports on the owner, including the ER leg), identity-aware MWA auth
  token, two devnet program upgrades, a relayer with quarantine for poisoned
  queues.
- **Week 6** — relayer SIWS sessions for `/sponsor`/`/nonce`, multi-market
  (SOL/BTC/ETH/HYPE/ZEC), position slots (one `Positions` for 16 markets,
  trade disclosure cancelled, history is a private ring), **clean start on
  devnet 01.10.2026** — new program `Fyg2…UfCY`, with the relayer and the
  dev-client APK on it; scheduler-only liquidation measured at 8.5–10.2 s,
  relayer liquidation at 2.9 s; the fakewallet smoke passed steps 1–7 of 9
  (1 — by logs and L1, 2–7 — as reported by the owner).

Details and measured numbers — `docs/superpowers/plans/weeks0-5-history.md`
(weeks 0–5) and `docs/superpowers/plans/week6-history.md`.

**Outdated since 01.10.2026:** the description of privacy and disclosure above and below (13F,
`Commitment`/`Disclosure`, `DisclosureQueue`, `Position` per market) is the state before week 6; the
current model is spec §2.9.

## Quick start

### Prerequisites

- Anchor `1.0.2`, Solana CLI `3.1.9`, Rust `1.89` (pinned in
  `rust-toolchain.toml`)
- Additionally `rustup toolchain install nightly-2026-09-18` — needed only
  for the LiteSVM tests (transitive `solana-syscalls`, see `CLAUDE.md`)
- Node `24` (via `nvm`; `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`
  in the examples below — substitute your version)

### Program and tests

```sh
anchor build

cargo test -p dexxer_core                                 # unit — 61/61
cargo +nightly-2026-09-18 test -p dexxer_litesvm            # LiteSVM — 87/87
```

### ER/devnet scripts (`tests/er/`)

```sh
cd tests/er
npm ci
npm run q1              # local mb-stack: deposit
npm run q2               # local mb-stack: permissions
DEXXER_NET=devnet npm run devnet:onboard    # example devnet script; full list — tests/er/README.md
```

### Relayer (`services/relayer`)

```sh
cd services/relayer
npm ci
npm test                 # 100/100 — candles, feed golden vectors, health, shutdown, keys,
                          # sponsor whitelist/rate-limit, orphan janitor, disclosure quarantine/rotation
npm run dev               # local run (DEXXER_NET=devnet, needs CRANK_KEY_B58/FEE_PAYER_KEY_B58 env)
```

Live week-5 env (values on Railway, details — `docs/deployments.md`):
`COMMIT_INTERVAL_TICKS=60` (replaces the hard-coded `DISCLOSURE_EVERY_TICKS`, default 300),
`COMMIT_MAX_ACTIONS=4` (default; the real MagicBlock bridge rejects 8 real actions at once —
measured), `QUARANTINE_CYCLES` (default 10, isolates a queue that fails twice in a row).

### Mobile app (`app/`)

MWA does not work in Expo Go — a dev build is required:

```sh
cd app
npm ci
npx expo run:android      # dev build; or npm run android
npx tsc --noEmit
npm run lint:check         # expo lint
```

To test on an emulator without a real wallet — fakewallet:

```sh
npx solana-mobile@latest device install fakewallet
```

The crank-fallback script and the week-1 CLI demo are in `scripts/` (`npm run crank`,
`npm run week1`).

### Devnet addresses and live services

The full, current list is in `docs/deployments.md`. In short:

| | |
|---|---|
| `dexxer_core` program id | `Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY` (position slots, plan 4; the old one is `G2ok…`, see `docs/deployments.md`) |
| Base RPC | `https://rpc.magicblock.app/devnet` |
| ER/TEE | `https://devnet-tee.magicblock.app` |
| Relayer/indexer | `https://relayer-production-1ae7.up.railway.app` |

Relayer/indexer endpoints:

| Endpoint | What it returns |
|---|---|
| `GET /healthz` | crank/fee-payer balance state, tick/commit, indexer status, `schedulerActive` |
| `GET /mark` | latest mark price (with a `stale` flag) |
| `GET /prices?tf=1m\|5m\|15m&limit=N` | OHLC candles |
| `GET /pool/latest` | latest `Pool` snapshot (capital/locked/fees/…) |
| `GET /markets` | market symbols (SOL first); `?market=` on `/mark`/`/prices`, `/ws?markets=` |
| ~~`GET /disclosures?limit=N`~~ | **404 since 01.10.2026** — trade disclosure cancelled (spec §2.9) |
| `GET /root/latest` | latest `BalancesRoot` (root_slot, leaves) |
| `wss://…/ws` | live `mark`/`pool` frames (no `disclosure` frame since 01.10.2026) |

The `dUSDC` mint is our own faucet mint, generated by the bootstrap script
(`Config.dusdc_mint`, not a fixed address in this README — the protocol funds
the pool on every clean devnet deployment).

## How it works (in short)

- **Privacy = a read filter in the TEE/QFS, not encryption.** A permissioned
  account (`Position`/`UserAccount`/`DisclosureQueue`) blocks reads for
  everyone except `[owner, session, crank]`; the bytes are never encrypted —
  that filter does not apply on L1, so a raw private account is not committed
  there.
- **`PoolLive` vs `Pool`.** Every action (open/close/deposit/withdraw/
  liquidation) writes only the private working aggregate `PoolLive` (`[crank,
  admin]`, never committed). Once every ~5 min `commit_aggregate` publishes a
  rounded snapshot into `Pool` (step `SNAPSHOT_STEP = 100 dUSDC`: assets
  down, liabilities up) — this is the only thing the world sees on L1.
- **Commit-then-reveal, queue-first (week 5).** A closed position at once
  pushes a record into the private `DisclosureQueue` and frees `Position` —
  the `commitment` (a keccak256 hash of the trade details) and the disclosure
  itself (`Disclosure`, without the owner's address) leave the queue in one
  `commit_aggregate` batch (`write_commitment`/`write_disclosure`). The
  program ceiling is `MAX_ACTIONS_PER_COMMIT = 8`; the live relayer default
  is `COMMIT_MAX_ACTIONS = 4` — the real MagicBlock bridge rejects 8 real
  actions at once (measured).
- **One-tap onboarding, 0 SOL (week 5).** The app assembles the whole
  onboarding into a batch (`signTransactions`); the rent of all three PDAs
  and the delegation is now sponsored through the relayer's `POST /sponsor`
  (`DelegateUser.payer` separate from `owner`, new ATA/delegate shapes) —
  measured **0 lamports on the owner** over the whole cycle, including the
  ER leg (permissions+session), on live 0-SOL wallets (M-I,
  `weeks0-5-history.md#week-5`).
- **The relayer is the only privileged service.** `services/relayer` holds
  only the `crank`/`fee_payer` keys, never owner/session tokens; it reads
  only public accounts and the oracle. The client reads private state
  directly over the owner TEE connection (`accountSubscribe`), not through
  the relayer.

## Honest limitations

- **The anonymity set is small** — there are only a handful of testers; the
  `Pool` snapshot is rounded to 100 dUSDC, but with few concurrent traders,
  differencing between snapshots can still reveal activity (risk #24,
  removed architecturally this week, differencing remains). The full
  solution is a ZK proof of solvency over a private root (spec §2.4.5),
  post-MVP.
- **Trust in the TEE (Intel/the MagicBlock operator).** A hardware
  guarantee, not a cryptographic one; `verifyTeeRpcIntegrity` checks that
  the TDX quote is genuine but does not match MRTD/RTMR against a code
  allowlist (v1).
- **Liquidations are now scheduler-driven; `services/relayer` is a fallback,
  not a single point of failure (week 5).** `liquidation_check` is a separate
  scheduler task per position, registered by the program itself; measured
  PASS on devnet — liquidation without a single relayer call in 6.97 s
  (risk #18 fully closed, not only the week-4 mark backstop).
  `services/relayer`/`crank-fallback` is still needed as a second
  independent path and for everything else (commits, indexing, sponsor).
- **Reveal in one cycle, with a known bridge defect.** At zero disclosure
  delay, commit + reveal reach L1 in one `commit_aggregate` cycle
  (measured). One specific queue on devnet is rejected by the MagicBlock
  bridge at every tested action budget (tuning does not help) — that trader
  stays blocked on `QueueFull` until a program fix (week 6); the relayer
  isolates the problem with quarantine so it does not block other traders'
  disclosures.
- **Exit with disclosure debt.** Exit does not wait for the reveal — a
  partial `undelegate_user` leaves the queue delegated to the crank, which
  drains and closes it afterwards (`close_orphan_queue`/`close_exited_user`);
  the rent returns to the owner. Measured end to end on 0-SOL wallets (M-I).
- **Onboarding is 0 SOL, measured, not just partly sponsored (week 5).**
  `DelegateUser.payer` + the new `/sponsor` shapes closed the last
  owner-funded remainder (≈0.004 SOL in week 4) — on live 0-SOL wallets the
  whole cycle, including the ER leg, cost 0 lamports (risk #22 fully
  closed).
- **One position per market**, devnet-only, a test `dUSDC` mint, our own
  test pool as the PnL counterparty — not real liquidity. 4 legacy positions
  from weeks 1–2 are stuck forever on the old account layout (a permanent OI
  offset on the market).
- The full list of risks (#1–#36, with mitigations and status) —
  `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §7.1.

## Roadmap

Post-MVP upgrades (spec §2.4.5):

- A Merkle root instead of the flat `BalancesRoot` list when N > 64.
- The program computes the root itself, incrementally (without a crank
  assertion).
- Our own L1 vault instead of eSPL → sovereign exit.
- A ZK proof of solvency (Groth16/BN254) over a private root — the public
  snapshot carries only `root + proof + coarsened ratio`, without raw
  aggregates.
- Disclosure/root cycles inside the MagicBlock scheduler (needs a candidate
  registry in the program).
- Funding rate, TP/SL, multi-market, TEE attestation in the app, iOS.

## Documents

- `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` — the source of
  truth for the MVP (scope, accounts, math, program, client, tests, risks,
  calendar).
- `docs/dexxer-architecture.md` — rationale, leak model, competitive frame
  (§2.1 is outdated where it differs from the spec).
- `docs/dexxer-mobile-stack.md` — mobile
  stack (partly outdated, replaced by the spec).
- `docs/superpowers/plans/weeks0-5-history.md` — condensed plans and measured
  results for weeks 0–5; `docs/superpowers/plans/week6-history.md` — week 6.
- `docs/deployments.md` — live devnet addresses, PDAs, relayer/Railway,
  scheduler `task_id` (no secrets).
- `services/relayer/README.md` — crank/indexer/`/sponsor` from the inside.
- `CLAUDE.md` — architecture decisions and the repository's working rules.
