# services/relayer

Crank fallback for the Dexxer ER scheduler, packaged as an always-on Railway
service (moved from `scripts/crank-fallback`, Task 4 / week 4). Holds ONLY
`crank` and `fee_payer` keys — never owner/session tokens — and reads only
public accounts, the oracle, and the private accounts `crank` is already a
permission member of (privacy rule, see repo `CLAUDE.md`).

## What it does

- `src/crank.ts` — the 1s `crank_tick` loop (liquidation candidates via
  `getProgramAccounts`), moved from `scripts/crank-fallback/index.ts`.
- `src/disclosure.ts` — the ~5-min `set_balances_root` + `commit_aggregate`
  + `mark_committed` cycle, moved unchanged (import paths only) from
  `scripts/crank-fallback/disclosure.ts`.
- `src/keys.ts` — `keypairFromEnv(name, fileFallback)`: bs58 secret key from
  an env var in production, `tests/er/.keys/<fileFallback>.json` (via
  `loadOrCreateKey`) for local dev.
- `src/health.ts` — `GET /healthz`, Railway's healthcheck target.
- `src/db.ts` — Postgres pool + startup SQL migrations
  (`migrations/*.sql`).
- `src/indexer/` (Task 5) — public-data indexer: oracle price candles,
  `Pool`/`BalancesRoot` snapshots, the `Disclosure` feed, REST + WS. See
  "Indexer" below.
- `src/index.ts` — wires the above together, graceful `SIGTERM`.

## Indexer (Task 5)

`INDEXER_ENABLED=true` (needs `DATABASE_URL`) starts a second subsystem,
independent of the crank loop, that reads ONLY public data — never
`cfg.crank`/`cfg.feePayer` — and mirrors it into Postgres for REST/WS
clients (the mobile app, a dashboard, anything that wants prices/pool
health/disclosures without running its own RPC subscriptions):

- `src/indexer/prices.ts` — `decodeFeed(data)`, a byte-for-byte TS port of
  `programs/dexxer_core/src/oracle.rs::parse_price_update` (same offsets,
  golden-vector-tested against that file's own Rust unit tests in
  `test/feed.test.ts`). The oracle account is read on the **TEE RPC with NO
  auth token** (`wss://devnet-tee.magicblock.app`, unauthenticated) — the
  feed account is public even though it lives behind the TEE endpoint; base
  RPC only holds a stale committed copy.
- `src/indexer/candles.ts` — pure OHLC bucketing (`pushTick`/
  `aggregateCandles`), no DB — see `test/candles.test.ts`.
- `src/indexer/accounts.ts` — subscriptions with poll-fallback/reconnect for
  the oracle feed, `Pool`, `BalancesRoot` (all base-RPC `onAccountChange`
  where applicable), plus `Disclosure` discovery (`getProgramAccounts`
  memcmp every 30s + `onProgramAccountChange`).
- `src/indexer/store.ts` — Postgres read/write helpers for the four tables
  in `migrations/001_indexer.sql` (`ticks`, `pool_snapshots`, `disclosures`,
  `roots`).
- `src/indexer/http.ts` — the REST router (mounted on the same Express
  `app`) and `attachWs` (a `ws` server on the same HTTP server, path `/ws`).

### REST API

All endpoints return JSON. Base URL: the relayer's own domain.

