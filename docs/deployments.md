# Деплойменти

Живі деплойменти Dexxer поза локальним чекаутом. Жодних секретів у цьому
файлі — лише публічні ідентифікатори (project/service id, домен, PDA,
program id) і ролі ключів.

> **Стан на 01.10.2026.** Усе нижче, що описує живий деплой (program id, адреси, виміри, env на
> Railway), — це **стара** програма `G2ok…` і **старий** relayer (розкриття, `DisclosureQueue`,
> `Position` на ринок). Гілка `positions-slots` (нова програма на слотах, relayer і адмін-TS на ній,
> `services/relayer/README.md`) на devnet **не задеплоєна**: чистий старт з новим keypair програми —
> план 4 (spec §2.9.5). Зміни, які настануть із деплоєм плану 4 (перейменовані/видалені env,
> видалені ендпоінти), позначено «після деплою плану 4»; розділ «Позиції-слоти — розкатка (план 4)»
> нижче — порядок дій, нічого з нього не виконано й не виміряно.

## Railway — `services/relayer`

Крank-fallback (Task 4, week 4) як always-on сервіс на Railway, замінює
ручний запуск `scripts/crank-fallback` з ноутбука.

| | |
| --- | --- |
| Проєкт | `dexxer` (id `2aac2416-043e-4845-8c19-8e1e2e862f4d`) |
| Оточення | `production` (id `0a5d310b-fac2-40f9-88d1-630df862695a`) |
| Сервіс `relayer` | id `c2581443-1fa1-46ce-bb08-8e95b1fd682f` |
| Сервіс `Postgres` | id `8d0f27fb-6df7-4eeb-8086-790f4d4ef3c5` |
| Домен | https://relayer-production-1ae7.up.railway.app |
| Healthcheck | `GET /healthz`, шлях налаштований у `services/relayer/railway.json` |
| Build | Dockerfile, контекст — корінь репо (`RAILWAY_DOCKERFILE_PATH=services/relayer/Dockerfile`, root directory сервісу `/`) |

Перевірено (22.09.2026): `curl https://relayer-production-1ae7.up.railway.app/healthz`
→ `200 {"ok":true,"tick":21+,"db":"ok",...}`; deploy-логи показують
`tick n=... slot=... mark=... sig=... liquidated=[]` кожну секунду проти
реального devnet-tee (`https://devnet-tee.magicblock.app`).

**Перевірено знову (23.09.2026, week 5, після фінального деплою з quarantine):**
```json
{"ok":true,"tick":11,"feePayerSol":0.191982024,"commitIntervalTicks":60,"commitMaxActions":4, ...}
```
Живий прогін 3 послідовних disclosure-циклів підтвердив: отруєна черга (`0xA0000002` на кожному
бюджеті) виключається rotation/quarantine-механізмом і більше не блокує молодші черги — деталі,
сигнатури й таблиця циклів у `docs/superpowers/plans/week5-results.md` §Task 7.0.

### Ключі (ролі, не значення)

Приватність-правило (CLAUDE.md): relayer тримає ЛИШЕ `crank`/`fee_payer` —
ніколи owner/session-токени.

