# Позиції-слоти, план 4 з 4: чистий деплой на devnet, relayer, APK, виміри

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** нова програма `dexxer_core` (плани 1–3) живе на devnet-tee з п'ятьма ринками й запланованими кранками, relayer на Railway обслуговує її, APK зібрано на неї, і кожне «не виміряно» зі spec §2.9 має число або записаний FAIL у `docs/superpowers/plans/week6-results.md`.

**Architecture:** спершу два гейти без витрат (перевірка `posted_slot` реального фіду; свіжий `bootstrap()` на mb-stack), потім нова ідентичність програми (keypair → `declare_id!` → IDL → деплой), бутстрап devnet (`bootstrapDevnet` → `fund-fee-payer` → `add-market --schedule` ×4 → `schedule-eternal` SOL), relayer (env, БД, `railway up`), сценарні скрипти `tests/er/devnet` як виміри, APK і smoke з живим гаманцем, результати. Кожен крок, що витрачає SOL, незворотний або чіпає секрети, — гейт користувача; агент готує команди й перевіряє результат.

**Tech Stack:** Solana CLI (`solana program deploy`), `cargo build-sbf`, `tools/idlgen`, `tsx` сценарії `tests/er` (`DEXXER_NET=devnet`), Railway CLI / Railway MCP, Docker `postgres:16-alpine` (опційно), Expo dev client (`npm run android`), Android AVD за `docs/emulator-runbook.md`.

**Spec:** `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` §2.9.5 і «Відкрите для плану 4» у трьох блоках «Реалізовано» (програма, relayer і TS, app); `docs/deployments.md` розділ «Розкатка плану 4» (кроки 0–9); `docs/emulator-runbook.md` §6. Інвентар фактів для цього плану — `/private/tmp/claude-501/-Users-vitalikcholan-Projects-mobile-perp-dex/175c6ee6-29b0-4c92-88b1-5aea05f5490f/scratchpad/plan4-inventory.md` (тимчасовий; усе потрібне продубльовано нижче).

## Global Constraints