| Method & path | Query params | Returns |
| --- | --- | --- |
| `GET /prices` | `tf` (`1m`\|`5m`\|`15m`, default `1m`), `limit` (default 300, max 1000) | `{ tf, candles: [{ t, o, h, l, c }] }` — `t` unix ms, `o/h/l/c` are plain numbers (SOL/USD price, 1e6 scale) |
| `GET /mark` | — | `{ price, slot, ts, stale }` — `price` is a **string** (see Numbers below), or all-`null`/`stale:true` if no tick has landed yet. `stale = now - ts > ORACLE_STALE_MS` (30s) — see "Oracle staleness" below |
| `GET /pool/history` | `limit` (default 100, max 1000) | array of Pool snapshot rows, oldest→newest |
| `GET /pool/latest` | — | one Pool snapshot row, or `null` |
| `GET /disclosures` | `limit` (default 100, max 1000) | array of closed-trade disclosure rows, newest `closed_slot` first |
| `GET /root/latest` | — | `{ root_slot, filled, leavesHex }`, or `null` |
| `GET /healthz` | — | (Task 4) health payload, now also carrying `indexer: { ticks, lastTickTs, lastPoolSlot, disclosures, wsClients, oracleStale }` |
| `GET /ws` (WebSocket, not REST) | — | pushes `{type:"mark",price,ts,stale}` (throttled to ≤1/s while live; exactly one extra `stale:true` frame when the feed transitions to stale — see below), `{type:"pool",...}` on a new Pool snapshot, `{type:"disclosure",...}` on a newly discovered Disclosure |

### Oracle staleness (fix round 1)

The base-layer copy of the delegated oracle feed is a stale **commit**
snapshot (it only updates when `commit_aggregate` runs, not on every price
tick) — failing over to it during a TEE outage would present frozen prices
as if they were live, which is worse than being honest about the outage.
So there is **no base-RPC fallback** for prices: the TEE reconnect/poll
loop (`indexer/accounts.ts`) is the only oracle source, and staleness is
surfaced explicitly instead:

- `GET /mark`'s `stale` is computed per-request straight from the latest
  stored tick's age (`isStale(ts, now, ORACLE_STALE_MS)`,
  `ORACLE_STALE_MS = 30_000`, `src/indexer/prices.ts`).
- The WS `mark` stream carries `stale` on every frame; while the feed is
  live those are the normal throttled (≤1/s) `stale:false` frames, and the
  moment the feed goes quiet for `ORACLE_STALE_MS` a watchdog emits exactly
  **one** `stale:true` frame (not spammed every second for the whole
  outage) using the last known price.
- `/healthz`'s `indexer.oracleStale` is the same predicate against
  `indexer.lastTickTs` — `true` if the indexer has never ticked at all.
- `/prices` (candle history) is unaffected — it doesn't claim to be "now".

A Pool snapshot row: `{ slot, ts, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total }`.
A disclosure row: `{ pubkey, side, size, entry, exit, pnl, fees, reason, opened_slot, closed_slot, nonce, ts }`.
`ts` on a disclosure row is **ingestion time**, not `closed_slot`'s block
time — an extra `getBlockTime` per discovered account wasn't judged worth
the RPC cost for what is a rolling public archive, not a precise ledger.

### Numbers

Postgres `bigint` columns come back from `pg` as JS **strings** (no custom
type parser is installed) — `capital_total`/`protocol_liquidity`/`size`/
`entry`/`exit`/`pnl`/`fees`/`nonce`/etc could exceed `Number.MAX_SAFE_INTEGER`
(2^53) as volume grows, so `store.ts`/`http.ts` never coerce them and they
reach REST/WS clients as JSON **strings**. Candle `o/h/l/c` (SOL/USD price
in 1e6 scale) and every `slot`/`ts`/`limit`/`nonce`-adjacent small integer
stay plain JSON **numbers** — nowhere near 2^53.

## Sponsor (Task 6, fix round 1)

`SPONSOR_ENABLED=true` (needs `DATABASE_URL`) mounts `POST /sponsor` — the
`fee_payer` key co-signs a whitelisted, already owner-signed onboarding
transaction so the app can batch `faucet_init`/`init_user`/`delegateSpl`/
`delegate_user` (the two L1 legs) into a `signTransactions([...])` prompt,
with `fee_payer` fronting network fees and PDA/eSPL rent for those two legs.

The whitelist ALSO accepts `init_permissions`/`set_session`/a matching
SystemProgram session-top-up transfer (an ER leg) — that shape was tried in
the app this fix round and reverted: real devnet-tee rejects `fee_payer` as
an ER transaction's fee payer (`"InvalidAccountForFee"`) unless `fee_payer`
itself originated the tx. The app's ER leg + session top-up stay
owner-funded/owner-`feePayer` for now; this whitelist support is kept as
forward-looking, tested, currently-unused capacity. See `src/sponsor.ts`'s
header comment for the full design rationale (fix round 1, findings A/B/C).

