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
  cycle. Since week-5 Task 1 `commit_aggregate` sources both the
  `write_commitment` and the `write_disclosure` actions from the owner's
  `DisclosureQueue`, so the queue is the only candidate kind and the old
  `mark_committed` follow-up is gone.
- `src/orphan.ts` (week-5 Task 5) — the exit-with-debt janitor, run once per
  `COMMIT_INTERVAL_TICKS` right after the disclosure cycle. Pass 1 (ER,
  crank): every `DisclosureQueue` with `len == 0` whose owner has left
  (`UserAccount.exited`, or the account is gone) -> `close_orphan_queue`.
  Pass 2 (base, `fee_payer`): every owner whose three PDAs are back under
  `dexxer_core` and still flagged `exited` -> `close_exited_user`, returning
  their rent to `fee_payer`. Both passes are idempotent and re-derive their
  candidates from chain state every cycle, so a restart strands nothing.
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
| `GET /mark` | — | `{ price, slot, ts, publishTime, stale }` — `price` is a **string** (see Numbers below), or all-`null`/`stale:true` if no tick has landed yet. `publishTime` is the ORACLE's own `publish_time` in epoch ms; `stale = now - publishTime > ORACLE_STALE_MS` (30s) — see "Oracle staleness" below |
| `GET /pool/history` | `limit` (default 100, max 1000) | array of Pool snapshot rows, oldest→newest |
| `GET /pool/latest` | — | one Pool snapshot row, or `null` |
| `GET /disclosures` | `limit` (default 100, max 1000) | array of closed-trade disclosure rows, newest `closed_slot` first |
| `GET /root/latest` | — | `{ root_slot, filled, leavesHex }`, or `null` |
| `GET /healthz` | — | (Task 4) health payload, now also carrying `commitIntervalTicks` and `indexer: { ticks, lastTickTs, lastPublishTimeMs, lastPoolSlot, disclosures, wsClients, oracleStale }` |
| `GET /ws` (WebSocket, not REST) | — | pushes `{type:"mark",price,ts,publishTime,stale}` (throttled to ≤1/s while live; exactly one extra `stale:true` frame when the feed transitions to stale — see below), `{type:"pool",...}` on a new Pool snapshot, `{type:"disclosure",...}` on a newly discovered Disclosure |

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

