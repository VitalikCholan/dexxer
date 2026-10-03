# services/relayer

Crank fallback for the Dexxer ER scheduler, packaged as an always-on Railway
service (moved from `scripts/crank-fallback`, Task 4 / week 4). Holds ONLY
`crank` and `fee_payer` keys — never owner/session tokens — and reads only
public accounts, the oracle, and the private accounts `crank` is already a
permission member of (privacy rule, see repo `CLAUDE.md`).

## What it does

- `src/crank.ts` — the 1s `crank_tick` loop, moved from
  `scripts/crank-fallback/index.ts`. Per loop: one `getProgramAccounts` over
  `Positions` (candidate discovery, `openCandidates`: `UserAccount` reads are
  paged by 100 — the `getMultipleAccountsInfo` limit — and a trader without a
  decodable `UserAccount` is skipped), then **`crank_tick` per market,
  serially**, in chunks of `CRANK_TX_MAX_CANDIDATES = 12` pairs.
  - **Which markets** (`tickSet`): SOL always (`withSol`), every market of the
    registry, every market this process has ever ticked (sticky — a registry
    that shrinks or fails never stops a market), and every market that has
    open candidates this loop; a market nobody listed has its PUBLIC `Market`
    account read once and is ticked from then on (a failed read is logged on
    change and retried next loop). The registry's privacy gate (below)
    protects what the relayer publishes, not liquidation.
  - **One market's sends** (`src/candidates.ts` `tickCandidates`): a chunk
    rejected ON CHAIN is followed by a zero-candidate probe. Probe rejected
    too → the market is broken: nobody is blamed, the market's later chunks
    are skipped. Probe lands → the chunk is retried one candidate per
    transaction, and a pair rejected alone on chain is quarantined for
    `CRANK_BAD_PAIR_COOLDOWN_MS` (default 60 000, min 5 000).
  - **Errors** (`src/errors.ts` `classifyError`, one classifier for the
    crank, the candidates and the janitor), three classes:
    - *on-chain* — the transaction landed and the program rejected it
      (probe / singles / quarantine above);
    - *shared* — plausibly every market: 401/unauthorized, network (`fetch
      failed`, `ECONN*`, `ETIMEDOUT`, socket hang up), 429 / rate limit, 5xx,
      `freshBlockhash timeout`. The first one stops the market AND the rest
      of the loop, one reconnect, and the next loop starts at the market
      AFTER the one that stopped it (`rotateMarkets`, wrapping) — no market
      is starved. Without a short-circuit the order is SOL first, then the
      tick set;
    - *market-local* — everything else, including `confirmSignature timeout`
      (one market's dropped transaction) and a client-side throw while
      building its instruction: no singles, one zero-candidate tick for that
      market (its mark and price sample still advance if only the candidate
      transaction is the problem), then that market is done for the loop;
      the other markets go on, no reconnect for that alone. But a loop in
      which NO market landed a transaction and something failed off chain
      (a market or candidate discovery) reconnects (`shouldReconnectAfterLoop`):
      a silently dead TEE token or an unhealthy node shows up market-locally
      on every market. One landed transaction, or only on-chain rejections,
      proves the connection works. A market-local chunk failure skips that
      market's later chunks for the loop; the scheduler's
      `liquidation_check` still covers those positions.
    A market repeating the same error (signature stripped) is recorded at
    most once a minute.
  - **Discovery fails** → every market is still ticked with no candidate
    (`planTick`), so mark, price sample and the scheduler's
    `liquidation_check` keep moving; that loop does not move `lastTickAt`. It
    reconnects only for an auth or network error.
  - `lastTickAt` — and so `/healthz.ok` — moves only when the **SOL** market
    ticked after a good discovery. It starts `null` in every process (not
    restored from Postgres): a fresh process answers 503 until its first such
    tick.
  - **Logs carry no trader key**: one line per landed transaction, `tick n=…
    market=… mark=… mark_slot=… sig=… cu=… bytes=… tick_ms=… candidates=<count>
    liquidated=<count>` (a field whose read failed is `null`; the reads run
    after the tick and are not awaited by the loop; `bytes` is the serialized
    length of the sent transaction, `tx.serialize().length`, against the
    1232-byte limit). Quarantine and discovery
    lines (`crank n=…`) name a trader by `tag=<8 hex>` = sha256(per-process
    random salt ‖ key) — stable within one process, not reversible. Janitor
    lines name exited owners, which are public on L1 by then.
  - **Liveness**: the commit cycle runs detached (below); a watchdog exits the
    process with code 1 when no loop iteration completed within
    `CRANK_WATCHDOG_MS` (default 120 000, min 30 000) or when one commit
    cycle has been in flight for longer than max(3 × `COMMIT_INTERVAL_MS`,
    600 000 ms) (`cycleStuck`/`cycleDeadlineMs` — the floor leaves room for
    a janitor pass waiting out L1 confirm timeouts), and `index.ts` exits with code 1 when `startCrank`
    rejects. Railway's restart policy is what restarts it — the repo's
    `railway.json` asks for `ALWAYS` (plan 4: the exits are deliberate, so a
    capped `ON_FAILURE` retry count would end in a permanently dead crank),
    and that policy is now applied on the live service (caveat below) — the healthcheck
    runs only at deploy time, a later 503 restarts nothing. Because
    `/healthz` is 503 until the new process's first SOL tick,
    `railway.json`'s `healthcheckTimeout` is 180 s (was 30 s) so a slow
    first loop does not fail a healthy deploy. **Caveat (measured at the
    plan-4 deploy, 01.10.2026):** Railway does not read
    `services/relayer/railway.json` (no config-as-code path is set on the
    service), so the live deployment still runs `ON_FAILURE` × 10 with a 30 s
    healthcheck from the service settings. **Update (01.10.2026, ~21:30 Kyiv):**
    Railway has deprecated config-as-code (`railway.json`/`railway.toml`) in
    favour of Infrastructure-as-Code `.railway/railway.ts` (`update-service`
    with `railwayConfigFile` is rejected with that message), so this file will
    never be applied; it stays as documentation of the intended values
    (migrating to `.railway/railway.ts` is open). The values were set directly
    in the service settings via the Railway MCP `update-service`
    (`restartPolicyType = ALWAYS`, `healthcheckTimeout = 180`) and took
    effect with deployment `5a070a7c` (`railway up --service relayer --ci`).
    Between `8b33d95d` and `5a070a7c` the live policy was `ON_FAILURE` × 10 /
    30 s. Redeploy with `railway up`, not `redeploy`: a deployment uploaded by
    `railway up` has no repo source to rebuild from (MCP `redeploy` →
    `3d1ccce7` failed at BUILD_IMAGE, live deployment unaffected). The first
    SOL tick came 6.7 s after container start.
- `src/candidates.ts` — turns raw `Positions` accounts into
  `crank_tick` candidate **pairs** `[Positions, UserAccount]`: one candidate
  per OPEN slot (a trader only enters the batch of a market they hold a slot
  on), a repeated `(Positions, market)` is dropped, an account of the wrong
  length or discriminator is skipped with a log (the program would abort the
  whole batch on it — Anchor 3002 — so junk is filtered here); plus the
  per-market send plan above. `CRANK_TX_MAX_CANDIDATES = 12` is the
  measured legacy-tx limit: a tick tx is `383 + 66·n` bytes (12 → 1175 B,
  13 → 1241 B > 1232).
- `src/markets.ts` — the market registry: `getProgramAccounts` of the public
  `Market` accounts in the ER every `MARKETS_REFRESH_MS`; a failed refresh
  keeps the last good list; one refresh in flight at a time. A market is
  listed only once its `MarketRisk` is private — the `EphemeralPermission` PDA
  of `MarketRisk` must be owned by the Permission Program (an ACCOUNT-OWNER
  read over the crank's TEE connection; the crank is a `MarketRisk`
  permission member). A market that is not yet private is logged once. If the
  owner read fails the whole refresh fails and the last good list stays.
  `/markets` and the indexer take their markets from it (the crank too, plus
  the sticky set above), so a market added with `add-market` is picked up
  without a restart. `MarketRisk` data is never read.
- `src/commit.ts` — the fixed-interval cycle, run **by wall-clock time**
  (`COMMIT_INTERVAL_MS`, not a tick count, so it does not stretch with the
  number of markets) and **detached from the tick loop**
  (`createCycleRunner`: the loop starts it and does not wait; at most one
  cycle in flight; on `SIGTERM` the in-flight cycle is awaited before the
  loop's promise resolves): `set_balances_root` (`runRootCycle`; a failed
  batch throws and is recorded) then `commit_aggregate()` (`runCommitCycle`)
  — no arguments, no actions, no `remaining_accounts`; trades are not
  disclosed. Root, commit and janitor run isolated (`runIsolated`): a failure
  of one does not skip the others; `lastCommitAt` moves only when the commit
  step succeeded. A 401 inside the cycle makes the loop reconnect.
- `src/janitor.ts` — one base-layer pass per commit cycle: every owner whose
  `UserAccount` and `Positions` are both back under `dexxer_core` and
  `UserAccount.exited` is set -> `close_exited_user` (signed by `fee_payer`),
  rent to `UserAccount.rent_payer` as read from the account (risk #39), not to
  `fee_payer`. The scan is filtered server-side (`dataSize` + discriminator +
  the `exited` byte at offset 142, pinned by a test). Spend is bounded:
  the pass is skipped while `fee_payer`'s base balance is below
  `JANITOR_MIN_FEE_PAYER_SOL` (default 0.002); at most
  `JANITOR_MAX_ATTEMPTS_PER_CYCLE = 8` close attempts per cycle (successes
  and failures — sends skip preflight, a failure still pays a fee); a
  per-owner cooldown `JANITOR_RETRY_COOLDOWN_MS` after a close the program
  rejected on chain (per process; a restart retries each failing owner
  once); the first *shared* failure aborts the pass with no cooldown for
  that owner; any other failure counts as an attempt and sets no cooldown,
  and the pass goes on — but two such close failures in a row
  (`JANITOR_MAX_CONSECUTIVE_FAILURES`) stop the pass, so a dead L1 path
  costs at most two confirmation waits per cycle. One confirmation wait
  (`confirmSignature`) is at LEAST 10 s — 100 polls × (100 ms + RTT) — plus
  up to 5 s for a fresh blockhash on the crank's sends. Idempotent; state is re-derived from chain every cycle.
- `src/keys.ts` — `keypairFromEnv(name, fileFallback)`: bs58 secret key from
  an env var in production, `tests/er/.keys/<fileFallback>.json` (via
  `loadOrCreateKey`) for local dev.
- `src/health.ts` — `GET /healthz`: Railway's deploy-time healthcheck and
  the target for an external uptime monitor (none is configured yet).
- `src/db.ts` — Postgres pool + startup SQL migrations
  (`migrations/*.sql`).
- `src/indexer/` (Task 5) — public-data indexer: oracle price candles,
  `Pool`/`BalancesRoot` snapshots, per-market ticks, REST + WS. See
  "Indexer" below. There is no trade-disclosure feed: trades are not
  disclosed (spec §2.9), `/disclosures`, `/stats` and the WS `disclosure`
  frame are gone (404).
- `src/index.ts` — wires the above together, graceful `SIGTERM`.

## Indexer (Task 5)

`INDEXER_ENABLED=true` (needs `DATABASE_URL`) starts a second subsystem,
independent of the crank loop, that reads ONLY public data — never
`cfg.crank`/`cfg.feePayer` — and mirrors it into Postgres for REST/WS
clients (the mobile app, a dashboard, anything that wants prices/pool
health without running its own RPC subscriptions):

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
  the oracle feed (one per market), `Pool`, `BalancesRoot` (all base-RPC
  `onAccountChange` where applicable).
- `src/indexer/store.ts` — Postgres read/write helpers for the four tables
  in `migrations/001_indexer.sql` (`ticks`, `pool_snapshots`, `disclosures`,
  `roots`). The `disclosures` table is kept in the schema but nothing reads or
  writes it any more (never dropped).
- `src/indexer/http.ts` — the REST router (mounted on the same Express
  `app`) and `attachWs` (a `ws` server on the same HTTP server, path `/ws`).

### REST API

All endpoints return JSON. Base URL: the relayer's own domain.

| Method & path | Query params | Returns |
| --- | --- | --- |
| `GET /markets` | — | `[{ symbol, market, feed, params: { maxLevBps, imrBps, mmrBps, openFeeBps, closeFeeBps, liqFeeBps, oiCap, maxPosition, minSize, maxStalenessSecs, pausedOpen } }]` — public `Market` fields only (no `MarketRisk`), `market`/`feed` base58, u64s as strings, SOL first then alphabetical; `[]` until the registry's first successful read (treat as "SOL only") |
| `GET /prices?tf=<tf>&limit=<n>&market=<SYM>` | — | `{ market, tf, candles: [{ t, o, h, l, c }] }` (o/h/l/c 1e6-scaled numbers, `t` bucket start ms). `tf` is one of `1s 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 24h 2D 5D 1W 1M` (400 otherwise, the error lists them); `limit` default 300, max 1000. `1s` is aggregated from raw ticks (gaps where the oracle printed nothing); every other tf is merged at read time from the stored tier (`1m` → 1m…30m, `1h` → 1h…12h, `1d` → 24h…1M). `1W` buckets start Monday 00:00 UTC, `1M` on the 1st; `2D`/`5D` are fixed widths from the epoch. |
| `GET /mark` | `market` (symbol, default `SOL`) | `{ market, price, slot, ts, publishTime, stale }` — `price` is a **string** (see Numbers below), or all-`null`/`stale:true` if no tick has landed yet. `publishTime` is the ORACLE's own `publish_time` in epoch ms; `stale = now - publishTime > ORACLE_STALE_MS` (30s) — see "Oracle staleness" below |
| `GET /pool/history` | `limit` (default 100, max 1000), `cursor` (a slot) | array of Pool snapshot rows, oldest→newest within the page; `cursor` returns the page strictly older than that slot |
| `GET /pool/latest` | — | one Pool snapshot row, or `null` |
| `GET /root/latest` | — | `{ root_slot, filled, leavesHex }`, or `null` |
| `GET /healthz` | — | (Task 4) health payload, carries `commitIntervalMs` and `indexer: { ticks, lastTickTs, lastPublishTimeMs, lastPoolSlot, wsClients, oracleStale }`, plus `markets: { SYM: { lastTickAt, tickAgeMs, lastPublishTimeMs, oracleStale } }` (a market with no tick yet reports `null`s). `ok`/`lastTickAt` = freshness of the **SOL** tick only |
| `GET /ws` (WebSocket, not REST) | `markets`: absent → **SOL only**, `*` → all, `SOL,BTC` → the listed ones | pushes `{type:"mark",market,price,ts,publishTime,stale}` (throttled to ≤1/s while live; exactly one extra `stale:true` frame when the feed transitions to stale — see below), `{type:"pool",...}` on a new Pool snapshot (to every client regardless of `markets`) |

### Oracle staleness (fix round 1; week-5 Task 5: by `publish_time`)

The base-layer copy of the delegated oracle feed is a stale **commit**
snapshot (it only updates when `commit_aggregate` runs, not on every price
tick) — failing over to it during a TEE outage would present frozen prices
as if they were live, which is worse than being honest about the outage.
So there is **no base-RPC fallback** for prices: the TEE reconnect/poll
loop (`indexer/accounts.ts`) is the only oracle source, and staleness is
surfaced explicitly instead:

Week-5 Task 5 changed **what** staleness is measured against: the oracle's
own `publish_time` (the field `programs/dexxer_core/src/oracle.rs` already
gates every on-chain read on), not the moment this process last received an
account notification. The TEE pushes a notification on every ER slot whether
or not the feed's bytes changed, so a publisher that has stopped publishing
looks perfectly live by arrival time. `publish_time` is stored per tick
(migration `005_ticks_publish_time.sql`, epoch ms) and exposed as
`publishTime` so a client can judge for itself.

- `GET /mark`'s `stale` is computed per-request from the latest stored
  tick's `publish_time` (`isStale(publishTime, now, ORACLE_STALE_MS)`,
  `ORACLE_STALE_MS = 30_000`, `src/indexer/prices.ts`).
- The WS `mark` stream carries `stale` on every frame; while the feed is
  live those are the normal throttled (≤1/s) `stale:false` frames, and the
  moment the feed goes quiet for `ORACLE_STALE_MS` a watchdog emits exactly
  **one** `stale:true` frame (not spammed every second for the whole
  outage) using the last known price.
- `/healthz`'s `indexer.oracleStale` is the same predicate against
  `indexer.lastPublishTimeMs` — `true` if the indexer has never decoded an
  update at all.
- `/prices` (candle history) is unaffected — it doesn't claim to be "now".

A Pool snapshot row: `{ slot, ts, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total }`.

### Candles, retention, backfill (spec §2.10, 01.10.2026)

Every oracle tick is one SQL round-trip (`store.ts` `insertTick`): the raw row into `ticks` and an upsert into the three stored candle tiers `candles(market, tf ∈ {1m,1h,1d}, t)` — `o` kept, `h`/`l` stretched, `c` = this price, `source = 'oracle'`. Migration `009_candles.sql` created the table and rolled every tick already stored into it once.

Raw ticks are kept `TICKS_RETENTION_MS` (default 7 days) — `indexer/retention.ts` deletes older ones every `COMMIT_INTERVAL_MS`. They serve only `/mark` and `tf=1s`; candles hold the history.

History before this relayer existed (and gaps while it was down) comes from the **Hyperliquid public info API** (`indexer/backfill.ts`, `POST https://api.hyperliquid.xyz/info`) — keyless and permanent, perp prices for all five markets, `1d` history since 2023. No key, no setup; `BACKFILL_ENABLED=false` turns it off (candles then accrue from ticks only). The coin is the market symbol, verified against `{"type":"meta"}` → `universe[].name` (fetched once per run); a market outside the universe is skipped with a log line, never guessed. Windows: `candleSnapshot` interval `1m` for `BACKFILL_1M_DAYS` (default 4 — Hyperliquid keeps only the last 5000 1m candles, ≈ 3.5 days), `1h` for `BACKFILL_1H_DAYS`, `1d` from `BACKFILL_1D_FROM`. Limits: ≤ 5000 candles per response (chunks: 1m 2 days, 1h 90 days, 1d 400 days), `endTime` is inclusive (a chunk boundary repeats one candle — deduped per run), the in-progress candle is returned too and dropped (the live bucket is the oracle's); the public rate limit is 1200 weight/min per IP and a `candleSnapshot` weighs 20 + 1 per 60 candles returned (`meta` 20), so the run paces itself by that documented weight (55 ms per weight unit after every response, failed ones included — ≈ 1090 weight/min, a margin for a shared egress IP; `BACKFILL_REQUEST_GAP_MS` is only a floor) and waits 60 s after an HTTP 429. A full first run is ≈ 1.5 min at zero latency (≈ 1515 weight × 55 ms); the run summary logs `weight=` (a failed response counts as the base weight 20, its true weight is unknown). Delisted coins (`isDelisted` in `meta`) are skipped. A non-2xx (an unknown coin answers 500 `null`) is an error for that market×tier only. Why not the others (measured 01–02.10.2026): Pyth Pro is trial-key only, Pyth Benchmarks/Hermes answer 404/401, Binance was rejected because `HYPEUSDT` spot was listed only on 24.09.2026. Rows are written with `source = 'hyperliquid'` and `ON CONFLICT DO NOTHING` — an oracle candle always wins; migration `010_candles_source_hyperliquid.sql` keeps the legacy `'pyth_pro'` value allowed so any old rows stay readable. Runs at start (over the registry plus SOL, even when the registry is still empty) and every `BACKFILL_INTERVAL_MS`; a run with any error (meta 5xx, a 429, …) or with no markets is retried after `BACKFILL_RETRY_MS` instead. `/healthz.backfill` = `{ enabled, lastRunAt, lastOkAt, lastError, rows, source: "hyperliquid" }`.

### Markets

- `?market=` on `/mark` and `/prices` is a symbol: absent/empty → `SOL`
  (backward compatible), not `/^[A-Z0-9]{1,8}$/` → **400** `{ error }`, valid
  but not in the registry → **404** `{ error }`. `SOL` is always known (the
  same `withSol` view the crank ticks), also while the registry is empty or
  lacks it.
- `/ws?markets=` is normalised (upper-cased, entries failing the symbol
  regex dropped, an all-junk list falls back to SOL). No parameter = SOL
  `mark` frames only.
- Ticks are stored per market (migration `008_ticks_market.sql`: `market`
  column, existing rows → `'SOL'`, PK `(market, ts)`). Each market has its own
  feed subscription (throttle and stale watchdog), reconciled with the
  registry. Migration 008 makes a deploy overlap / rollback to a pre-008 image
  unsafe. It has not been run against a real Postgres in this branch (see
  Tests).
- `/ws` pings every client every 30 s; one that has not answered the previous
  ping is terminated.
- `/pool/history` keeps keyset pagination: when a page is full the response
  carries `X-Next-Cursor` (next-older slot); pass it back as `?cursor=`. A bad
  parameter is a 400 `{ error }`. There is deliberately **no open interest**:
  OI lives in the private `MarketRisk` and this service reads only public
  accounts.

### Numbers

Postgres `bigint` columns come back from `pg` as JS **strings** (no custom
type parser is installed) — `capital_total`/`protocol_liquidity`/
`locked_total`/etc could exceed `Number.MAX_SAFE_INTEGER`
(2^53) as volume grows, so `store.ts`/`http.ts` never coerce them and they
reach REST/WS clients as JSON **strings**. Candle `o/h/l/c` (SOL/USD price
in 1e6 scale) and every `slot`/`ts`/`limit`/`nonce`-adjacent small integer
stay plain JSON **numbers** — nowhere near 2^53.

## Sponsor (Task 6, fix round 1)

`SPONSOR_ENABLED=true` (needs `DATABASE_URL`) mounts `POST /sponsor` — the
`fee_payer` key co-signs a whitelisted, already owner-signed onboarding
transaction so the app can batch `faucet_init`/`init_user`/`delegateSpl`/
`delegate_user` (the L1 legs) into a `signTransactions([...])` prompt,
with `fee_payer` fronting network fees and PDA/eSPL rent for those L1 legs
(three since 25.09 — `faucet+init_user`, `delegate_spl`, `delegate_user`; see
"Durable nonces" below).

The ER leg (`init_permissions` + `set_session` + the session top-up) is
**not** sponsorable and its whitelist support was removed in week-5 Task 5:
devnet-tee rejects a foreign `fee_payer` as an ER transaction's fee payer
outright (`"InvalidAccountForFee"`), so that branch could only ever have
been reached by an attacker. With it went the only SystemProgram
instruction this endpoint accepted — `fee_payer` now moves lamports for
nobody. See `src/sponsor.ts`'s header comment for the full rationale.

```
POST /sponsor
Authorization: Bearer <relayer session token>          # week 6 — see "Relayer sessions (SIWS)"
{ "tx": "<base64 Transaction, owner already signed, tx.feePayer = fee_payer>" }
-> 200 { "tx": "<base64, now also fee_payer-signed>" }
-> 400 { "error": "<specific reason>" }   # not whitelisted / bad signature / budget exceeded / ...
-> 401 { "error": "relayer session required ..." }  # no/invalid/expired session — checked before anything else
-> 403 { "error": "session owner ... does not match ..." }  # session belongs to someone other than the tx's owner signer
-> 429 { "error": "...", "retryAfterMs": N }  # rate limit — see below
```

### Relayer sessions (SIWS, week 6 — spec §2.7)

`/sponsor` and `/nonce` need a session of the owner, obtained with Sign-In
With Solana (`src/auth.ts`):

```
POST /auth/challenge
-> 200 { nonce, issuedAt, expirationTime, domain, uri, statement, version }   # single-use nonce, 5 min
-> 503 when > 10 000 challenges are open (guard on the one unauthenticated DB write)

POST /auth/siws
{ "address": "<base58>", "signedMessage": "<base64 SIWS text>", "signature": "<base64, 64 bytes>" }
-> 200 { token, owner, expiresAt }       # session TTL AUTH_SESSION_TTL_HOURS (default 168)
-> 400 not a SIWS message / malformed body
-> 401 domain or uri host != SIWS_DOMAIN, address mismatch, issuedAt off by > 5 min,
       expired / not-yet-valid message, bad or non-64-byte signature,
       unknown / used / expired nonce (consumed only AFTER the signature verifies)
```

Only `sha256(token)` is stored (`auth_sessions`, migration `006`); tokens are
never logged. `chainId` is not checked. The session opens only this API — it
is not a TEE token. This proves control of a key, **not** uniqueness of a
person: fresh keys are free, so Sybil drain of the sponsor budget (#27) stays
open. Without `SIWS_DOMAIN` the relayer mounts none of `/auth/*`, `/sponsor`,
`/nonce` (fail-closed).

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
| dexxer_core | `init_user` | 0 | 1 | `fee_payer` fronts `UserAccount`/`Positions` rent (`UserAccount.rent_payer` = `fee_payer`) |
| dexxer_core | `delegate_user` | 0 | 1 | week-5 Task 3: the delegation records got their own `payer` |
| dexxer_core | `faucet_mint` | 0 | — | 24.09 (M-K): the Deposit faucet leg; no payer account, `fee_payer` covers only the network fee of a 0-SOL owner |
| eSPL | `initEphemeralAtaIx` (prefix `0`) | 2 | 1 | `fee_payer` fronts the owner's eATA rent |
| eSPL | `transferToVaultIx` (prefix `2`) | 5 | — | pure token transfer (owner's dUSDC -> vault), no payer account |
| eSPL | `delegateEphemeralAtaIx` (prefix `4`) | — | 0 | no owner account; `fee_payer` fronts delegation-record rent |
| ATA program | `CreateIdempotent` (data `[1]`) | 2 | 0 | week-5 Task 5: FEE_PAYER-funded (was owner-funded); `owner`@2 must be the signing owner, which is what stops it funding a stranger's ATA |
| System | `AdvanceNonceAccount` | 2 | — | 24.09 (durable nonces): nonce@0 must be one of the owner's two relayer-derived nonce accounts (`nonceAccountsFor(fee_payer, owner)`), authority@2 = owner; companion-only (never sponsorable alone), at most once per tx |
| ComputeBudget | `SetComputeUnitLimit` (data[0]=2) | — | — | fix (Phantom smoke 24.09): accepted for any value — no accounts, cannot cost `fee_payer` more than the tx's own CU budget |
| ComputeBudget | `SetComputeUnitPrice` (data[0]=3) | — | — | accepted only up to `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS` (default `500000`); any other ComputeBudget variant (`RequestHeapFrame`, `SetLoadedAccountsDataSizeLimit`, ...) is rejected |
| SystemProgram | anything | — | — | rejected outright — `fee_payer` never moves lamports through this endpoint |

Any other `programId`/discriminator/opcode is rejected outright; the
non-idempotent ATA `Create` and any other SystemProgram instruction are
never whitelisted. A transaction made ENTIRELY of ComputeBudget
instructions is rejected too — at least one dexxer_core/eSPL/ATA
instruction is required.

Fix (live Phantom smoke, 24.09): the endpoint's 400 for the L1a onboarding
batch was Phantom prepending `SetComputeUnitLimit`/`SetComputeUnitPrice` to
the legacy transaction it signed — standard wallet behaviour the fakewallet
test harness never exercised, since it doesn't prepend ComputeBudget
instructions. ComputeBudget carries no accounts, so there's nothing to
smuggle a foreign pubkey into; only `SetComputeUnitPrice`'s microLamports
figure can cost `fee_payer` more (a per-CU priority-fee multiplier), which
is why it alone is capped. `/healthz`'s `sponsor` field now also reports
`maxCuPriceMicroLamports`.

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
`/healthz`'s `sponsor` field (`{ today_sol, count_today, maxCuPriceMicroLamports }`)
reports the rolling 24h spend (finalized rows only) plus the currently
enforced ComputeBudget `SetComputeUnitPrice` ceiling.

## Env vars

| Var | Required | Notes |
| --- | --- | --- |
| `DEXXER_NET` | no (default `local`) | `devnet` switches `tests/er/lib/env.ts`'s RPC/TEE profile |
| `CRANK_KEY_B58` | prod | bs58 secret key; local dev falls back to `tests/er/.keys/devnet-crank.json` / `admin.json` |
| `FEE_PAYER_KEY_B58` | prod | same, falls back to `devnet-fee-payer.json` / `admin.json` |
| `PORT` | no (default `8080`) | HTTP port |
| `DATABASE_URL` | prod | Postgres connection string (Railway reference variable to the Postgres plugin); unset = no persistence, `/healthz`'s `db` reports `"error"` |
| `CRANK_INTERVAL_MS` | no (default `1000`) | tick cadence |
| `COMMIT_INTERVAL_MS` | no (default `300000`, min `10000`) | wall-clock gap between one root + `commit_aggregate()` + janitor cycle and the next (`src/commit.ts`); unparseable / below the minimum → default. Reported by `/healthz` as `commitIntervalMs`. Replaces `COMMIT_INTERVAL_TICKS` |
| `MARKETS_REFRESH_MS` | no (default `60000`, min `5000`) | market-registry refresh period (`src/markets.ts`); unparseable / below the minimum → default |
| `JANITOR_RETRY_COOLDOWN_MS` | no (default `3600000`, min `60000`) | per-owner cooldown after a `close_exited_user` the program rejected on chain (`src/janitor.ts`); unparseable / below the minimum → default |
| `JANITOR_MIN_FEE_PAYER_SOL` | no (default `0.002`, min `0`) | the janitor pass is skipped (and an error recorded) while `fee_payer`'s base balance is below this; `0` disables the floor |
| `CRANK_BAD_PAIR_COOLDOWN_MS` | no (default `60000`, min `5000`) | how long a `[Positions, UserAccount]` pair rejected alone on chain stays out of the batches (`src/candidates.ts`) |
| `CRANK_WATCHDOG_MS` | no (default `120000`, min `30000`) | no loop iteration completed within this → the process exits with code 1 (`src/crank.ts`) so Railway restarts it. Not scaled to the loop size (many markets × chunks could legitimately take longer — a plan-4 check). A commit cycle in flight for longer than max(3 × `COMMIT_INTERVAL_MS`, 600 000) exits the same way. The repo's `railway.json` sets `restartPolicyType: ALWAYS` (plan 4: a condition that repeats after every restart keeps restarting rather than stopping the service — watch the restart count), and the live service applies it since deployment `5a070a7c` (01.10.2026), set directly in the service settings because Railway deprecated config-as-code and never reads `railway.json` (see the liveness caveat above; before that: `ON_FAILURE` × 10 / 30 s) |
| `INDEXER_ENABLED` | no (default `false`) | Task 5: starts the public-data indexer (see above) — needs `DATABASE_URL`, disabled with a warning if it's unset |
| `SPONSOR_ENABLED` | no (default `false`) | Task 6: starts `POST /sponsor` (see below) — needs `DATABASE_URL`, disabled with a warning if it's unset |
| `SPONSOR_DAILY_SOL` | no (default `0.5`) | rolling 24h cap on sponsored lamports across all owners |
| `SIWS_DOMAIN` | yes when `SPONSOR_ENABLED=true` | week 6: the app's MWA identity domain (today the relayer's own host). SIWS messages must name it as `domain` and as the `uri` host. Unset → `/auth/*`, `/sponsor`, `/nonce` are **not mounted** (fail-closed, logged) |
| `AUTH_SESSION_TTL_HOURS` | no (default `168`) | week 6: relayer session lifetime; non-positive/unparseable → default |
| `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS` | no (default `500000`) | fix (Phantom smoke 24.09): ceiling on a wallet-prepended ComputeBudget `SetComputeUnitPrice` this endpoint will co-sign. At the 1.4M CU transaction max the default caps the sponsor-paid priority fee at 700 000 lamports ≈ 0.0007 SOL/tx. `SetComputeUnitLimit` has no such cap — it cannot cost `fee_payer` more than the tx's own CU budget. Reported by `/healthz`'s `sponsor.maxCuPriceMicroLamports` |
| `ASSETLINKS_PACKAGE` | no (default `com.dexxer.app`) | Android package name published in `GET /.well-known/assetlinks.json` (MWA identity verification, 24.09) |
| `ASSETLINKS_SHA256_FINGERPRINTS` | no (default: Android debug keystore cert of the dev-client) | comma-separated SHA-256 signing-cert fingerprints for that statement; a release build MUST set its own (`keytool -list -v -keystore <ks> -alias <alias>` → `SHA256:`). Boot fails on a malformed value |
| `TICKS_RETENTION_MS` | no (default `604800000` = 7 d, min `3600000`) | raw `ticks` older than this are deleted every `COMMIT_INTERVAL_MS` (candles keep the history) |
| `BACKFILL_ENABLED` | no (default `true`) | `false` turns the Hyperliquid candle backfill (`indexer/backfill.ts`) off; no key is needed |
| `BACKFILL_INTERVAL_MS` | no (default `86400000`, min `600000`) | how often the backfill re-runs |
| `BACKFILL_RETRY_MS` | no (default `600000`, min `60000`) | delay before the next backfill run after one with errors or no markets |
| `BACKFILL_1M_DAYS` / `BACKFILL_1H_DAYS` | no (default `4` / `90`) | how far back the `1m` / `1h` tiers are backfilled (Hyperliquid serves only the most recent 5000 candles per interval: `1m` ≈ 3.5 days, `1h` ≈ 208 days, `1d` ≈ 13.7 years) |
| `BACKFILL_1D_FROM` | no (default `2023-01-01`) | ISO date the `1d` tier is backfilled from (Hyperliquid's 1d history starts in 2023; a later-listed coin returns from its launch) |
| `BACKFILL_REQUEST_GAP_MS` | no (default `500`) | minimum pause between Hyperliquid requests (a floor): the real pause is weight-based — 55 ms per documented weight unit (`candleSnapshot` = 20 + 1 per 60 candles, limit 1200/min); pacing cannot be turned off |

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
curl localhost:8080/markets
```

Without `DATABASE_URL` set, `db.ts` logs a warning and runs without
Postgres — the crank loop is unaffected; only the `lastCommitAt`
persistence across restarts and `/healthz`'s `db` field are skipped.
(`lastTickAt` is neither persisted nor restored any more: `/healthz.ok`
reflects the running process.)

## Tests

```sh
npm test        # node:test — keypairFromEnv b58 round-trip, health-payload staleness logic,
                 # candles.ts bucketing (pure), prices.ts::decodeFeed (golden vectors vs oracle.rs),
                 # prices.ts::isStale (publish_time staleness predicate), sponsor.ts::checkWhitelist
                 # (every accept/reject shape) + the /sponsor router, janitor.ts (decision table
                 # with injected readers — no network, `exited` byte offset pinned against the IDL coder),
                 # candidates.ts (pair building, junk filtering, tx-size limit, probe/singles/quarantine),
                 # commit.ts (cycle runner, root cycle throwing), crank per-market logic (crankMarkets.test.ts:
                 # runMarkets short-circuit, tickSet, watchdog, fresh blockhash, tick line), errors.ts
                 # (classifier with real error strings), logTag.ts, markets.ts registry, positionsCodec,
                 # ixAccounts (trader AND relayer builders vs the IDL), poolBootstrap (tests/er bootstrap
                 # order), auth.ts (SIWS verification, challenge/siws/requireSession), the /sponsor + /nonce
                 # session gate, indexer/query.ts and knownSymbols (pure parsing)
                 # **285 tests** = 271 passed + 14 Postgres skipped (run with `TEST_DATABASE_URL` they cover migrations 009/010 and the candles too)
                 # Needs DEXXER_IDL_DIR=$PWD/../../idl (the canonical IDL, as CI sets it).
npx tsc --noEmit
```

Run on the Node version in the repo's `.nvmrc` (24.18, as CI does): on 24.10
`test/sponsor.test.ts` fails to load on `import { BN } from "@coral-xyz/anchor"`
(CJS named-export detection) — environment, not code.

`test/indexerDb.test.ts` runs the indexer's SQL (pool-history pagination, per-market
ticks, and candle migrations 009/010) against a **real Postgres** and is skipped unless `TEST_DATABASE_URL`
is set — CI has no Postgres, so there those 14 tests show as skipped. Locally:

```sh
docker run -d --rm --name idx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres DEXXER_IDL_DIR=$PWD/../../idl npm test
docker stop idx-pg
```

It creates and drops its own scratch database, so it never touches the
database named in the URL.

## Durable nonces — `POST /nonce`

Alpenglow скоротив слоти devnet до ~150–250 мс (24.08; мейнет з 28.09), тож
150-слотове вікно blockhash тепер ~25 с. Промпт Phantom триває ~38 с (його
fee-оцінка ретраїть 429 від `api.devnet.solana.com` до того, як юзер може
підтвердити), тому жодна owner-підписана L1-tx на звичайному blockhash не
долітала. Розв'язок — durable nonce: `recentBlockhash` = значення з
nonce-акаунта, tx валідна до наступного advance.

Створити nonce-акаунт власник теж не може (той самий повільний гаманець),
тому створює **relayer**: `POST /nonce {owner}` → ідемпотентно створює три
System-акаунти (по одному на L1-лег онбордингу: `faucet+init_user`,
`delegate_spl`, `delegate_user` — з 25.09, бо спонсорований `delegateSpl +
delegate_user` в одній tx з advance і ComputeBudget важив 1322 > 1232 байт) `createWithSeed(fee_payer, "dn<slot>-" + base58(owner)[0:28])`
з **authority = owner** (лише власник може ними користуватись), фронтує rent
(~0.00145 SOL кожен; рахується в rate-limit і денний бюджет `/sponsor`), і
повертає `{ nonces: [{account, nonce}] }` з поточними значеннями. Повторний
виклик — безкоштовний і без резервації.

**Тиждень 6:** лише з `Authorization: Bearer` SIWS-сесії (розділ «Relayer
sessions» вище); власник — із сесії, `body.owner` необов'язковий і, якщо
переданий, мусить збігатися (інакше 403). Без сесії — 401, нічого не
резервується й не надсилається: анонімний POST випадкових pubkey більше не
витрачає SOL.

Апка (`app/src/lib/nonce.ts`) перед кожною owner-L1-tx бере свіжі значення,
будує tx з `AdvanceNonceAccount` першою інструкцією та **власними**
ComputeBudget-інструкціями одразу після — інакше Phantom дописує свої
ПЕРЕД advance і ламає nonce-семантику (phantom/docs#91, виміряно 24.09:
без наших CB tx губилась, з ними Phantom повертає `[advance, CB, CB, ix]`).
Два акаунти — бо онбординг підписує дві L1-tx одним промптом.

## Digital Asset Links — `GET /.well-known/assetlinks.json`

MWA-гаманці (Phantom, Seeker Vault, fakewallet) перевіряють identity dApp-а за
Digital Asset Links: беруть host з `identity.uri`, тягнуть
`https://<host>/.well-known/assetlinks.json` і звіряють **пакет, що реально
викликав** (з Android binder, не з запиту) та його підписний сертифікат з
`android_app`-таргетом із relation `delegate_permission/common.handle_all_urls`
(`solana-mobile/digital-asset-links-android`, `AndroidAppPackageVerifier`;
лише `https`). Без цього Phantom відхиляє `reauthorize` (`-1`) і кожна сесія
коштує зайвий промпт (виміряно 24.09, live Phantom smoke).

Relayer уже має публічний HTTPS-домен, який знає апка (`RELAYER_URL`), тому
статмент віддає він (`src/assetlinks.ts`); апка ставить `identity.uri` на цей
origin (`EXPO_PUBLIC_IDENTITY_URI`, дефолт — origin `RELAYER_URL`). Ендпоінт
статичний, без ключів і без читання чейну. Перевірка формату Google-ом:

```bash
curl -s https://<host>/.well-known/assetlinks.json
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<host>&relation=delegate_permission/common.handle_all_urls"
```

## Docker / Railway

Build context is the **repo root**, not `services/relayer/` — see
`Dockerfile`'s header comment for why (it needs `tests/er/lib/*.ts` and the
committed canonical IDL `idl/dexxer_core.json`, `DEXXER_IDL_DIR=/app/idl`; the app's own IDL copy is not used). Railway service config: root
directory `/`, `RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile`.

Deployed project/service ids, domain, and PDA/program references live in
`docs/deployments.md` (repo root).