- Гілка `positions-slots` (голова плану 3 — `bfe5d59`, PR #11 відкрито). Коміт після кожної задачі, `git add <paths>` поштучно, повідомлення англійською з трейлером сесії. Пуш — лише за проханням користувача.
- **Користувач робить сам:** перекази SOL на devnet (payer, admin, fee_payer, трейдери), секрети Railway (`CRANK_KEY_B58`, `FEE_PAYER_KEY_B58`, `DATABASE_URL`, `SIWS_DOMAIN`), smoke з живим гаманцем, закриття старої програми. Агент готує точну команду/значення й чекає підтвердження. Несекретні env (`COMMIT_INTERVAL_MS`, видалення мертвих змінних) агент може виставити через Railway MCP `set_variables` після показу списку.
- **Незворотні дії лише з явним «так» користувача на кожну:** `solana program deploy` (≈4.6 SOL ренти), `TRUNCATE` у живій БД, `solana program close` старої програми (у цьому плані **не виконується**, лише фіксується як рішення на потім).
- **Нічого під `keys/` не комітити, крім `keys/README.md`.** Ключі `tests/er/.keys/*.json`, `spikes/keys/*.json`, `keys/programs/*.json` — лише читати шляхами; вміст не друкувати в логах і звітах. Нові ключі (`devnet-mint`, трейдери) створює `loadOrCreateKey` автоматично, якщо файлу нема.
- Програма збирається `cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml`; `anchor build` локально не запускати. IDL — лише `tools/idlgen` (`env -u RUSTUP_TOOLCHAIN`, абсолютні шляхи, свіжий `CARGO_TARGET_DIR`). Будь-яка зміна `.rs` → Solana MCP `program_autofixer` до коміту.
- Усі devnet-скрипти — з `tests/er` з `DEXXER_NET=devnet` (`cd tests/er && DEXXER_NET=devnet npx tsx <path>` або `npm run devnet:*`). Node з `.nvmrc`: `. "$HOME/.nvm/nvm.sh" && nvm use`.
- Ендпоінти devnet: base `https://rpc.magicblock.app/devnet`, TEE `https://devnet-tee.magicblock.app`, router `https://devnet-router.magicblock.app/`, валідатор `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, оракул `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`, фіди Lazer: SOL `6`, BTC `1`, ETH `2`, HYPE `110`, ZEC `66`.
- Railway: проєкт `dexxer` `2aac2416-043e-4845-8c19-8e1e2e862f4d`, env `production` `0a5d310b-fac2-40f9-88d1-630df862695a`, сервіс `relayer` `c2581443-1fa1-46ce-bb08-8e95b1fd682f`, Postgres `8d0f27fb-6df7-4eeb-8086-790f4d4ef3c5`, домен `https://relayer-production-1ae7.up.railway.app`.
- **Факти, не припущення:** у `week6-results.md` і документах — лише числа з прогонів (сигнатури tx, слоти, CU з `meta.computeUnitsConsumed`, байти з `tx.serialize().length`, баланси до/після). Невдалий чи пропущений крок записується як FAIL / НЕ ВИКОНАНО з причиною, а не «мабуть працює».
- Записи вимірів — у форматі попередніх тижнів: `## Task N`, `### M-X: <скрипт> — PASS|FAIL|НЕ ДОЛЕТІВ`, таблиці «Що | Значення», повні сигнатури, баланси до/після, «Відкрите після Task N».

## Review Focus

1. **Перший гейт провалився.** Якщо `posted_slot` реального фіду не змінюється на кожному принті, `sample_seq` не росте і ніхто не ліквідується — план ЗУПИНЯЄТЬСЯ до деплою, результат іде в spec як блокер (#38 вимагає зміни механізму) — Task 1.
2. **Старі задачі планувальника живі.** Вічний кранк SOL старої програми й задачі `liquidation_check` старих позицій далі тікають у TEE й палять старий `FeeEscrow`. `cancel-crank.ts` знає лише SOL-задачу і рахує `task_id` від **поточного** `DEXXER_CORE_PROGRAM_ID` — скасувати треба ДО зміни ID у IDL — Task 2.
3. **Частковий бутстрап.** `bootstrapDevnet`/`add-market` ідемпотентні по кроках, але ключ `devnet-mint` має бути свіжим до першого `init_config`, інакше `init` мінта впаде на наявному акаунті; повторний запуск після збою має пройти без ручного прибирання — Task 3.
4. **Мертві env і стара БД.** `COMMIT_INTERVAL_TICKS`/`COMMIT_MAX_ACTIONS`/`QUARANTINE_CYCLES` relayer не читає — лишаться як сміття; `pool_snapshots`/`roots`/`relayer_meta` старої програми віддають старий пул до першого нового коміту; `/healthz` дає 503 до першого тіку SOL (healthcheck 180 с) — Task 4.
5. **Ліквідація одного ринку не чіпає інших.** Форсування ліквідації на BTC (`set_params` BTC) має залишити SOL-позицію того ж трейдера живою, а дві задачі `liquidation_check` одного `Positions` (спільний `task_context`) — існувати одночасно — Task 5.
6. **Smoke без підміни.** Чек-лист runbook §6 виконує користувач із реальним гаманцем; агент не імітує його й не записує «PASS» без рядків logcat і сигнатур — Task 6.

---

### Task 1: перший гейт — `posted_slot` реального фіду і підготовка mb-stack

**Files:**
- Create: `tests/er/devnet/14-feed-prints.ts`
- Modify: `tests/er/package.json` (скрипт `devnet:feedprints`)
- Test: прогін скрипта на devnet (публічні дані, ключі не потрібні)

**Interfaces:**
- Consumes: `services/relayer/src/indexer/prices.ts` — декодер фіду (`price`, `confBps`, `publishTime`, `postedSlot`, зміщення `+8 posted_slot u64 LE`); `tests/er/lib/env.ts` (`ORACLE`, `erConn`, `sleep`); адреса фіду — `pdas.feedUnder(ORACLE, lazerFeedId)` з `tests/er/lib/program.ts:147` (та сама деривація, що в `bootstrapDevnet` і `add-market`).
- Produces: `npm run devnet:feedprints -- [SYM…]` — для кожного символу з `MARKET_CATALOG` (дефолт усі п'ять) 90 с поллить акаунт фіду з TEE кожні 250 мс, збирає послідовність унікальних `(publishTime, postedSlot, price)` і друкує таблицю `symbol | prints | distinct_posted_slot | repeats_posted_slot | min_gap_ms | max_gap_ms | stale>2s`; `FEED-PRINTS PASS`, якщо для КОЖНОГО ринку `repeats_posted_slot == 0` (кожен новий `publishTime` має новий `posted_slot`) і `prints ≥ 10`; інакше `FAIL` з переліком ринків.

- [ ] **Step 1: скрипт.** `tests/er/devnet/14-feed-prints.ts`:

```ts
// tests/er/devnet/14-feed-prints.ts — plan-4 gate #1 (spec §2.9 «Відкрите для плану 4»):
// does the real Pyth Lazer feed change `posted_slot` on EVERY print? `crank_tick`
// moves Market.last_print/sample_seq only when posted_slot != last_print, and
// liquidation_check counts ticks by sample_seq — a feed that repeats posted_slot
// across prints would never liquidate anyone. Public data, no keys.
// Run: cd tests/er && npm run devnet:feedprints -- SOL BTC
export {};
const envMod = await import("../lib/env.js");
const { ORACLE, erConn, sleep, NET } = envMod;
if (NET !== "devnet") throw new Error("DEXXER_NET=devnet required");
const { MARKET_CATALOG } = await import("../lib/markets.js");
const { pdas } = await import("../lib/program.js"); // pdas.feedUnder(ORACLE, lazerFeedId) — the same derivation bootstrapDevnet/add-market use
const { decodeFeed } = await import("../../../services/relayer/src/indexer/prices.js"); // if the relayer module cannot be imported here, copy the 4 reads (price i64 @+? … posted_slot u64 @+8) with offsets quoted from prices.ts:28 and say so in the report
const symbols = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MARKET_CATALOG);
const DURATION_MS = 90_000, POLL_MS = 250;
type Print = { t: number; publishTime: bigint; postedSlot: bigint; price: bigint };
const results: Record<string, Print[]> = {};
const start = Date.now();
while (Date.now() - start < DURATION_MS) {
  for (const s of symbols) {
    const feed = pdas.feedUnder(ORACLE, MARKET_CATALOG[s].lazerFeedId);
    const info = await erConn.getAccountInfo(feed);
    if (!info) continue;
    const d = decodeFeed(info.data);
    const arr = (results[s] ??= []);
    const last = arr.at(-1);
    if (!last || last.publishTime !== d.publishTime || last.postedSlot !== d.postedSlot) arr.push({ t: Date.now(), ...d });
  }
  await sleep(POLL_MS);
}
let pass = true;
console.log("symbol | prints | distinct_posted_slot | repeats_posted_slot | min_gap_ms | max_gap_ms | stale>2s");
for (const s of symbols) {
  const arr = results[s] ?? [];
  const slots = new Set(arr.map((p) => p.postedSlot.toString()));
  const repeats = arr.length - slots.size;
  const gaps = arr.slice(1).map((p, i) => p.t - arr[i].t);
  const stale = gaps.filter((g) => g > 2000).length;
  if (repeats > 0 || arr.length < 10) pass = false;
  console.log(`${s} | ${arr.length} | ${slots.size} | ${repeats} | ${Math.min(...gaps)} | ${Math.max(...gaps)} | ${stale}`);
}
console.log(pass ? "FEED-PRINTS PASS" : "FEED-PRINTS FAIL");
process.exit(pass ? 0 : 1);
```

  Додати в `tests/er/package.json`: `"devnet:feedprints": "DEXXER_NET=devnet tsx devnet/14-feed-prints.ts"`.

- [ ] **Step 2: прогін** — `cd tests/er && npm run devnet:feedprints` (усі п'ять). Записати таблицю повністю. Якщо `FAIL` для будь-якого ринку: **зупинити план**, записати результат у spec §2.9 «Відкрите для плану 4» як блокер і повідомити користувача — далі не йти.

- [ ] **Step 3: mb-stack — свіжий `bootstrap()`** (C1 фінального ревʼю плану 2 виправлено лише читанням). Перевірити, чи є локальний mb-stack: `tests/er/README.md` (розділ про mb-stack/`npm run q1`). Якщо стек піднімається: `cd tests/er && npm run q1` (викликає `bootstrap()` на локальному стеку з порядком `init_pool → init_pool_live → seed_pool → delegate_pool_live → delegate_pool`). Очікувано: `q1` проходить, у логах немає Anchor 3007. Якщо mb-stack недоступний — записати «не виконано, причина», і Task 3 стає першим реальним прогоном порядку пулу (ризик: збій після `init_config` коштує лише ренти кроків, усі кроки ідемпотентні).

- [ ] **Step 4: commit**

```bash
git add tests/er/devnet/14-feed-prints.ts tests/er/package.json
git commit -m "test(er): devnet feed-prints gate — posted_slot per print"
```

---

### Task 2: нова ідентичність програми, збірка, IDL, деплой

**Files:**
- Modify: `programs/dexxer_core/src/lib.rs:18` (`declare_id!`), `Anchor.toml:11,17`, `idl/dexxer_core.json` (регенерувати), `keys/README.md:4,24`, `README.md:143`, `docs/deployments.md` (таблиця програми/PDA, банер «живе — стара програма»)
- Keys (не комітити): `keys/programs/dexxer_core-keypair.json` → перейменувати на `dexxer_core-keypair.G2ok.json` (старий), створити новий; `target/deploy/dexxer_core-keypair.json`

**Interfaces:**
- Consumes: стара програма `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`; `scripts/admin/cancel-crank.ts` (task_id = sha256(**поточний** program id)); payer/upgrade authority `spikes/keys/payer.json` (`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`).
- Produces: `NEW_PROGRAM_ID` у `idl/dexxer_core.json` `.address` (звідти його читають app, relayer, `tests/er`); задеплоєна програма з `sha256(.so)` == локальний; `target/deploy/dexxer_core.so` 1 107 440 B (±, записати).

- [ ] **Step 1: скасувати вічний кранк СТАРОЇ програми** (поки IDL ще з `G2ok…`): `cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/cancel-crank.ts`. Записати сигнатуру. Задачі `liquidation_check` старих позицій скасувати нічим (їх `task_id` залежать від старих `Positions`) — записати як відоме: вони тікатимуть, доки живе старий `FeeEscrow`; це аргумент до майбутнього `program close`.

- [ ] **Step 2: новий keypair.** `mv keys/programs/dexxer_core-keypair.json keys/programs/dexxer_core-keypair.G2ok.json && solana-keygen new --no-bip39-passphrase -o keys/programs/dexxer_core-keypair.json && cp keys/programs/dexxer_core-keypair.json target/deploy/dexxer_core-keypair.json && solana-keygen pubkey keys/programs/dexxer_core-keypair.json` → `NEW_PROGRAM_ID`. Перевірити `git status` — нічого під `keys/` не з'явилось у staged.

- [ ] **Step 3: ID у коді.** `programs/dexxer_core/src/lib.rs:18` → `declare_id!("<NEW_PROGRAM_ID>")`; `Anchor.toml` рядки 11 і 17. Solana MCP `program_autofixer` на `lib.rs`.

- [ ] **Step 4: збірка та IDL.**

```bash
cargo build-sbf --manifest-path programs/dexxer_core/Cargo.toml
cargo build --release --manifest-path tools/idlgen/Cargo.toml
env -u RUSTUP_TOOLCHAIN CARGO_TARGET_DIR="$PWD/tools/idlgen/target/idl-build" tools/idlgen/target/release/idlgen "$PWD/programs/dexxer_core" "$PWD/idl/dexxer_core.json"
grep -c "<NEW_PROGRAM_ID>" idl/dexxer_core.json   # очікувано 7 (address + 6 вкладених)
grep -c "G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV" idl/dexxer_core.json   # 0
ls -l target/deploy/dexxer_core.so
```

  Перевірити, що всі споживачі IDL зелені: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test` (244, 7 skipped), `cd app && npm test` (137), `cargo test -p dexxer_core` (69), `cd tests/litesvm && cargo +nightly-2026-09-18 test -p dexxer_litesvm` (89).

- [ ] **Step 5: гейт користувача — баланс payer і деплой.** `solana balance 4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM --url https://rpc.magicblock.app/devnet` — потрібно ≥ 5.5 SOL (рента program-data ≈4.61 SOL + буфер). Якщо менше — попросити користувача поповнити. Показати команду й отримати «так»:

```bash
solana program deploy target/deploy/dexxer_core.so \
  --program-id target/deploy/dexxer_core-keypair.json \
  --keypair spikes/keys/payer.json --upgrade-authority spikes/keys/payer.json \
  --url https://rpc.magicblock.app/devnet --use-rpc
```

  Після деплою: `solana program dump <NEW_PROGRAM_ID> - --url https://rpc.magicblock.app/devnet | sha256sum` і `sha256sum target/deploy/dexxer_core.so` — збігаються; `solana program show <NEW_PROGRAM_ID> --url …` → записати Program Id, Authority, Last Deployed Slot, Data Length, баланс payer до/після.

- [ ] **Step 6: документи.** `keys/README.md` (новий ID, рядок про старий keypair `*.G2ok.json`), `README.md:143`, `docs/deployments.md`: банер «живе» → нова програма (дата, слот деплою), таблиця програми/PDA — заповнити після Task 3 (тут лише Program Id і помітка «PDA — Task 3»).

- [ ] **Step 7: commit**

```bash
git add programs/dexxer_core/src/lib.rs Anchor.toml idl/dexxer_core.json keys/README.md README.md docs/deployments.md
git commit -m "chore(program): new devnet program id for the position-slots deploy"
```

---

### Task 3: бутстрап devnet — Config, пул, п'ять ринків, кранки, FeeEscrow

**Files:**
- Create: `tests/er/devnet/15-marks.ts` (поллінг `mark_slot` усіх ринків)
- Modify: `tests/er/package.json` (`devnet:marks`), `docs/deployments.md` (таблиця PDA, task_id кранків)
- Keys (не комітити): `tests/er/.keys/devnet-mint.json` → `devnet-mint.G2ok.json` (старий мінт)

**Interfaces:**
- Consumes: `bootstrapDevnet()` (`tests/er/lib/admin.ts:731`), `scripts/admin/fund-fee-payer.ts` (0.2 SOL фіксовано), `tests/er/devnet/add-market.ts` (`--schedule`), `scripts/admin/schedule-eternal.ts` (SOL), `MARKET_CATALOG`, `marketTaskId`, `pdas` з `tests/er/lib/program.ts`.
- Produces: таблиця PDA нової програми (Config, Market×5, MarketRisk×5, Pool, PoolLive, BalancesRoot, FeeEscrow, mint), `task_id` шести кранків (SOL eternal + 5 ринкових); `npm run devnet:marks` — 60 с поллить `Market.mark`/`mark_slot` усіх ринків з `MARKET_CATALOG` і друкує `symbol | mark_slot_start | mark_slot_end | ticks | last_print_changes | sample_seq_delta`, `MARKS PASS`, якщо кожен ринок зробив ≥ 30 тіків і `sample_seq_delta > 0`.

- [ ] **Step 1: гейт користувача — баланси.** Потрібно: `devnet-admin` (`8L4EyWLc6yGH4c3zrVWLCoJqRbgWGtUf9sYyqnMPkVtH`) ≥ 1.0 SOL (бутстрап ≥0.3 + 5 ринків ≈0.03 + fund-fee-payer 0.2 + permission-ренти), `devnet-fee-payer` (`3HgDNwQPnHRRK6Sy5MXTN18zEYpGMJZioiGV3dD3Chnt`) ≥ 0.3 SOL (janitor-підлога 0.002 + спонсорування онбордингів у Task 5–6). Перевірити `solana balance … --url https://rpc.magicblock.app/devnet`, попросити поповнити.

- [ ] **Step 2: ротація мінта.** `mv tests/er/.keys/devnet-mint.json tests/er/.keys/devnet-mint.G2ok.json` — `loadOrCreateKey("devnet-mint")` створить свіжий. Зафіксувати новий mint pubkey після бутстрапу.

- [ ] **Step 3: бутстрап.** `cd tests/er && npm run devnet:bootstrap`. Записати всі надруковані адреси й сигнатури. Якщо крок упав: прочитати помилку, виправити зовнішню причину (баланс, мережа), запустити ще раз — ідемпотентно. Збій саме на `seed_pool`/`delegate_pool` з Anchor 3007 = регресія C1 → BLOCKED, читати `tests/er/lib/poolBootstrap.ts`.

- [ ] **Step 4: FeeEscrow.** `cd tests/er && DEXXER_NET=devnet npx tsx ../../scripts/admin/fund-fee-payer.ts` → баланс FeeEscrow в ER до/після (скрипт друкує). Один запуск = 0.2 SOL; достатньо для Task 5.

- [ ] **Step 5: ринки з кранками.** По черзі: `npm run devnet:add-market -- BTC --schedule`, `… ETH --schedule`, `… HYPE --schedule`, `… ZEC --schedule`. Записати market/marketRisk/feed і `task_id` кожного. Потім SOL: `cd scripts && DEXXER_NET=devnet npm run admin:schedule-eternal` → має надрукувати `SCHEDULE-ETERNAL PASS` (60 с поллінгу `mark_slot`).

- [ ] **Step 6: скрипт `15-marks.ts`** — читає `Market` кожного символу (`pdas.marketFor(symbol)` з `tests/er/lib/program.ts` — так само, як `add-market.ts:38`; для SOL це дорівнює `pdas.market()`), декодує `mark`, `mark_slot`, `last_print`, `sample_seq` за лейаутом `Market` (зміщення — як у `services/relayer/src/indexer`/`app/src/lib/codecs.ts`: … `mark u64 | mark_slot u64 | last_print u64 | sample_seq u64` одразу перед `ema_alpha_bps u16`), поллить кожну секунду 60 с і друкує таблицю з Interfaces. Додати `"devnet:marks": "DEXXER_NET=devnet tsx devnet/15-marks.ts"`. Прогін: `MARKS PASS` для всіх п'яти. Це доводить джерело семплів для `liquidation_check` на кожному ринку (гейт #38).

- [ ] **Step 7: `docs/deployments.md`** — таблиця PDA нової програми, mint, `task_id` шести кранків, дата; `relayer` поки на старій програмі (помітити).

- [ ] **Step 8: commit**

```bash
git add tests/er/devnet/15-marks.ts tests/er/package.json docs/deployments.md
git commit -m "ops(devnet): bootstrap the position-slots program — markets, cranks, marks probe"
```

---

### Task 4: relayer на новій програмі — env, БД, деплой, перевірки

**Files:**
- Modify: `services/relayer/railway.json` (`restartPolicyType`), `services/relayer/src/crank.ts` (рядок тіку: `+ bytes=`), `services/relayer/test/*` (тест форматера рядка), `services/relayer/README.md`, `docs/deployments.md`
- Test: `cd services/relayer && DEXXER_IDL_DIR=$PWD/../../idl npm test`; Postgres-тести з Docker, якщо є

**Interfaces:**
- Consumes: Railway MCP (`list_variables`, `set_variables`, `deploy`/`railway up`, `get_logs`); таблиці `pool_snapshots`, `roots`, `relayer_meta`, `ticks`, `_migrations`; `/healthz`, `/markets`, `/mark?market=`, `/prices?market=`, `/ws?markets=*`.
- Produces: relayer на новій адресі (через IDL у Docker-образі), рядок тіку `tick n=… market=… … cu=… bytes=… candidates=… liquidated=…` (`bytes` = `tx.serialize().length`), `restartPolicyType: "ALWAYS"` (рішення: watchdog робить `process.exit(1)` навмисно — цикл з 10 спроб закінчився б мертвим кранком).

- [ ] **Step 1: код relayer-а.** У `crank.ts` до рядка тіку (`crank.ts:403`, `formatTickLine`) додати `bytes=<n>` з довжини серіалізованої tx перед відправкою; оновити тест форматера `services/relayer/test/crankMarkets.test.ts` (`formatTickLine`) і зафіксувати очікуваний рядок. `railway.json`: `"restartPolicyType": "ALWAYS"`, прибрати `restartPolicyMaxRetries`. `npm test` зелений (лічильник записати).

- [ ] **Step 2: env на Railway.** `list_variables` → показати користувачу план змін: видалити `COMMIT_INTERVAL_TICKS`, `COMMIT_MAX_ACTIONS`, `QUARANTINE_CYCLES`; додати `COMMIT_INTERVAL_MS=60000` (живе значення тижня 5 — 60 тіків ≈ 60 с); лишити `CRANK_WATCHDOG_MS` дефолт (120000) і записати як гейт; `SIWS_DOMAIN=relayer-production-1ae7.up.railway.app` має бути виставлений (інакше `/sponsor`/`/nonce` не монтуються — онбординг 0-SOL не працюватиме). Секрети (`CRANK_KEY_B58`, `FEE_PAYER_KEY_B58`) не чіпати — ті самі ключі `devnet-crank`/`devnet-fee-payer`. Після «так» — `set_variables`.

- [ ] **Step 3: БД — гейт користувача.** Варіант за замовчуванням — `TRUNCATE` трьох таблиць старої програми в живій БД (ціни `ticks` лишити — вони від фіду, не від програми):

```sql
TRUNCATE pool_snapshots, roots;
DELETE FROM relayer_meta;   -- lastCommitAt старої програми
```

  Виконати через `railway connect Postgres` або psql з `DATABASE_URL` (користувач). Альтернатива — нова БД Railway (тоді `DATABASE_URL` змінює користувач). Записати обраний варіант і час.

- [ ] **Step 4: Postgres-тести локально (якщо є Docker).** `docker run -d --rm --name idx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine && cd services/relayer && TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres DEXXER_IDL_DIR=$PWD/../../idl npm test` → 7 Postgres-тестів з `indexerDb.test.ts` мають пройти (не skipped). Без Docker — записати «не виконано», міграцію 008 перевірить лог деплою.

- [ ] **Step 5: деплой.** `railway link -p 2aac2416-043e-4845-8c19-8e1e2e862f4d -e production -s relayer && railway up --service relayer --ci` (або Railway MCP `deploy`). У логах старту: `db: applying migration 008_ticks_market.sql`, перший `tick n=1 market=SOL …` протягом 180 с (інакше healthcheck провалює деплой — записати час до першого тіку).

- [ ] **Step 6: перевірки** (усі з виводом у звіт):

```bash
R=https://relayer-production-1ae7.up.railway.app
curl -s $R/healthz | jq .            # ok:true, markets: SOL,BTC,ETH,HYPE,ZEC з lastTickAt ≠ null
curl -s $R/markets | jq 'map(.symbol)'   # ["SOL","BTC","ETH","HYPE","ZEC"]
curl -s "$R/mark?market=BTC" | jq .   # market:"BTC", stale:false
curl -s "$R/prices?tf=1m&limit=3&market=ETH" | jq .
curl -s -o /dev/null -w '%{http_code}\n' $R/disclosures   # 404
curl -s -o /dev/null -w '%{http_code}\n' $R/stats         # 404
curl -s $R/pool/latest | jq .         # після першого COMMIT_INTERVAL_MS — знімок НОВОГО пулу (capital 10 000 dUSDC округлено)
```

  З логів (`get_logs`, 10 хв): по 3 рядки тіку на ринок → таблиця `market | cu | bytes | tick_ms | candidates` (кандидатів поки 0); рядок `commit n=… sig=…` з `cu`; рядок janitor-а (0 кандидатів). Записати справжні рядки помилок TEE, якщо трапились (`"Invalid token"`, 503 тощо) — вхід для класифікатора.

- [ ] **Step 7: документи** — `services/relayer/README.md` (рядок тіку з `bytes=`, `ALWAYS`), `docs/deployments.md` (env після плану 4, дата деплою, час до першого тіку, БД-рішення).

- [ ] **Step 8: commit**

```bash
git add services/relayer/railway.json services/relayer/src/crank.ts services/relayer/test/crankMarkets.test.ts services/relayer/README.md docs/deployments.md
git commit -m "ops(relayer): deploy on the position-slots program — tick bytes, restart ALWAYS, env"
```

---

### Task 5: сценарії devnet і виміри (M-слоти)

**Files:**
- Create: `tests/er/devnet/16-multi-market.ts`
- Modify: `tests/er/devnet/10-set-params.ts` (прапорець `--market SYM`), `tests/er/package.json` (`devnet:multimarket`)
- Test: прогони 01 → 02 → 03 → 05 → 13 → 11 → 16 → 07 → 08 (+ спостереження janitor-а)

**Interfaces:**
- Consumes: `tests/er/lib/trader.ts` (`onboardTrader`/послідовність 05: `initUserAccounts`, `delegateUserAccounts`, `permissionAccounts`, `creditDeposit`, `initPermissions`, `tradeAccounts(owner, market, …)`, `readPositions`, `U64_MAX`), `tests/er/lib/positions.ts` (`slotFor`, `liqTaskId`), `MARKET_CATALOG`, `set_params` через `dexxerCoreProgram(teeConn(admin), admin)`.
- Produces: `npm run devnet:multimarket` — один трейдер: онбординг (як у 05, ключі `devnet-trader-mm-<ts>`/`devnet-session-mm-<ts>`), депозит, `open_position` SOL і BTC (дві задачі `liquidation_check` на одному `Positions`), `decrease_position` SOL наполовину → `history.at(-1).reason === 2`, форсована ліквідація **лише BTC** (`set_params` BTC, 90×2 с поллінг; SOL-слот має лишитись `Open`), відновлення параметрів BTC, `close_position` SOL, `undelegate_user` з `remaining_accounts = [SOL, BTC]` → обидва акаунти під програмою з `exited = true`, очікування janitor-а (`close_exited_user` relayer-ом; поллінг `UserAccount` до 2×`COMMIT_INTERVAL_MS` + 60 с) → акаунтів нема, рента повернулась на `rent_payer`. Для КОЖНОЇ tx — `getTransaction(sig)` з ER → `meta.computeUnitsConsumed` і `tx.serialize().length` до відправки → таблиця `ix | cu | bytes | sig`. `10-set-params.ts --market BTC KEY=VALUE` — патч параметрів не-SOL ринку.

- [ ] **Step 1: `10-set-params.ts`** — додати `--market SYM` (дефолт SOL), ринок — `pdas.marketFor(symbol)`; інакше без змін.

- [ ] **Step 2: `16-multi-market.ts`** за Interfaces. Форсування ліквідації BTC — ті самі `LIQ_MMR_BPS`/`LIQ_IMR_BPS`, що в 05 (константи скопіювати з `05-crank-liquidation.ts:60`), на `Market` BTC; обов'язково відновити оригінальні параметри в `finally`. Під час поллінгу ліквідації вести лог `liq_ticks` BTC і SOL кожні 2 с — довести, що SOL не ліквідується. Записати, чи ліквідував planувальник (`liquidation_check`, ≤5 с між тіками) чи relayer (`crank_tick` 1 с): скрипт запускати з `CRANK_ENABLED=false` на relayer-і, як робить 13 (`railway variables --set CRANK_ENABLED=false --service relayer`, поллінг `/healthz` до `schedulerActive`), і повертати `true` у `finally` — тоді ліквідація BTC = повтор M-G′ на мульти-маркеті. Додати `"devnet:multimarket": "DEXXER_NET=devnet tsx devnet/16-multi-market.ts"`.

- [ ] **Step 3: прогони за порядком, кожен — запис у `week6-results.md` (Task 7 збирає):**
  1. `npm run devnet:onboard` (01) → M-слоти-A: розміри tx лег (`bytes`), сигнатури, `UserAccount` 207 B / `Positions` 3184 B під Delegation Program.
  2. `npm run devnet:leak` (02) → приватність `Positions` на новому лейауті (рівень 4).
  3. `npm run devnet:commit` (03) → M-слоти-B: вартість `commit_aggregate()` ×12 (FeeEscrow ER до/після, лампорти на коміт).
  4. `npm run devnet:liquidation` (05; relayer увімкнений) → M-слоти-C: ліквідація relayer-ом, секунди, `liq_ticks` історія, рядок тіку з `candidates=1 liquidated=1`, `cu`, `bytes`.
  5. `npm run devnet:liqcheck` (13) → M-слоти-D (M-G′): ліквідація без relayer-а, секунди.
  6. `npm run devnet:liqtask` (11) → реєстрація задачі з `task_context = positions`, cancel невідомого `task_id` — no-op.
  7. `npm run devnet:multimarket` (16) → M-слоти-E: таблиця CU/bytes усіх торгових інструкцій в ER, дві задачі на одному `Positions`, ліквідація лише BTC, запис `reason=2`, вихід з двома ринками, janitor закрив, рента → `rent_payer`.
  8. `npm run devnet:root` (07) → `set_balances_root`/`BalancesRoot` на новій програмі.
  9. `npm run devnet:undelegate` (08, трейдер 01) → M-слоти-F: `undelegate_user` без `ExternalAccountDataModified` на zero-copy `Positions` (гейт автоматичного `exit`), потім janitor.
  Після всього: `curl $R/healthz`, лог relayer-а за період — чи були reconnect-и/watchdog, справжні рядки помилок TEE.

- [ ] **Step 4: не виміряне, що лишається** (записати явно): стійкість задач до рестарту TEE (не контролюємо), вартість задач над вийшовшим акаунтом (спостерігати баланс FeeEscrow 10 хв після виходу трейдера 16 — записати дельту), `crank_tick` з 12 парами (трейдерів менше — записати фактичне `candidates=`).

- [ ] **Step 5: commit**

```bash
git add tests/er/devnet/16-multi-market.ts tests/er/devnet/10-set-params.ts tests/er/package.json
git commit -m "test(er): multi-market devnet scenario and per-market set-params"
```

---

### Task 6: APK на нову програму і smoke з гаманцем

**Files:**
- Modify: `docs/emulator-runbook.md` §6 (результати по кроках), `docs/deployments.md` (APK: дата, відбиток, relayer)
- Build: `app/` (без змін коду; IDL уже новий через `idl/`)

**Interfaces:**
- Consumes: `app/src/lib/config.ts` DEVNET-дефолти (relayer `https://relayer-production-1ae7.up.railway.app`, TEE, валідатор — без змін), `npm run android` (dev client, debug keystore → DAL-дефолт relayer-а збігається), AVD `local_phone` (fakewallet) / `phantom_phone`, проксі `node scripts/emu-proxy.cjs`.
- Produces: заповнений чек-лист §6 (9 кроків) з рядками logcat `[dexxer]` і сигнатурами; список дефектів.

- [ ] **Step 1: збірка й запуск.** `cd app && . "$HOME/.nvm/nvm.sh" && nvm use && npm ci && npm run android` на `local_phone` за runbook §0–1 (проксі, Metro `npx expo start --dev-client --port 8081`). Переконатися в логах старту, що `DEXXER_CORE_PROGRAM_ID` = новий (додати тимчасовий `console.log` НЕ треба — `tests/er` вже друкує; у апці достатньо, що онбординг створює PDA нової програми — перевірити адресу `UserAccount` у logcat проти `pdas.userAccount(owner)` нової програми).

- [ ] **Step 2: smoke — користувач.** Передати чек-лист §6 з позначками, що саме дивитись у logcat; агент НЕ натискає в гаманці. Для кожного кроку користувач повідомляє PASS/FAIL + рядок logcat/сигнатуру; агент перевіряє сигнатури через `getTransaction` і записує.

- [ ] **Step 3: дефекти.** Кожен FAIL — окремий запис (крок, лог, сигнатура, гіпотеза). Виправлення коду апки — НЕ в цьому плані (окремий фікс-коміт за рішенням користувача), крім однорядкових конфігураційних (записати).

- [ ] **Step 4: commit**

```bash
git add docs/emulator-runbook.md docs/deployments.md
git commit -m "docs(week6): smoke results on the position-slots program"
```

---

### Task 7: результати, документи, рішення на потім

**Files:**
- Create: `docs/superpowers/plans/week6-results.md`
- Modify: `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.9: «Виміряно (devnet, <дата>)», закрити «Не виміряно»/«Відкрите для плану 4» вказівниками, лишити справді відкрите), `CLAUDE.md` (новий розділ «Правила тижня 6: позиції-слоти, devnet-виміри» — лише факти з чисел; рядок у «Документи»; `[Застаріло]`-маркери на «на devnet НЕ виміряно» там, де тепер виміряно), `docs/deployments.md` (фінальний стан), `README.md`

- [ ] **Step 1: `week6-results.md`** за форматом тижнів 3–5: `## Task 1…6`, кожен M-слоти-A…F як `### M-…: <скрипт> — PASS|FAIL`, таблиці «Що | Значення» (CU/bytes торгових інструкцій, `crank_tick` cu/bytes по ринках, вартість коміту, секунди ліквідацій, розміри tx онбордингу, час до першого тіку після деплою, баланси до/після для payer/admin/fee_payer/FeeEscrow), «Відкрите після Task N», «Вартість devnet» (сума SOL).
- [ ] **Step 2: spec §2.9** — абзац «Виміряно (devnet)» з числами й сигнатурами; «Відкрите для плану 4» → що закрито, що лишилось (стійкість до рестарту TEE, 12 пар, `dataSlice`, ретеншн `ticks`, uptime-монітор, Sybil #27); рішення про `solana program close G2ok…` — **не виконано**, незворотне, за користувачем (повертає ≈4.6 SOL ренти старої програми; старі задачі планувальника помруть разом з нею).
- [ ] **Step 3: CLAUDE.md** — розділ з виміряними правилами (наприклад, «`posted_slot` змінюється на кожному принті — виміряно», фактичний `cu`/`bytes` `crank_tick`, вартість коміту, час ліквідації з планувальника й relayer-а, `restartPolicy ALWAYS`), рядок у «Документи», маркери.
- [ ] **Step 4: перевірка посилань** — `grep -rn "G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV" --include=*.md --include=*.json --include=*.ts --include=*.rs . | grep -v node_modules | grep -v target` → лише історичні згадки з датами/маркерами.
- [ ] **Step 5: commit**

```bash
git add docs/superpowers/plans/week6-results.md docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md CLAUDE.md docs/deployments.md README.md
git commit -m "docs(week6): position slots measured on devnet — results, rules"
```