The SystemProgram transfer branch is additionally gated behind
`SPONSOR_ALLOW_SESSION_TOPUP` (default `false` — see Env vars below): since
the app doesn't call this leg today, every SystemProgram instruction is
rejected outright by default, same as before this shape existed. Flip the
env var to `true` only once a real caller needs it (week 5).

```
POST /sponsor
{ "tx": "<base64 Transaction, owner already signed, tx.feePayer = fee_payer>" }
-> 200 { "tx": "<base64, now also fee_payer-signed>" }
-> 400 { "error": "<specific reason>" }   # not whitelisted / bad signature / budget exceeded / ...
-> 429 { "error": "...", "retryAfterMs": N }  # rate limit — see below
```

The relayer never calls `sendRawTransaction` for a sponsored tx — the
caller submits it themselves, same as every other owner-signed step in
`app/src/features/onboard/batchOnboarding.ts`.

### Whitelist (account positions validated by IDL/SDK order, fix round 1 finding B)

Every instruction below is checked by BOTH discriminator/opcode AND account
position — `fee_payer` may only ever sit at the listed `payer` index (or not
appear at all, for shapes with no `payer` column), and `owner` must sit at
the listed `owner` index and be the transaction's single non-fee_payer
signer. Each instruction shape may appear at most once per sponsored tx.