| Env var на сервісі `relayer` | Роль | Джерело локально |
| --- | --- | --- |
| `CRANK_KEY_B58` | `Config.crank` — підписант `crank_tick`/`set_balances_root`/`close_orphan_queue` (`mark_committed` видалено тижнем 5); permission-член (`[owner, session, crank]`) кожної приватної `Position` | `tests/er/.keys/devnet-crank.json` |
| `FEE_PAYER_KEY_B58` | `Config.fee_payer` — єдиний прийнятний `payer` для `commit_aggregate` | `tests/er/.keys/devnet-fee-payer.json` |
| `DATABASE_URL` | reference-змінна на сервіс `Postgres` (`${{ Postgres.DATABASE_URL }}`) | — |
| `DEXXER_NET` | `devnet` | — |
| `PORT` | `8080` | — |
| `RAILWAY_DOCKERFILE_PATH` | `services/relayer/Dockerfile` | — |
| `ASSETLINKS_PACKAGE` | не задано (дефолт `com.dexxer.app`) | Digital Asset Links для MWA identity verification (24.09), `GET /.well-known/assetlinks.json` |
| `ASSETLINKS_SHA256_FINGERPRINTS` | не задано (дефолт — сертифікат debug-keystore dev-client-а `FA:C6:17:45:…:3B:9C`) | для release-збірки виставити власний відбиток(и), через кому |
| `COMMIT_INTERVAL_TICKS` **(week 5; після деплою плану 4 — замінюється)** | інтервал disclosure/orphan-циклу в тіках crank-петлі; дефолт 300, **живе значення `60`** (≈1 хв, обрано для демо M-H — reveal за один цикл при `disclosure_delay_slots=0`); замінює зашитий `DISCLOSURE_EVERY_TICKS` тижня 4. **Після деплою плану 4:** змінну прибрати, виставити **`COMMIT_INTERVAL_MS=60000`** (годинник, не тіки; дефолт 300000, мін. 10000) — старе `60` (тіків) у новому образі ігнорується, дефолт 5 хв | — |
| `COMMIT_MAX_ACTIONS` **(week 5; після деплою плану 4 — видалити)** | бюджет дій на один бандл, який relayer **передає в програму** аргументом `commit_aggregate(max_actions)` (апгрейд #3) і яким же обмежує вибір черг; дефолт і **живе значення `4`**, clamp `[1, 8]` (8 — програмна СТЕЛЯ `MAX_ACTIONS_PER_COMMIT`, не кількість дій у бандлі); halve-and-retry на `0xA0000002` халвить і аргумент, і бюджет вибірки. Реальний бридж MagicBlock відхиляє 8 реальних дій за раз, 4 проходять (виміряно на живому беклозі, `week5-results.md` §Task 7). **До апгрейду #3** цей env обирав лише *які* черги йдуть у бандл — програма емітила до 8 дій на чергу незалежно від нього, через що одна повна черга ніколи не комітилася | — |
| `QUARANTINE_CYCLES` **(week 5; після деплою плану 4 — видалити)** | скільки циклів ізолювати `DisclosureQueue`, що впала 2 рази поспіль на `0xA0000002`; дефолт **10** (не виставлявся окремо, лишено дефолтним) | — |
| ~~`SPONSOR_ALLOW_SESSION_TOPUP`~~ **видалено (week 5)** | гілка session-lamports top-up через `/sponsor` прибрана разом з env-змінною — devnet-tee відхиляє чужого `fee_payer` як платника не-ним-ініційованої ER-tx (`InvalidAccountForFee`), тож ця гілка була недосяжна для чесного клієнта й досяжна лише для атакера | — |
| `SIWS_DOMAIN` **(week 6, обов'язковий)** | домен MWA identity app (`IDENTITY_DOMAIN`; зараз = хост relayer-а, тобто **`relayer-production-1ae7.up.railway.app`**). SIWS-повідомлення з іншим `domain` або з `uri` на іншому хості відхиляються. **Без цієї змінної `/auth/*`, `/sponsor` і `/nonce` не монтуються** (fail-closed, лог `sponsor: … SIWS_DOMAIN is not set`) — онбординг і депозит 0-SOL-гаманців зупиняються. Якщо app отримає власний домен (`EXPO_PUBLIC_IDENTITY_URI`), `SIWS_DOMAIN` змінюється разом із ним | — |
| `MARKETS_REFRESH_MS` **(після деплою плану 4, необов'язкова)** | період оновлення реєстру ринків relayer-а; дефолт 60000, мін. 5000 | — |
| `JANITOR_RETRY_COOLDOWN_MS` **(після деплою плану 4, необов'язкова)** | пауза на власника після `close_exited_user`, який програма відхилила on-chain; дефолт 3600000, мін. 60000 | — |
| `JANITOR_MIN_FEE_PAYER_SOL` **(після деплою плану 4, необов'язкова)** | janitor пропускає весь прохід (і пише помилку), поки базовий баланс `fee_payer` нижчий; дефолт 0.002, мін. 0 (`0` — без порогу) | — |
| `CRANK_BAD_PAIR_COOLDOWN_MS` **(після деплою плану 4, необов'язкова)** | скільки пара `[Positions, UserAccount]`, яку програма відхилила поодинці, лишається поза батчами; дефолт 60000, мін. 5000 | — |
| `CRANK_WATCHDOG_MS` **(після деплою плану 4, необов'язкова)** | якщо за цей час не завершилась жодна ітерація crank-петлі — процес виходить з кодом 1, і Railway (`ON_FAILURE`) його перезапускає; дефолт 120000, мін. 30000 | — |
| `AUTH_SESSION_TTL_HOURS` **(week 6)** | тривалість SIWS-сесії relayer-а; дефолт **168** (7 діб), невалідне/≤0 → дефолт. У `auth_sessions` зберігається лише `sha256(token)` | — |

Обидва ключі закодовано локально через `bs58.encode(Uint8Array.from(JSON.parse(readFileSync(...))))`
і встановлені через Railway API — значення ніколи не потрапляли в git чи в
цей файл.

### Program / PDA (devnet, з `tests/er/lib/program.ts`)

| | Адреса |
| --- | --- |
| `dexxer_core` program id | `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| `Config` PDA | `5pTVyygsH7AYujAPCrtfViVT8e9GM1aWVt5pAjMYLGZK` |
| `Market` PDA (SOL) | `1347yiBYsvCwqjJf8TUB9D4KSPp7RVF2cwQxfxSj4udp` |
| `MarketRisk` PDA | `GNyNkDkb4CpG4ftuimmXsoXVxdv9tmoQRusmhfZvgnr5` |
| `Pool` PDA (dUSDC) | `S7S157Q7VGBSxfeUXscrdnobbMKC2gTFKXpQe5L31mj` |
| `BalancesRoot` PDA | `8VsGYfSbfAi8NSPh6xFvMQfvYSiQL1HwPrvL4YdhNDVZ` |
| `FeeEscrow` PDA | `85ncXT9nYSAjjne8zA2e32Ew77EPygfJnPF15aqsLhJH` |
| Oracle feed PDA (SOL/USD, `feedUnder(ORACLE, "6")`) | `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` |
| Base RPC | `https://rpc.magicblock.app/devnet` |
| ER/TEE | `https://devnet-tee.magicblock.app` |

### Деплой (як відтворити)

```sh
railway link -p 2aac2416-043e-4845-8c19-8e1e2e862f4d -e production -s relayer
railway up --service relayer --ci   # build context = repo root, див. services/relayer/Dockerfile
```

Змінні середовища (`set_variables`/`add_reference_variable` через Railway
MCP, або `railway variables set` через CLI) виставляються один раз і не
входять у деплой-скрипт.

**Розкатка SIWS-гейту (week 6, spec §2.7) — порядок має значення:**

1. `railway variables set SIWS_DOMAIN=relayer-production-1ae7.up.railway.app --service relayer` — **до** деплою (інакше `/sponsor`/`/nonce` зникнуть, fail-closed).
2. Деплой relayer-а (`railway up …` вище). У лозі старту має бути `sponsor: /sponsor enabled (… SIWS domain relayer-production-1ae7.up.railway.app, session TTL 168 h)` і `db: applying migration 006_auth.sql`.
3. Смоук: `curl -X POST https://relayer-production-1ae7.up.railway.app/auth/challenge` → 200 з `nonce`; `curl -X POST …/nonce` без токена → 401.
4. Новий APK. Старий APK після кроку 2: `/sponsor` → 401 (онбординг 0-SOL падає з помилкою), `/nonce` → 401 → мовчазний відкат на живий blockhash (Phantom — «confirm timeout»). Зворотний порядок безпечний: новий APK проти старого relayer-а (без `/auth`, 404) працює як раніше — сесія просто не береться.
5. Живий чекліст на пристрої (fakewallet, потім Phantom): Connect — **один** SIWS-промпт, у лозі relayer-а `auth: session issued for <owner>`; онбординг 0-SOL і Deposit — без 401 у лозі relayer-а й без додаткового промпту; вже підключений до оновлення гаманець — рівно один додатковий `signMessage`-промпт на першому онбордингу/депозиті. Якщо гаманець ігнорує переданий `nonce` у `signIn` — Connect усе одно проходить (лог `relayer session not issued at Connect`), сесію видає `ensureRelayerSession` окремим промптом.

### Відомі спостереження

- Кілька застарілих `UserAccount` з попередніх тестових прогонів (старий
  110/109-байтовий layout, до `last_withdraw_slot`) клієнтський фільтр
  пропускає щотіку (лог `skipping candidate ... stale layout?`) — той самий
  клієнтський фільтр, що й до переїзду в `services/relayer` (CLAUDE.md,
  правило `crank_tick`). Не є регресією Task 4.
- `schedulerActive` у `/healthz` (Task 7, 23.09.2026): `null`, доки
  `CRANK_ENABLED=true` (не атрибутовано — і relayer, і scheduler можуть
  рухати `Market`); `true`/`false` лише коли `CRANK_ENABLED=false` — див.
  розділ «Scheduler (Task 7)» нижче.

## Позиції-слоти — розкатка (план 4; код — гілка `positions-slots`, 01.10.2026)

Нічого з цього на devnet не виконано і не виміряно. Нова програма (`Positions` на 16 слотів, без
розкриття, #38/#39) — **чистий старт**: новий keypair програми, нова адреса, без міграції зі старого
`G2ok…` (spec §2.9.5); relayer і адмін-TS на гілці вже написані проти нового IDL
(канонічний — `idl/dexxer_core.json`, `DEXXER_IDL_DIR=/app/idl` у Dockerfile). Застосунок (`app/`)
досі на старому IDL до плану 3, тож новий relayer і старий APK несумісні за онбордингом і History.
Порядок:

0. **Перед деплоєм на devnet — свіжий `bootstrap()` на mb-stack** (`cd tests/er && npm run q1` або
   `npm run week1` у `scripts/` — обидва викликають `bootstrap()`). Порядок пулу в `bootstrap()`/`bootstrapDevnet()` виправлено фінальним ревʼю
   (C1: `init_pool` → `init_pool_live` → faucet + `seed_pool` → `delegate_pool_live` →
   `delegate_pool`; попередній порядок на чистому старті падав на `seed_pool` з Anchor 3007 і лишав
   `PoolLive` делегованим з нулями). Виправлено читанням Rust-контекстів, **жодного разу не
   виконано** — перший прогін має бути на mb-stack, не на devnet.
1. Новий keypair програми (`keys/programs/`, gitignored), `declare_id!`, деплой. **Ротувати
   `tests/er/.keys/devnet-mint.json`** (перейменувати/прибрати старий файл): `init_config` створює
   мінт dUSDC через `init`, а наявний ключ — мінт старого деплою, тож `init_config` на ньому впаде.
   Потім `bootstrapDevnet` (Config, пул, SOL). Якщо прогін зупинився посередині, його можна
   перезапустити — кожен крок пропускається, якщо вже зроблений; стан, який жоден порядок не
   завершить (`PoolLive` чи `Pool` делеговані до `seed_pool`), дає зрозумілу помилку до відправки
   будь-чого.
2. **Поповнити новий `FeeEscrow`** (`cd tests/er && DEXXER_NET=devnet npx tsx
   ../../scripts/admin/fund-fee-payer.ts`): з нього платяться `commit_aggregate` і реєстрація задачі
   `liquidation_check` у **кожному** `open_position`; порожній `FeeEscrow` зупиняє і коміти, і
   відкриття позицій.
3. Ринки: `cd tests/er && npm run devnet:add-market -- BTC --schedule` (далі `ETH`, `HYPE`, `ZEC`;
   лазер-фіди — `tests/er/lib/markets.ts`). **`add-market` відхиляє `SOL`** — SOL створює
   `bootstrapDevnet`, а запланований `crank_tick` для SOL заводить `scripts/admin/schedule-eternal.ts`
   (`npm run admin:schedule-eternal --prefix scripts`). Розклад потрібен **кожному** ринку: ліквідація
   без relayer-а потребує живого `crank_tick` на ринку як джерела цінових семплів (#38, spec §2.9.2).
   Ринок з'являється в `/markets` лише після успішного `init_market_permissions` (relayer перевіряє
   власника permission-PDA `MarketRisk`); недороблений `add-market` просто перезапустити. Crank
   після деплою плану 4 тікає й ринок, якого ще нема в реєстрі, якщо на ньому є відкриті позиції
   (див. «Поведінка relayer-а після деплою плану 4» нижче).
4. Railway env (див. таблицю вище): `COMMIT_INTERVAL_TICKS=60` → **`COMMIT_INTERVAL_MS=60000`**;
   видалити `COMMIT_MAX_ACTIONS`, `QUARANTINE_CYCLES`; за потреби `MARKETS_REFRESH_MS`,
   `JANITOR_RETRY_COOLDOWN_MS`, `JANITOR_MIN_FEE_PAYER_SOL`, `CRANK_BAD_PAIR_COOLDOWN_MS`,
   `CRANK_WATCHDOG_MS` (дефолти — у таблиці); `SIWS_DOMAIN` і решта — без змін. `fee_payer` потребує поповнення:
   він платить комісії комітів, `/sponsor`, nonce і ренту онбордингу (`Positions` ≈0.0231 SOL +
   `UserAccount` ≈0.0023 SOL на спонсорованого власника; LiteSVM-розрахунок, на devnet не виміряно),
   плюс janitor-комісії (janitor не стартує, поки `fee_payer` < `JANITOR_MIN_FEE_PAYER_SOL`).
5. **Postgres живого сервісу належить старій програмі.** `pool_snapshots`, `roots` і рядки `meta`
   (`lastTickAt`, `lastCommitAt`) — дані `G2ok…`: `/pool/latest` і `/root/latest` віддаватимуть старий
   пул/root, доки новий relayer не зробить перший коміт. Вирішити на деплої: `TRUNCATE` цих таблиць
   (і `DELETE` рядків `meta`) або нова БД. Новий relayer `lastTickAt` більше не відновлює і не пише
   (`/healthz.ok` — лише про поточний процес), `lastCommitAt` відновлює — зі старої БД він показав би
   час коміту старої програми.
6. **До деплою relayer-а прогнати Postgres-тести** (`TEST_DATABASE_URL`, рецепт у
   `services/relayer/README.md`) — 7 тестів `indexerDb.test.ts` на гілці **не запускались** (немає
   Docker), міграція `008` на справжній БД не перевірена. На старті в лозі має бути
   `db: applying migration 008_ticks_market.sql`.
7. Перевірка: `/healthz` → `markets` з SOL/BTC/ETH/HYPE/ZEC і ненульовим `lastTickAt`;
   `GET /markets` — п'ять записів (SOL першим); `GET /mark?market=BTC` → `stale:false`;
   `/disclosures` і `/stats` → 404 (очікувано). `/healthz.ok` = свіжість тіку **SOL** після вдалого
   відбору кандидатів; новий процес відповідає 503, доки не зробить такий тік сам (раніше `lastTickAt`
   відновлювався з Postgres). Railway чекає healthcheck лише під час деплою
   (`healthcheckTimeout: 30` у `railway.json`) — перший тік SOL має встигнути за 30 с; не виміряно.
8. Невиміряне, що входить у план 4 (повний перелік — spec §2.9 «Відкрите для плану 4»): розмір і CU
   реального `crank_tick` із 12 парами; читання `Positions` crank-токеном через
   `getProgramAccounts` (один виклик за тік повертає ≈4.4 KB на трейдера — оцінка за розміром
   акаунта, ≈440 KB на 100 трейдерів, ≈4.4 MB на 1000); читання власників permission-PDA реєстром;
   Postgres-тести і міграція `008`; перший гейт — що `posted_slot` реального Pyth Lazer змінюється на
   кожному принті.
9. Відкриті пункти й гейти плану 4 (фінальне ревʼю плану 2, 01.10.2026):
   - **Немає шляху скасувати запланований crank ринку, крім SOL:** `scripts/admin/cancel-crank.ts`
     знає лише `task_id` SOL (`sha256(program id)[..8]`), а `add-market --schedule` реєструє задачу з
     власним `task_id` ринку.
   - **Кілька запланованих кранків з одним `taskContext = admin`** (SOL + кожен `add-market
     --schedule`) — чи співіснують вони в планувальнику TEE, не виміряно.
   - **`restartPolicyMaxRetries: 10`** (`railway.json`): watchdog і вихід з кодом 1 перезапускають
     relayer, але цикл падінь (напр. TEE недоступний на старті) після 10 спроб лишає сервіс
     зупиненим.
   - **`/healthz` Railway викликає лише під час деплою** — пізніший 503 нічого не перезапускає;
     зовнішній uptime-монітор на `/healthz` — у план 4.
   - **Таблиця `ticks` без ретеншну** і тепер росте пропорційно кількості ринків.
   - **Відбір кандидатів завантажує цілі акаунти `Positions`** щотіку (≈4.4 KB на трейдера, оцінка) —
     `dataSlice` до слотів — подальша робота.

### Поведінка relayer-а після деплою плану 4 (фінальне ревʼю, 01.10.2026; лише тести, не devnet)

- **Коміт-цикл відокремлений від тіків:** root → `commit_aggregate()` → janitor стартує за
  годинником і петля його не чекає; одночасно — не більше одного циклу; на `SIGTERM` петля дочікується
  циклу, що вже йде (жорсткий таймаут `shutdown()` — 5 с, як і був).
- **Перезапуск:** `process.exit(1)`, коли `startCrank` падає (збій старту чи петлі), і watchdog
  `CRANK_WATCHDOG_MS`, коли ітерація петлі не завершилась вчасно; `blockhash`, що не оновлюється
  5 с, — помилка зʼєднання, не вічний цикл.
- **Набір ринків для тіків:** SOL завжди, реєстр, кожен ринок, який процес уже тікав (не зникає),
  і кожен ринок із відкритими кандидатами — невідомий читається з публічного `Market` один раз.
  Гейт приватності реєстру (`MarketRisk` уже приватний) лишився для `/markets` та індексера.
- **Помилки:** один класифікатор (`src/errors.ts`): on-chain = транзакція приземлилась і програма її
  відхилила; решта (401, таймаути, `fetch failed`, 429, 5xx) — помилка зʼєднання. Перша помилка
  зʼєднання зупиняє ринок і решту петлі (наступні ринки цього циклу не тікають), один reconnect.
  Чанк, відхилений on-chain, спершу перевіряється тіком без кандидатів: відхилений і він — винен ринок
  (без поодиноких повторів і карантину); пройшов — кандидати повторюються поодинці, пара, відхилена
  поодинці on-chain, іде в карантин на `CRANK_BAD_PAIR_COOLDOWN_MS`. Збій відбору кандидатів — кожен
  ринок тікає без кандидатів, `lastTickAt` не рухається.
- **Janitor:** перша помилка зʼєднання обриває прохід (без паузи для власника), прохід пропускається,
  поки `fee_payer` нижче `JANITOR_MIN_FEE_PAYER_SOL`.
- **Логи без ключів трейдерів:** рядок тіку — `tick n=… market=… mark=… mark_slot=… sig=… cu=…
  tick_ms=… candidates=<кількість> liquidated=<кількість>` (без `slot=`; поле, яке не вдалося
  прочитати, — `null`); рядки карантину й відбору (`crank n=…`) — `tag=<8 hex>` замість ключа.

**Міграція 008 — перекриття деплоїв і відкат.** `008_ticks_market.sql` переносить PK `ticks` з `(ts)`
на `(market, ts)` (рядки до неї — `'SOL'`) і прибирає індекс `ticks_ts_idx`. Старий образ після неї:
`insertTick` з `ON CONFLICT (ts)` падає (унікального обмеження на `ts` більше нема) — тіки не
пишуться; запити без фільтра ринку віддали б тіки BTC/ETH/… як SOL. Тому вікно перекриття деплоїв
може коротко показати в старих ендпоінтах чужу ціну, а **відкат на образ до 008 без відкату схеми —
неприпустимий**. Відкат — однією транзакцією:

```sql
-- 1) зупинити indexer (INDEXER_ENABLED=false або зупинити сервіс), потім:
BEGIN;
DELETE FROM ticks WHERE market <> 'SOL';
ALTER TABLE ticks DROP CONSTRAINT ticks_pkey;
ALTER TABLE ticks ADD PRIMARY KEY (ts);
ALTER TABLE ticks DROP COLUMN market;
CREATE INDEX IF NOT EXISTS ticks_ts_idx ON ticks (ts);          -- як у 001_indexer.sql
DELETE FROM _migrations WHERE name = '008_ticks_market.sql';    -- щоб повторний деплій нового образу знову її застосував
COMMIT;
-- 2) деплой старого образу
```

Рецепт відкату не прогнано — ні на справжньому Postgres, ні на копії живої БД.

## Індексер публічних даних (Task 5, 22.09.2026)

Другий підсервіс усередині того ж `relayer`-процесу (`INDEXER_ENABLED=true`
на сервісі `relayer`, той самий `Postgres`) — читає ЛИШЕ публічні акаунти
(оракул без токена на TEE RPC, `Pool`/`BalancesRoot`/`Disclosure` на base
RPC), ніколи `crank`/`fee_payer`-ключі. REST + WS ендпоінти на тому ж
домені/порту:

| Ендпоінт | Приклад відповіді (live, 22.09.2026) |
| --- | --- |
| `GET /prices?tf=1m&limit=5` | `{"tf":"1m","candles":[{"t":1790106000000,"o":118309140,"h":118327003,"l":118306592,"c":118324531}, ...]}` |
| `GET /mark` | `{"price":"118314540","slot":335253475,"ts":1790106407044}` |
| `GET /pool/latest` | `{"slot":335177389,"ts":1790106155570,"capital_total":"24100000000","protocol_liquidity":"9900000000","locked_total":"100000000","fees_accrued":"0","insurance":"0","bad_debt_total":"0"}` |
| `GET /disclosures?limit=3` | масив із 3 записів закритих позицій (реальні devnet-угоди тижнів 3-4). **Після деплою плану 4 — 404** (розкриття прибрано) |
| `GET /root/latest` | `{"root_slot":335228040,"filled":11,"leavesHex":[...64 hex-рядки...]}` |
| `GET /disclosures?limit=2&market=…` **(week 6; після деплою плану 4 — 404)** | масив + заголовок `X-Next-Cursor: 348880561.2F4jr1u2…`; кожен запис має `market` (`1347yiBY…` — PDA SOL-ринку). Фільтри `side`/`reason`/`market`/`from`/`to`, курсор — `services/relayer/README.md` «Pagination, filters, stats» |
| `GET /stats?window=all` **(week 6; після деплою плану 4 — 404)** | `{"window":"all","market":null,"trades":42,"longs":41,"shorts":1,"liquidations":4,"wins":21,"volume_quote":"4945668443","pnl_total":"1433766","fees_total":"7214965","win_rate":0.5,…}` (локальний indexer проти devnet, 27.09.2026) |
| `wss://…/ws` | `{"type":"mark","price":"118284685","ts":1790106415146}` кожну секунду (throttle) |

**Після деплою плану 4** (код на гілці `positions-slots`): індексер читає лише оракул (по ринках),
`Pool`, `BalancesRoot`; нові `GET /markets`, `?market=` на `/mark`/`/prices`, `/ws?markets=`
(без параметра — лише SOL), міграція `008_ticks_market.sql` (деталі, відкат і перекриття деплоїв —
розділ «Позиції-слоти — розкатка (план 4)» нижче). Таблиця `disclosures` у живій БД лишається, але
невживана (не видаляється). `/healthz` несе `commitIntervalMs` і `markets`, без `commitIntervalTicks`,
`commitMaxActions`, `indexer.disclosures`.

Повна специфікація ендпоінтів, формат чисел (bigint-поля як рядки) і
внутрішня будова — `services/relayer/README.md`'s "Indexer" section.

Міграція `services/relayer/migrations/001_indexer.sql` (таблиці `ticks`,
`pool_snapshots`, `disclosures`, `roots`) застосувалась автоматично на
рестарті (той самий `migrate()`, що й `000_meta.sql` у Task 4).

**Тиждень 6:** `007_disclosures_market.sql` (колонка `market` + індекси
keyset/`ts`/`market`) застосується так само на першому рестарті після деплою;
вже проіндексовані розкриття отримають `market` протягом ≈30 с (наступний
poll), без повторного WS-broadcast. Перевірка після деплою:
`curl …/stats?window=all` → `trades > 0`, `curl -D - "…/disclosures?limit=1"` →
заголовок `X-Next-Cursor` і непорожній `market`.

`/healthz` тепер несе й `indexer: { ticks, lastTickTs, lastPoolSlot,
disclosures, wsClients }` — перевірено live:
`{"ok":true,...,"indexer":{"ticks":44,"lastTickTs":1790106401894,"lastPoolSlot":null,"disclosures":0,"wsClients":0}}`
одразу після рестарту (лічильники ростуть з нуля щоразу; `/pool/*` і
`/disclosures` REST читають з Postgres напряму, тож стан там переживає
рестарт, на відміну від `stats`-лічильників у `/healthz`).

## Scheduler (Task 7 тижня 4, 23.09.2026)

**Історичний запис, частково витіснений тижнем 5** — весь цей розділ описує
глобальний `schedule_crank` (mark/EMA-backstop, `ScheduleCrank` без
`remaining_accounts`, справді НЕ ліквідує — висновок нижче лишається
правильним для цього конкретного механізму). Тиждень 5 додав окремий,
незалежний механізм — `liquidation_check`, per-position scheduler-задача,
що реєструється самою програмою в `open_position` і **справді ліквідує без
relayer-а** (M-G′, `week5-results.md` §Task 7.1, PASS за 6.97 с). Обидва
механізми живуть одночасно на devnet: `schedule_crank`/`schedule-eternal.ts`
нижче лишається задеплоєним і продовжує рухати лише `Market.mark`;
`liquidation_check` реєструється автоматично для кожної нової позиції з
Task 3-апгрейду (`26ee85a..a6d5623`) і окремого deploy-скрипту не має.

`scripts/admin/schedule-eternal.ts` (`npm run admin:schedule-eternal --prefix
scripts`) зареєстрував `crank_tick` як MagicBlock-задачу планувальника з
`iterations = i64::MAX` на реальному `dexxer_core` — закриває тех-борг №18
(спека тижня 3 виміряла лише на одноразовому spike-деплої, це перший запуск
на живому контракті).

| | |
| --- | --- |
| `task_id` | `-8632762600545312817` (той самий, що й `schedule-crank.ts` — детермінований `sha256(program id)[..8]`, повторний `schedule_crank` над тим самим `task_id` — оновлення, не нова задача) |
| `interval_ms` | `1000` |
| `iterations` | `9223372036854775807` (i64::MAX) — **прийнято** з першої спроби, без потреби у fallback `cancel_crank`+retry |
| `set_scheduler_signer` | не знадобився — `Config.scheduler_signer` вже дорівнював `crank_signer_pda(admin)` з тижня 2 |
| `schedule_crank` sig | `2rF82FDokgMurrZTNqvG9DkDjXZh3tjvoczEZw7tG79XH1Go4984McYeg2C7c2bGT8n6EntsNfX8WiXE8FDQy3ER` |
| 60-секундний пруф (11 семплів, `Market.mark_slot`) | 11 різних слотів, монотонно (напр. `339119462 → 339125562`) — планувальник реально тіка́є |

### M-G: вимір «планувальник як backstop» (relayer crank вимкнено)

Новий env `CRANK_ENABLED` на `services/relayer` (default `true`; `false` —
crank-петля взагалі не стартує, `/healthz.crankEnabled: false`, `ok`
лишається `true` — стейлнес тіку більше не впливає на здоров'я, коли
crank навмисно вимкнений). Новий `marketWatch.ts` — неавтентифіковане
читання публічного `Market` на ER (окремо від `cfg.crank`'s TEE-токена),
керує `/healthz.schedulerActive`: `null`, доки `CRANK_ENABLED=true`
(не атрибутовано — і relayer, і scheduler можуть рухати `Market`);
`true`/`false` лише коли `CRANK_ENABLED=false`.

| Крок | Дія | Результат |
| --- | --- | --- |
| 1 | `railway variable set CRANK_ENABLED=false` + `railway up --service relayer --ci` (деплой `db16e79e-ee74-4be6-8d20-69a0bf2b0b2c`) | `/healthz` → `crankEnabled:false` |
| 2 | Поллінг `/healthz` ~70 с з вимкненим relayer-crank | `tick` лишався `0` (relayer-петля справді не стартувала), `schedulerActive:true` безперервно, `ok:true` — **PASS «scheduler ticks without relayer»** |
| 3 | `05-crank-liquidation.ts`: свіжий трейдер (0.05 SOL з `devnet-admin`, попередньо дозаряджений +0.15 SOL з `payer`, sig `3Lby7PHhrYwpD7yFgcfT8q1XHYqK9NZY1ujbje9n7BobVaeo6jSH1zKodydpmqMsPXFW1boxjR3vqmUNDbZpU1dt`), `open_position` ~9.09× long (sig `yKnAMreMqksX7wLWD65HG6hH76PuWggmgaHETDsugRRhWUSvKN5RwpNdp5XmA34W7bXfwjiBeyw4KRmqiaPAbxZ`), admin `set_params(mmr_bps=9500, imr_bps=9600)` (sig `234nfZt3FoUyS1YqW8cp1GhhtHfAMeATYLMZmCbci3UJzcBtDFsWJceUjsZkA3ru9q7iwDPwZ5DtUSEdZ5Sieebd`), поллінг `Position.liq_ticks`/`state` 90×1 с | `liq_ticks` лишався **пласким `0` усі 90 семплів** — жодного тіку `crank_tick`, що бачив би цю позицію, за вікно спостереження. **FAIL «scheduler liquidates without relayer»** — **архітектурна причина, не таймінг**: `ScheduleCrank` (`programs/dexxer_core/src/instructions/crank.rs`) реєструє заплановану `crank_tick`-задачу з фіксованим набором акаунтів БЕЗ `remaining_accounts` (список акаунтів задачі фіксується в момент реєстрації, кандидатів ліквідації в нього додати неможливо) — власний коментар коду це прямо каже: «carries NO remaining_accounts (liquidation candidates are supplied by the fallback script's own `crank_tick` calls, not by the scheduler)». Тобто запланований тік **завжди виконується з нульовою кількістю кандидатів** — він рухає лише `Market.mark`/EMA, ніколи не оцінює й не ліквідовує жодної позиції, незалежно від `iterations`/часу очікування. Позицію відновлено безпечною: `set_params`-відкат (sig `39riRACXRoA8BiTwQ6Grioba4pbmC2xZaUktGshPxk2QGWztrAJ8r9ZsDAUB7E8yGi3Acc73JdzwN8zhYYQkU8xB`) повернув **обидва** поля — `mmr_bps` до `500` і `imr_bps` до `1000` |
| 4 | `railway variable set CRANK_ENABLED=true` + `railway up --service relayer --ci` (деплой `47ff81f6-183d-401f-9177-6b059d36a82f`) | `/healthz` → `crankEnabled:true`, `schedulerActive:null` (як задумано), `tick` знову росте (relayer-петля відновлена) |

**Field-for-field звірка кроку 3 (fix round 1, декодовано напряму з Borsh-даних обох tx через `solana confirm -v <sig> -u https://devnet-tee.magicblock.app`, тип `MarketParams` — `programs/dexxer_core/src/state/market.rs`):**

| Поле | До (= `sol_perp_defaults()`) | Форсовано (`234nfZt…`) | Відновлено (`39riRACX…`) | Поточне live (`Market`, читання через `teeConn(crank)` після задачі) |
| --- | --- | --- | --- | --- |
| `imr_bps` | `1000` | `9600` | `1000` | `1000` |
| `mmr_bps` | `500` | `9500` | `500` | `500` |
| решта 13 полів (`max_lev_bps`, `open/close/liq_fee_bps`, `oi_cap`, `max_position`, `min_size`, `max_staleness_secs`, `max_conf_bps`, `max_deviation_bps`, `ema_alpha_bps`, `liq_hysteresis_ticks`, `max_stale_ticks`) | незмінні на всіх чотирьох колонках — `set_params` завжди пише повний `MarketParams`, форсована tx передала копію оригіналу з двома зміненими полями, відкат — точну копію оригіналу | | | |

Live-читання (той самий момент, для повноти): `pausedOpen: false`, `mark`/`markSlot` рухаються нормально —
жодних побічних ефектів на самому `Market` після відкату не лишилось.

**Висновок:** `i64::MAX`-планувальник закриває №18 лише частково —
гарантує, що `Market.mark` ніколи не замерзне, якщо Railway впаде, але
**не є ліквідаційним backstop-ом сам по собі**: ліквідації вимагають
crank-ідентичності, яка подає `remaining_accounts`-пари `[Position,
UserAccount]`, а це вміє лише `services/relayer` (або ручний
`crank-fallback`). `crank-fallback`/relayer лишається обов'язковим для
ліквідацій незалежно від того, чи заведено `i64::MAX`-планувальник.

**Баланси:** `devnet-admin` до задачі `0.2507278 SOL` → дозарядка +0.15 SOL
з `payer` → `0.4007278 SOL` → після всіх транзакцій (schedule_crank,
2× set_params) `0.3507228 SOL`. `payer` (`spikes/keys/payer.json`)
`5.221662297 SOL` → `5.071657297 SOL`. Railway `crank`/`fee_payer`
баланси не змінились протягом вимірювання (`crankSol: 0.1`,
`feePayerSol: 0.202817912` до і після).

## Апгрейди програми `dexxer_core` (week 5, 23–24.09.2026)

Program id незмінний `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, upgrade-authority
`spikes/keys/payer.json` (`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`). Три апгрейди за тиждень
(деталі, регресія й виміри — `docs/superpowers/plans/week5-results.md` §Task 4/5 і §фінальна фікс-хвиля).

| # | Підпис | Слот | Причина | Вартість | `extend`? |
| --- | --- | --- | --- | --- | --- |
| 1 | `3hDzZgGzZqZrcqn7w7XDMHcbcbpGwbwVovGCDpUzUMfZnoLYnVNMWFYJ1ptMmjGeUEVW1MmGkV8sjgzPKnKSGhm1` | `503069579` | Tasks 1–3: queue-first close, exit із боргом розкриття, per-position `liquidation_check` + `DelegateUser.payer` | `extend` **0.665850760 SOL** (незворотно) + деплой **0.006338798 SOL** = **0.672189558 SOL** | **так**, `solana program extend … 131072` — `.so` 1 212 664 B > тодішня `Data Length` 1 179 344 B; після — **1 310 416 B** |
| 2 | `rTNNmdXhWapr2ciVewNHwczY4ePY2NZPqLaGRyYoGoRdfyrEs8bDyJfSwvsHZ8Kt9s6vzmi3pXHfzfe9Py21RhG` | — | Прелюдія Task 5: `close_orphan_queue`'s сигнал сирітства (виміряно зламаним у Task 4 — `require!(ua.data_is_empty() \|\| ua.owner != crate::ID, ...)` завжди хибна на devnet-tee) + нова `set_disclosure_delay` | **0.006015 SOL** (лише мережеві збори — рента буфера ≈6.17 SOL повернулася) | **ні** — `.so` 1 213 624 B ≤ вже розширеної довжини 1 310 416 B |
| 3 | `eXAtUAVtzb66Hk5sRkYaLE4afAKXtM2VXUqcNg5qMfLvBee5GSjCJwA3Hjmu39LdvdnzTuUUndp9xUjJ2CemBpg` | `503324217` | Фінальне ревʼю week 5, C1: `commit_aggregate(max_actions: u8)` — бюджет дій на бандл обирає клієнт (clamp `[1, MAX_ACTIONS_PER_COMMIT]`). Плюс M3 (авторизація `liquidation_check`) | **0.006015 SOL** (6.944625579 → 6.938610579; рента буфера ≈6.2 SOL повернулася) | **ні** — `.so` 1 213 904 B ≤ 1 310 416 B |

**Вартість `extend`, для відтворення.** Кожен `solana program deploy`/`upgrade` вимагає **вільних
SOL на payer-і, що дорівнюють ренті буфера** (для апгрейду #1 — 6.16 SOL) у момент виклику; сама
рента повертається одразу після завершення деплою. `extend` — окрема, **незворотна** витрата (рента
за додані байти `Data Length`), робити лише коли новий `.so` фізично більший за поточну виділену
довжину акаунта програми (`solana program show <id>` → `Data Length`). Кран
`api.devnet.solana.com` під час апгрейду #1 був порожній (`rate limit`); `rpc.magicblock.app/devnet`
видавав по 1 SOL із паузами — планувати airdrop-и заздалегідь.

**Верифікація деплою (усі три апгрейди):** `solana program dump <id> - | sha256sum` == sha256
локального `target/deploy/dexxer_core.so`; `cmp target/idl/dexxer_core.json
app/src/idl/dexxer_core.json` — байт-у-байт. (Історичний запис тижня 5. Наступний деплой — нова
програма плану 4 — звіряє `target/idl/dexxer_core.json` з канонічним `idl/dexxer_core.json`; копія
апки `app/src/idl/` до плану 3 лишається старою.)

### `set_disclosure_delay` — операційна нотатка

**[Застаріло з 30.09.2026: інструкції і `Config.disclosure_delay_slots` немає в програмі на слотах, див. spec §2.9.]** Нижче — запис про живу стару програму.

Адмінська інструкція (`AdminConfig`-патерн, як `pause`/`set_scheduler_signer`), додана апгрейдом
#2. Пише `Config.disclosure_delay_slots`, яке раніше писалось **лише** в `init_config` (сеттера не
було — Task 4 знахідка, змінити демо-затримку без цієї інструкції на живому `Config` було
неможливо). `slots = 0` — легальне значення, використане для демо M-H (комміт+розкриття одним
`commit_aggregate`-bundle). Викликається адміном, ER-транзакція.

### `set_params` — операційна нотатка (актуалізовано week 5)

`set_params` пише **всю** структуру `MarketParams` — читайте живий `Market` перед викликом і
накладайте лише потрібні поля (`tests/er/devnet/10-set-params.ts`, `npm run devnet:setparams --
KEY=VALUE`), інакше наївний виклик мовчки поверне `max_conf_bps` на дефолт 50 і зламає торгівлю
(devnet-фід стабільно віддає `conf == 0`, week 2 знахідка). Week 5 підняв `liq_hysteresis_ticks`
цим шляхом: `2 → 3` (два незалежних джерела тіків — `crank_tick` і новий `liquidation_check` —
без цього подвійний рахунок гістерезису), сигнатура
`4BbcAZdAXtdpTXK6saX9sktZYHRMaxa2RZ4pRzyWreNLRokDFZ6tQZsS8jwDohnWWWf3e8NEsjK9uAk6npti1jsY`. Живі
параметри після week 5 (`Market`, повний знімок):

```
max_lev_bps 100000, imr_bps 1000, mmr_bps 500, open/close_fee_bps 6/6, liq_fee_bps 100,
oi_cap 0, max_position 100000000000, min_size 10000000, max_staleness_secs 2, max_conf_bps 0,
max_deviation_bps 200, ema_alpha_bps 3000, liq_hysteresis_ticks 3, max_stale_ticks 30
```

### Legacy `UserAccount` (тижні 1–2) — стан на кінець week 5

**[Застаріло з 30.09.2026: чистий старт devnet з новим keypair програми, міграції старих акаунтів немає, див. spec §2.9.5.]** Нижче — запис про живу стару програму.

Інвентаризація ДО апгрейду #1 (`getProgramAccounts` crank-токеном): 24 `UserAccount`/`Position`/
`DisclosureQueue`-трійки; 16 на 150 B (пізній week-2/3 лейаут), 4 на 118 B (без `exit_salt`), 4 на
110 B (ще й без `last_withdraw_slot`) — **8 з 24 нечитабельні жодною типізованою інструкцією вже
до тижня 5**. `UserAccount` v2 (week 5, +`exited`, 151 B) робить нечитабельними всі 24 старих
розміри — тільки нові акаунти читаються після апгрейду. Task 4 закрив 2 із 6 `Open`-позицій на
**старій** програмі до апгрейду (ще на v1-лейауті); 4 лишились назавжди: недекодовний
`UserAccount`, для однієї з чотирьох ключа в репозиторії немає. Постійне зміщення на `Market`:
`oi_long = 448 252 365`, `PoolLive.locked_total = 80 000 000`.

## Devnet-скрипти — індекс (`tests/er/devnet/`)

Таблиця нижче — станом на останній деплой (тиждень 5); зміни гілки `positions-slots` — абзац після неї.

Перебудовано з `ls tests/er/devnet/` + `tests/er/package.json`'s `devnet:*` скриптів (fix round 1
Task 8 — попередня версія цієї таблиці мала неправильну назву файлу `06` і хибно писала, що `07`
не існує; обидва виправлено). Нумерація наскрізна для гілки, вбудована у самі назви файлів, не
week-межі: `00`–`04` — тиждень 2 (Task 5, приватний онбординг/leak-test/commit/withdraw), `05` —
тиждень 2 (Task 6, ліквідація), `06`–`08` — тиждень 3 (Task 8, M-B/M-E/M-A), `09` — тиждень 4
(Task 3, M-F), `10`–`15` — тиждень 5 (`10`–`12` — операційні/міграційні скрипти Task 4/5, `13`–`15`
— виміри Task 7 брифу `week5-reliability.md`).

| # | Файл | `npm run` | Що робить |
| --- | --- | --- | --- |
| 00 | `00-measure.ts` | `devnet:measure` | Bootstrap-обгортка: виставляє `process.env.*` під профіль `devnet` до динамічного `await import("./run.js")` (інакше `.env`'s localhost-адреси мовчки перемагають, CLAUDE.md); сама логіка виміру — в `run.ts` |
| — | `run.ts` | (немає власного `npm run` — імпортується з `00-measure.ts`) | Тіло виміру, яке `00` імпортує: тиждень-2 Task 1, вимірювання M1–M4 |
| 01 | `01-onboard-private.ts` | `devnet:onboard` | Тиждень 2, Task 5, скрипт 1/4: повна приватна послідовність онбордингу на реальному devnet + `devnet-tee.magicblock.app`, на `dexxer_core` |
| 02 | `02-leak-test.ts` | `devnet:leak` | Тиждень 2, Task 5, скрипт 2/4: level-4 leak test spec §6.4 (запускається одразу після `01`, читає його `.keys/devnet-run-latest.json`) |
| 03 | `03-commit-cycle.ts` | `devnet:commit` | Тиждень 2, Task 5, скрипт 3/4: `commit_aggregate` ×12, ≥5 с між викликами, підписано `Config.fee_payer` через TEE-з'єднання — доводить, що fee-vault-scoped шлях перетинає M3's ліміт 10 простих комітів |
| 04 | `04-withdraw.ts` | `devnet:withdraw` | Тиждень 2, Task 5, скрипт 4/4: `withdraw(300e6)` на ER, потім клієнтський L1-леґ — `undelegateIx` → поллінг base ATA |
| — | `w3-measure.ts` | `devnet:w3measure` | Тиждень 3, Task 1: оркестратор для M-A/M-C/M-D — сама логіка живе в spike-директоріях (`spikes/01-private-counter-tee/w3-ma.ts`, `spikes/06-magic-action/w3-mc.ts`, `spikes/05-crank-tee/w3-md.ts`), цей файл лише шеллить `npx tsx` з `spikes/` |
| 05 | `05-crank-liquidation.ts` | `devnet:liquidation` | Тиждень 2, Task 6, перевірка (c): наскрізна ліквідація через `crank-fallback`-скрипт на devnet-tee — фреш-трейдер, ~10x лонг, `set_params(mmr_bps)` робить позицію ліквідовною, поллінг `Position.liq_ticks`/`state`. Тиждень 5: те саме, як регресія 05 |
| 07 | `07-balances-root.ts` | `devnet:root` | Тиждень 3, Task 8, скрипт 2/3 (**M-E**): цикл `BalancesRoot` + раунд-тріп коміту на реальному devnet, плюс 12x-вимір вартості `commit_aggregate` тепер, коли кожен комміт несе ДВА акаунти (`Pool` і `BalancesRoot`) |
| 08 | `08-undelegate.ts` | `devnet:undelegate` | Тиждень 3, Task 8, скрипт 3/3 (**M-A** на `dexxer_core`): повний вихід трейдера з `06` — закрити другу позицію, спорожнити чергу розкриття, вивести маржу, `undelegate_user`, поллінг бази до скрабу всіх трьох PDA |
| 09 | `09-pool-snapshot.ts` | `devnet:snapshot` | Тиждень 4, Task 3 (**M-F**): приватний робочий агрегат (`PoolLive`) проти публічного огрубленого знімка (`Pool`) наскрізно на реальному devnet, після міграції `PoolLive` |
| 10 | `10-set-params.ts` | `devnet:setparams -- KEY=VALUE` | Тиждень 5, Task 4 (міграція): патчить окремі поля `MarketParams` на делегованому `Market`, не чіпаючи решту (наївний виклик з `MARKET_DEFAULTS` мовчки скинув би `max_conf_bps` на 50 і зламав торгівлю) |
| 11 | `11-liq-task-migration.ts` | `devnet:liqtask` | Тиждень 5, Task 4, виміри (a)/(b)/(c): cancel невідомого `task_id`, реєстрація `liquidation_check` в `open_position` (`task_context == position`, дубльований ключ), вихід із боргом розкриття (рантайм-вимір `close_orphan_queue`) |
| — | `add-market.ts` | `devnet:add-market -- SYM [--schedule]` | Мульти-маркет (spec §2.8.1/§2.9): L1 `init_market(symbol)` + `delegate_market` → поповнення ренти permission → ER `init_market_permissions` → за `--schedule` — `schedule_crank` з власним `task_id` ринку (mark-only). Кожен крок пропускається, якщо вже зроблений |
| 13 | `13-liquidation-check.ts` | `devnet:liqcheck` | Тиждень 5, Task 7 (**M-G′**): ліквідація БЕЗ relayer-а, лише планувальник у TEE (`CRANK_ENABLED=false`, `liquidation_check` тіка́є незалежно від `crank_tick` relayer-а) |

**Стан на 01.10.2026 (гілка `positions-slots`):** скрипти `06` (commitment-reveal), `12`
(close-orphan), `14` (close-reopen), `15` (exit-debt) видалено разом з розкриттям; `08-undelegate`
переписано під запуск `01` (його run-файл), перевірка відомого трейдера в `07` залежить від того,
що `07` іде до `08`; `add-market` додано. Жоден скрипт на цій гілці не запускався проти мережі —
`08-undelegate` і виявлення ліквідації в `05`/`13` потребують повторного погляду перед devnet
(план 4). Хелпер `setDisclosureDelay` у `tests/er/lib/admin.ts` прибрано.