The ER leg (`init_permissions` + `set_session` + the session top-up) is
**not** sponsorable and its whitelist support was removed in week-5 Task 5:
devnet-tee rejects a foreign `fee_payer` as an ER transaction's fee payer
outright (`"InvalidAccountForFee"`), so that branch could only ever have
been reached by an attacker. With it went the only SystemProgram
instruction this endpoint accepted — `fee_payer` now moves lamports for
nobody. See `src/sponsor.ts`'s header comment for the full rationale.

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
| dexxer_core | `init_user_reuse_queue` | 0 | 1 | week-5 Task 2: the returning owner, whose queue outlived their exit |
| dexxer_core | `delegate_user` | 0 | 1 | week-5 Task 3: the three delegation records got their own `payer` |
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
| `COMMIT_INTERVAL_TICKS` | no (default `300`) | ticks between one `commit_aggregate` + `BalancesRoot` + orphan-reclaim cycle and the next (300 ≈ 5 min at the default cadence). Reported by `/healthz` as `commitIntervalTicks`; a value below 1 falls back to the default |
| `COMMIT_MAX_ACTIONS` | no (default `4`) | per-bundle action budget **passed to the program** as `commit_aggregate(max_actions)` (also bounds queue selection). Clamped to `[1, 8]` — 8 is the program's hard ceiling (`MAX_ACTIONS_PER_COMMIT`, `state/mod.rs`), and week-5 Task 7 measured the MagicBlock bridge rejecting a real 8-action bundle (`0xA0000002`) on devnet-tee while 4 passes, so the default sits below that ceiling. Before the week-5 final-review fix (program upgrade #3) this var only chose WHICH queues went in: the program emitted up to 8 actions per queue regardless, which is why a single full ring could never be committed. On a bridge-cap failure the cycle now halves BOTH the argument and the selection budget once and retries, before falling back to a bare 0-action commit (see disclosure.ts). Reported by `/healthz` as `commitMaxActions` |
| `QUARANTINE_CYCLES` | no (default `10`) | disclosure-cycles a queue stays excluded from selection after its SECOND consecutive bridge-cap failure (week-5 Task 7 fix round 1, `src/disclosure.ts`'s `QuarantineState`) — ~10 min at the default 60-tick/60s cadence. A queue's FIRST failure already rotates it out for exactly the next cycle regardless of this var, so the rest of the backlog is never starved by a single poisoned queue (oldest-debt-first alone was a live outage of automatic draining — see disclosure.ts's header comment). A non-positive or unparseable value falls back to the default |
| `INDEXER_ENABLED` | no (default `false`) | Task 5: starts the public-data indexer (see above) — needs `DATABASE_URL`, disabled with a warning if it's unset |
| `SPONSOR_ENABLED` | no (default `false`) | Task 6: starts `POST /sponsor` (see below) — needs `DATABASE_URL`, disabled with a warning if it's unset |
| `SPONSOR_DAILY_SOL` | no (default `0.5`) | rolling 24h cap on sponsored lamports across all owners |
| `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS` | no (default `500000`) | fix (Phantom smoke 24.09): ceiling on a wallet-prepended ComputeBudget `SetComputeUnitPrice` this endpoint will co-sign. At the 1.4M CU transaction max the default caps the sponsor-paid priority fee at 700 000 lamports ≈ 0.0007 SOL/tx. `SetComputeUnitLimit` has no such cap — it cannot cost `fee_payer` more than the tx's own CU budget. Reported by `/healthz`'s `sponsor.maxCuPriceMicroLamports` |
| `ASSETLINKS_PACKAGE` | no (default `com.dexxer.app`) | Android package name published in `GET /.well-known/assetlinks.json` (MWA identity verification, 24.09) |
| `ASSETLINKS_SHA256_FINGERPRINTS` | no (default: Android debug keystore cert of the dev-client) | comma-separated SHA-256 signing-cert fingerprints for that statement; a release build MUST set its own (`keytool -list -v -keystore <ks> -alias <alias>` → `SHA256:`). Boot fails on a malformed value |

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
                 # prices.ts::isStale (publish_time staleness predicate), sponsor.ts::checkWhitelist
                 # (every accept/reject shape) + the /sponsor router, orphan.ts::runOrphanCycle
                 # (the whole decision table, with injected readers — no network)
                 # Needs DEXXER_IDL_DIR=$PWD/../../app/src/idl (as CI sets it).
npx tsc --noEmit
```

## Durable nonces — `POST /nonce`

Alpenglow скоротив слоти devnet до ~150–250 мс (24.08; мейнет з 28.09), тож
150-слотове вікно blockhash тепер ~25 с. Промпт Phantom триває ~38 с (його
fee-оцінка ретраїть 429 від `api.devnet.solana.com` до того, як юзер може
підтвердити), тому жодна owner-підписана L1-tx на звичайному blockhash не
долітала. Розв'язок — durable nonce: `recentBlockhash` = значення з
nonce-акаунта, tx валідна до наступного advance.

Створити nonce-акаунт власник теж не може (той самий повільний гаманець),
тому створює **relayer**: `POST /nonce {owner}` → ідемпотентно створює два
System-акаунти `createWithSeed(fee_payer, "dn<slot>-" + base58(owner)[0:28])`
з **authority = owner** (лише власник може ними користуватись), фронтує rent
(~0.00145 SOL кожен; рахується в rate-limit і денний бюджет `/sponsor`), і
повертає `{ nonces: [{account, nonce}] }` з поточними значеннями. Повторний
виклик — безкоштовний і без резервації.

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
committed `app/src/idl/dexxer_core.json`). Railway service config: root
directory `/`, `RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile`.

Deployed project/service ids, domain, and PDA/program references live in
`docs/deployments.md` (repo root).