| Program | Instruction | owner idx | payer idx | Notes |
| --- | --- | --- | --- | --- |
| dexxer_core | `faucet_init` | 0 | 1 | `fee_payer` fronts `Faucet` PDA rent |
| dexxer_core | `init_user` | 0 | 1 | `fee_payer` fronts `UserAccount`/`Position`/`DisclosureQueue` rent |
| dexxer_core | `delegate_user` | 0 | — | no payer account; `fee_payer` must not appear at all |
| dexxer_core | `init_permissions` | 0 | — | permissioned accounts self-fund permission rent in the ER |
| dexxer_core | `set_session` | 0 | — | same; its `session_key` arg is cross-checked against the SystemProgram transfer below |
| eSPL | `initEphemeralAtaIx` (prefix `0`) | 2 | 1 | `fee_payer` fronts the owner's eATA rent |
| eSPL | `transferToVaultIx` (prefix `2`) | 5 | — | pure token transfer (owner's dUSDC -> vault), no payer account |
| eSPL | `delegateEphemeralAtaIx` (prefix `4`) | — | 0 | no owner account; `fee_payer` fronts delegation-record rent |
| ATA program | `CreateIdempotent` (data `[1]`) | 2 | — | OWNER-funded, not `fee_payer` (index 0 must be owner, not `fee_payer`) |
| SystemProgram | `Transfer` | — | — | rejected outright unless `SPONSOR_ALLOW_SESSION_TOPUP=true`; when enabled, exactly one per tx, `from = fee_payer`, `to` must equal the same tx's `set_session.session_key` arg, `lamports <= SESSION_FUND_LAMPORTS (10_000_000)` — the ER leg's session top-up |

Any other `programId`/discriminator/opcode is rejected outright; the
non-idempotent ATA `Create` and any other SystemProgram instruction are
never whitelisted.

### Rate limit + budget (fix round 1, findings C + post-verification)

The rate limit is enforced by a UNIQUE index on `sponsors (owner, "window",
slot)` (`"window" = floor(ts / 3_600_000)`, `migrations/002_sponsors.sql` +
`003_sponsors_window.sql` + `004_sponsors_slot.sql`) — `SponsorStore.reserve`
tries each `slot` in `0..MAX_SPONSOR_CALLS_PER_OWNER_WINDOW` in turn via an
atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so two concurrent
calls for the same owner+slot can never both succeed (the database's own
constraint is the race-closer, not application-level check-then-insert).
`MAX_SPONSOR_CALLS_PER_OWNER_WINDOW = 6` — a post-verification finding, not
one of the original A–E: a real onboarding needs up to 3 sponsored legs
(L1a, L1b, the ER leg) for the SAME owner within the same hour, so the
original "1 per owner per 60 min" ceiling could never complete one. A
reservation that later fails the daily-budget check (`SPONSOR_DAILY_SOL`,
rolling 24h across all owners) is released (`SponsorStore.release`) so that
slot isn't burned for a request that was never actually sponsored.
`/healthz`'s `sponsor` field (`{ today_sol, count_today }`) reports the
rolling 24h spend (finalized rows only).

## Env vars

| Var | Required | Notes |
| --- | --- | --- |
| `DEXXER_NET` | no (default `local`) | `devnet` switches `tests/er/lib/env.ts`'s RPC/TEE profile |
| `CRANK_KEY_B58` | prod | bs58 secret key; local dev falls back to `tests/er/.keys/devnet-crank.json` / `admin.json` |
| `FEE_PAYER_KEY_B58` | prod | same, falls back to `devnet-fee-payer.json` / `admin.json` |
| `PORT` | no (default `8080`) | HTTP port |
| `DATABASE_URL` | prod | Postgres connection string (Railway reference variable to the Postgres plugin); unset = no persistence, `/healthz`'s `db` reports `"error"` |
| `CRANK_INTERVAL_MS` | no (default `1000`) | tick cadence |
| `INDEXER_ENABLED` | no (default `false`) | Task 5: starts the public-data indexer (see above) — needs `DATABASE_URL`, disabled with a warning if it's unset |
| `SPONSOR_ENABLED` | no (default `false`) | Task 6: starts `POST /sponsor` (see below) — needs `DATABASE_URL`, disabled with a warning if it's unset |
| `SPONSOR_DAILY_SOL` | no (default `0.5`) | rolling 24h cap on sponsored lamports across all owners |
| `SPONSOR_ALLOW_SESSION_TOPUP` | no (default `false`) | gates the whitelist's SystemProgram session-top-up branch (see Whitelist above) — week-5 route, unused by the app today |

Never commit key values. Encode a local keyfile for Railway with:

```ts
bs58.encode(Uint8Array.from(JSON.parse(readFileSync("tests/er/.keys/devnet-crank.json"))));
```

## Local dev

```sh
cd services/relayer
npm install
DEXXER_NET=devnet npm start   # crank + fee-payer keys auto-loaded/created under tests/er/.keys/
curl localhost:8080/healthz
```

To also exercise the indexer locally, set `INDEXER_ENABLED=true` and point
`DATABASE_URL` at a reachable Postgres (the Railway Postgres plugin's
*public* proxy URL for a laptop — `railway variables --service Postgres`
after `railway link`, never a value to paste into files/reports):

```sh
DEXXER_NET=devnet INDEXER_ENABLED=true DATABASE_URL=postgresql://... npm start
curl "localhost:8080/prices?tf=1m&limit=10"
curl localhost:8080/mark
curl localhost:8080/pool/latest
curl "localhost:8080/disclosures?limit=5"
```

Without `DATABASE_URL` set, `db.ts` logs a warning and runs without
Postgres — the crank loop is unaffected; only `/healthz`'s `lastTickAt`/
`lastCommitAt` persistence across restarts and its `db` field are skipped.

## Tests

```sh
npm test        # node:test — keypairFromEnv b58 round-trip, health-payload staleness logic,
                 # candles.ts bucketing (pure), prices.ts::decodeFeed (golden vectors vs oracle.rs),
                 # prices.ts::isStale (staleness predicate)
npx tsc --noEmit
```

## Docker / Railway

Build context is the **repo root**, not `services/relayer/` — see
`Dockerfile`'s header comment for why (it needs `tests/er/lib/*.ts` and the
committed `app/src/idl/dexxer_core.json`). Railway service config: root
directory `/`, `RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile`.

Deployed project/service ids, domain, and PDA/program references live in
`docs/deployments.md` (repo root).
