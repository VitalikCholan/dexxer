# Тиждень 6 — результати плану 4 позицій-слотів (деплой на devnet, relayer, APK, виміри) і графіка C.5 (02.10)

Чистий старт програми на позиціях-слотах на devnet, relayer на ній, dev-client APK і smoke з
гаманцем. Гілка `positions-slots`, план — `docs/superpowers/plans/2026-10-01-week6-slots-deploy.md`,
дизайн — spec §2.9 (§2.9.5 «Чистий старт, виміри, тести»). Формат той самий, що й у
`week5-results.md`: виміряний підсумок для контролера й спеки, не заміна власних task-звітів
(`.superpowers/sdd/2026-10-01-week6-slots-deploy/task-N-report.md`, не в git; там і повні
сигнатури, скорочені тут до перших 8 символів). **Розділ «Графік C.5, частина 2» (02.10.2026)** — виміри
наступного плану на тій самій живій програмі: 16 таймфреймів, свічки в Postgres, бекфіл Hyperliquid, smoke апки
(гілка `chart-timeframes`, PR #12, план `docs/superpowers/plans/2026-10-01-week6-chart-timeframes.md`).
**Розділ «Умовні ордери» (04.10.2026)** — ревʼю PR #13 колеги, перероблене злиття (PR #14) і два фікси блокерів;
лише локальні тести, на devnet не міряно. **Розділ «Token information» (04.10.2026)** — ревʼю PR #15 колеги.
Обидва PR змерджено в `main` 04.10 (`c459847`, `2bfe24a`). **Розділ «Деплой на devnet і smoke, 04.10.2026»** — апгрейд
програми на той самий id, редеплой relayer-а, перший smoke на AVD: `OrdersUnsupported` на легасі-акаунті і Token info
підтверджено на живій мережі; новий гаманець з Limit-ордером — відкладено.

## Підсумок плану 4

**Статус задач (01.10.2026, кінець дня).** План виконано повністю, крім двох пунктів smoke, які
власник відклав, і одного незворотного рішення власника.

| Задача | Статус | Доказ |
|---|---|---|
| 1 Гейт фіду (`posted_slot` на кожному принті) | ✅ виконано | `FEED-PRINTS PASS`, 5 ринків |
| 2 Нова програма: keypair, `declare_id!`, IDL, деплой | ✅ виконано | `Fyg2…UfCY`, слот 506295949, байти звірено |
| 3 Бутстрап devnet: Config, пул, 5 ринків, 5 кранків, `FeeEscrow` | ✅ виконано | бутстрап з першої спроби, `MARKS PASS` |
| 4 Relayer на Railway: код, env, БД, деплой, політика | ✅ виконано | `8b33d95d` → `5a070a7c`, `/healthz` ok, `ALWAYS`/180 с застосовано |
| 5 Сценарії й виміри (01, 02, 03, 05, 07, 08, 11, 13, 16) | ✅ виконано | усі PASS, CU/вартість/ліквідації виміряно |
| 6 APK і smoke з гаманцем | ◐ частково | кроки 1–7 PASS, два дефекти виправлено; **кроки 8–9 не виконано** |
| 7 Документи | ✅ виконано | цей файл, spec §2.9, CLAUDE.md, deployments, runbook §6, README |
| Закриття старої програми `G2ok…` | ⏳ рішення власника | незворотне, не виконувалось |

Коміти `d6a33e9..44b41bb` (14 комітів після коміту плану `d6a33e9`):

| Коміт | Що |
|---|---|
| `b1a1bb8` | `tests/er/devnet/14-feed-prints.ts` — гейт `posted_slot` на кожному принті (Task 1) |
| `60243f3` | новий program id `Fyg2…UfCY`, `declare_id!`, IDL, `tests/er/lib/program.ts` дефолт IDL → `idl/` (Task 2) |
| `c049e93` | бутстрап devnet, `tests/er/devnet/15-marks.ts`, `docs/deployments.md` (Task 3) |
| `6e1492f` | relayer: `bytes=` у рядку тіку, `railway.json` → `restartPolicyType: ALWAYS` (Task 4) |
| `44b8e88` | docs relayer-а; запис про блок на Railway trial (Task 4) |
| `dbeccde` | `tests/er/devnet/16-multi-market.ts`, `10-set-params.ts --market` (Task 5, частина 1) |
| `253e8f2` | фікс-раунд 16: відновлення параметрів BTC, строгий пробник relayer-а, `--cu-reader` (Task 5) |
| `39d0ed5` | деплой relayer-а на нову програму — факти в `docs/deployments.md` (Task 4) |
| `a756062` | docs: `railway.json` у репо ≠ застосована політика Railway; час до першого тіку (Task 4, фікс-раунд) |
| `c0d39db` | fix(app): символи ринків декодуються побайтово — дефект #1 smoke (Task 6) |
| `b276769` | fix(app): повзунок плеча й MAX обмежені `max_lev_bps` ринку — дефект #2 smoke (Task 6) |
| `018cc7f` | docs: цей файл, spec §2.9 «Виміряно», CLAUDE.md, deployments, runbook §6, README (Task 6 docs + Task 7) |
| `f83e3e1` | docs: кваліфікатори доказів smoke, атрибуція вимірів (фікс-раунд ревʼю документів) |
| `44b41bb` | docs: політика `ALWAYS`/180 с застосована на Railway напряму; config-as-code застарів |

**Що тепер живе на devnet (01.10.2026).** Програма `Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY`
(слот `506295949`), Config/пул/`FeeEscrow`/`BalancesRoot`, п'ять ринків (SOL, BTC, ETH, HYPE, ZEC) з
п'ятьма запланованими `crank_tick` (`i64::MAX`, 1000 мс), relayer на Railway (деплоймент `8b33d95d`, з ≈21:30 за Києвом — `5a070a7c` з політикою `ALWAYS`/180 с,
`COMMIT_INTERVAL_MS=300000`), dev-client APK на нову програму. Стару програму `G2ok…` **не закрито**
(незворотне рішення власника, відкрите).

**Тести на кінець плану 4.** App **140** (план 3 — 137; `c0d39db` +1 → 138, `b276769` +2 → 140),
relayer **244** (237 пройдено + 7 Postgres skipped), unit `dexxer_core` **69**, LiteSVM **89** —
relayer/unit/LiteSVM із прогону Task 2 (Node 24.18.0, `+nightly-2026-09-18`), app — після фіксів
Task 6. Postgres-тести (`indexerDb.test.ts`) не запускались: на машині немає Docker.

**Ключові виміри (деталі — у розділах задач).**

| Що | Значення | Звідки |
|---|---|---|
| `posted_slot` реального Pyth Lazer | змінюється на **кожному** принті: 5 ринків × 47 принтів / 90 с, повторів 0, інтервал 1.7–2.5 с | Task 1 |
| Ліквідація лише планувальником (`liquidation_check`, relayer-crank вимкнено) | **8.5–10.2 с** (13: 9.0 с SOL; 16: BTC 8.9 / 8.7 / 8.5 / 10.2 с у чотирьох прогонах) | Task 5 |
| Ліквідація relayer-ом (`crank_tick`) | **2.9 с** після `set_params` (05) | Task 5 |
| `crank_tick` relayer-а, без кандидатів | `cu` 15 523…15 540, 383 B | Task 4 |
| `crank_tick` з 1 / 2 кандидатами | `cu` 21 428…21 445, 449 B / `cu` 28 820…30 088, 515 B (формула `383 + 66·n` підтверджена) | Task 4, 5 |
| Перший тік SOL після старту контейнера | **6.7 с** | Task 4 |
| Повна петля relayer-а по 5 ринках | ≈3.3 с (тіки ринків послідовні, ≈0.55 с кожен) | Task 4 |
| `commit_aggregate()` | **48 376 CU**, **200 000 лам.** з `FeeEscrow` у magic fee vault на коміт | Task 5 (07) |
| Janitor: exit → акаунти закрито | ≈50 с (50.8 с у 16, ≈50 с у 08) при `COMMIT_INTERVAL_MS=60000` | Task 5 |
| Рента на devnet | `Positions` **16 832 224** лам., `UserAccount` **1 709 064** (LiteSVM-формула дає 23 051 520 / 2 331 600) | Task 5 |
| Онбординг з апки (спонсорований, nonce + 2 CB) | L1 795 / 812 / 765 B, ER-лег 506 B | Task 6 |

## Task 1: перший гейт — `posted_slot` реального фіду

### M-слоти-гейт: `14-feed-prints.ts` — PASS

`cd tests/er && npm run devnet:feedprints`, 01.10.2026 13:44:31–13:46:02 UTC, 90 с, опитування
кожні 250 мс, читання фіду без токена на devnet-tee.

| Символ | Принтів | Різних `posted_slot` | Повторів | Мін. інтервал, мс | Макс. інтервал, мс |
|---|---|---|---|---|---|
| SOL | 47 | 47 | 0 | 1707 | 2496 |
| BTC | 47 | 47 | 0 | 1700 | 2422 |
| ETH | 47 | 47 | 0 | 1699 | 2412 |
| HYPE | 47 | 47 | 0 | 1699 | 2447 |
| ZEC | 47 | 47 | 0 | 1697 | 2450 |

`FEED-PRINTS PASS`. Інтервали понад 2 с — звичайна каденція фіду, не збої. Отже механізм #38
(`sample_seq` росте лише на новому `posted_slot`) на реальному фіді дає семпл на кожному принті.

**Не виконано:** прогін `bootstrap()` на mb-stack (Step 3): бінарника `mb-stack` на машині немає.
Першим справжнім прогоном порядку пулу C1 став devnet-бутстрап у Task 3.

**Знахідка.** Дефолтний `DEXXER_IDL_DIR` у `tests/er/lib/program.ts` (`target/idl`) застарів, і на
`Positions` `program.ts` падав. Рулінг: дефолт — канонічний `<repo>/idl`, змінено в Task 2 (`60243f3`).

### Відкрите після Task 1

- Вибірка — 90 с. Довгострокову стабільність каденції фіду не вимірювали.

## Task 2: нова ідентичність програми, збірка, IDL, деплой

| Що | Значення |
|---|---|
| Вічний кранк SOL старої програми | скасовано `cancel_crank`, `task_id -8632762600545312817`, sig `55pfC2ES…cQmi`. Що задача справді жила, підтвердження tx не доводить (cancel невідомого id — no-op), але id збігається з документованим |
| Новий program id | `Fyg2yJBoN97ScWxT37xBp2zaaiNncNqnGJ7PAbtnUfCY`; старий keypair → `keys/programs/dexxer_core-keypair.G2ok.json` (gitignored) |
| `program_autofixer` на `lib.rs` | 0 зауважень |
| `.so` | 1 107 440 B, sha256 `ebeed3b1…440692f`; новий id у `.so` 1 раз, старий 0 |
| `idl/dexxer_core.json` | новий id ×7, старий ×0, 40 інструкцій. Дифф 247 рядків, бо 8 PDA-сідів містять program id константою |
| Тести | relayer 244 (237 + 7 skipped), app 137, unit 69, LiteSVM 89, `tsc` `tests/er` чисто |
| Деплой | sig `4PQfpkUg…RUWM`, слот **506295949**, ProgramData `6AVVm2ZM…hok1Q` (5.62667404 SOL ренти), authority `4P1WD9…MGMM`, Data Length 1 107 440 B |
| Звірка байтів | `solana program dump` у файл + `cmp` з `target/deploy/dexxer_core.so` — **ідентичні**. `-` CLI сприймає як ім'я файлу, а не stdout: `dump <id> - \| sha256sum` хешує порожній вивід |
| payer `4P1WD9` | 6.938610579 → 1.305608419 SOL (≈5.633 SOL) |

**Деплой запустив власник**, через `!` у сесії. Класифікатор дозволів auto-mode заблокував
`solana program deploy` («Production Deploy») і для виконавця, і для контролера. Обходити блок не
пробували.

### Відкрите після Task 2

- Задачі `liquidation_check` позицій старої програми скасувати нічим. Вони тікатимуть, доки живе
  старий `FeeEscrow`; це аргумент за `solana program close G2ok…` (рішення власника).

## Task 3: бутстрап devnet — Config, пул, ринки, кранки, `FeeEscrow`

### Бутстрап — PASS з першої спроби

`npm run devnet:bootstrap`: порядок `init_pool → init_pool_live → seed_pool → delegate_pool_live →
delegate_pool` пройшов без Anchor 3007. **Порядок C1 фінального ревʼю плану 2 підтверджено на
живій мережі.** Мінт dUSDC — новий `UU1BFV3G…mvHR6` (старий ключ перейменовано на
`devnet-mint.G2ok.json`). Сигнатури (скорочено): `init_config` `5h6iYWRf…`, `seed_pool` `4FGxB3JB…`,
`delegate_pool` `ZVELyUCn…`, `init_market_permissions` `5taHtfBH…` (`marketRisk`/`poolLive`
permissioned = true), `fund-fee-payer` `eCigiqHW…` (0.2 SOL у `FeeEscrow`, баланс в ER 200 701 040).
Адреси всіх PDA — `docs/deployments.md` «Program / PDA».

### Ринки й кранки

| Символ | Lazer feed id | `task_id` кранка | `schedule_crank` |
|---|---|---|---|
| SOL | 6 | `6355626329445645097` (`schedule-eternal.ts`) | `4ubUU8pu…` |
| BTC | 1 | `9088409262532617907` | `2cYKSjap…` |
| ETH | 2 | `-5077243792603821260` | `aWR6QB3g…` |
| HYPE | 110 | `-4085983205633519634` | `pmJFJncd…` |
| ZEC | 66 | `-3261127409136503701` | `44WDyGgQ…` |

Кранків **п'ять**, а не шість, як писав бриф: не-SOL ринків чотири. `SCHEDULE-ETERNAL PASS`: 11
семплів `Market.mark_slot` за 60 с, 11 різних слотів. `Config.scheduler_signer` вже дорівнював
`crank_signer_pda(admin)`, тож `set_scheduler_signer` не знадобився.

### M-слоти-MARKS: `15-marks.ts` — PASS

60 с, одне читання всіх п'яти `Market` на секунду (14:11:40–14:12:40 UTC):

| Символ | Тіків (`mark_slot`) | Змін `last_print` | Приріст `sample_seq` |
|---|---|---|---|
| SOL | 59 | 59 | 59 |
| BTC | 58 | 58 | 58 |
| ETH | 59 | 59 | 59 |
| HYPE | 59 | 59 | 59 |
| ZEC | 58 | 58 | 58 |

Кілька запланованих `crank_tick` з одним `taskContext = admin` співіснують і тікають одночасно ≈1/с.
Гейт плану 2 закрито. `sample_seq_delta == ticks` на кожному ринку, тобто кожен тік прийняв новий
принт.

| Баланс admin `8L4E…` | SOL |
|---|---|
| до (після поповнення власником +0.7, `3RWYHfHk…`) | 1.5006478 |
| після бутстрапу | 1.4424852 |
| після `fund-fee-payer` | 1.2421802 |
| після 4 ринків + SOL-кранка | 1.1937320 |

Разом ≈0.3069 SOL (бутстрап 0.0582, `FeeEscrow` 0.2003, ринки й кранк 0.0484). `fee_payer` (після
поповнення власником +0.5, `4sicKSf3…`) — 0.504802688 SOL, на бутстрапі не витрачався.

### Відкрите після Task 3

- Скасувати запланований `crank_tick` не-SOL ринку досі нічим (`cancel-crank.ts` знає лише SOL).

## Task 4: relayer на новій програмі

**Блок і розблокування.** Пробна підписка Railway закінчилась: усі деплойменти relayer-а REMOVED з
25.09, Postgres — з 22.09. Живого relayer-а не було з 25.09. `railway redeploy --service Postgres
--from-source` повернув `Your trial has expired`. Власник оплатив план; Postgres повернуто
`railway redeploy --service Postgres --from-source -y` (деплойменти `7b896600`, `788c3daa` SUCCESS
16:38–16:39 UTC; образ `postgres-ssl:18` за тегом, том той самий).

| Що | Значення |
|---|---|
| Env до | `COMMIT_INTERVAL_TICKS=60`, `COMMIT_MAX_ACTIONS=4`, без `SIWS_DOMAIN`, без `COMMIT_INTERVAL_MS` |
| Env після | `COMMIT_INTERVAL_MS=60000` (на час вимірів; потім **300000**, див. нижче), `SIWS_DOMAIN=relayer-production-1ae7.up.railway.app`; `COMMIT_INTERVAL_TICKS`/`COMMIT_MAX_ACTIONS` видалено; `QUARANTINE_CYCLES` не був виставлений |
| БД, варіант A (рішення власника), 16:40:48 UTC | `TRUNCATE pool_snapshots, roots; DELETE FROM relayer_meta`: 927 → 0, 908 → 0, 2 → 0; `ticks` 654 676 лишено |
| Деплой | `railway up --service relayer --ci` з дерева `253e8f2` → деплоймент **`8b33d95d`** SUCCESS; міграції 006/007/008 застосовано (008 ≈0.6 с на 654 676 рядках) |
| Перший тік SOL | **6.7 с** після старту контейнера (16:41:59.6 → 16:42:06.3 UTC) |
| Перевірки | `/healthz` ok, 5 ринків зі свіжим `lastTickAt`; `/markets` — 5 символів; `/mark?market=BTC` `stale:false`; `/disclosures`, `/stats` → 404; `/pool/latest` — новий пул (capital 11 000, liquidity 9 900, locked 100 dUSDC) |
| Перший коміт-цикл | `root: filled=5`, `commit_aggregate` (успіх не логується, видно з `lastCommitAt`), janitor `scanned=4 closed=4 errors=0` — закрито чотирьох вийшовших трейдерів нової програми з ранніх прогонів Task 5 |
| Рядки помилок TEE | жодного за ≈3 хв (лише `bigint: Failed to load bindings`) |

**`crank_tick` relayer-а по ринках (перші 34 тіки на ринок):**

| Ринок | `cu` | `bytes` | `tick_ms` | `candidates` |
|---|---|---|---|---|
| SOL | 21 428…21 445 | 449 | 551…936 | 1 |
| BTC | 15 528…15 540 | 383 | 550…943 | 0 |
| ETH | 15 523…15 540 | 383 | 550…561 | 0 |
| HYPE | 15 523…15 540 | 383 | 551…561 | 0 |
| ZEC | 15 523…15 540 | 383 | 550…565 | 0 |

Повна петля ≈3.3 с (27 петель за 89 с). `intervalMs: 1000` — пауза між петлями, а не каденція
ринку.

**Railway ігнорує `services/relayer/railway.json`.** У деплойменті `fileServiceManifest: {}`, а
`serviceManifest` має `restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 10`,
`healthcheckTimeout: 30` (лог `Retry window: 30s`). `ALWAYS` і 180 с з репо не діяли.

**Політику застосовано того ж вечора (контролер, ≈21:30 за Києвом).** Config-as-code
(`railway.json`/`railway.toml`) Railway оголосив застарілим на користь Infrastructure-as-Code
`.railway/railway.ts`: `update-service` з `railwayConfigFile` відхилено саме з цим повідомленням, тож
`services/relayer/railway.json` Railway не застосує ніколи — він лишається документацією намірених
значень. Значення виставлено напряму в налаштуваннях сервісу (Railway MCP `update-service`):
`restartPolicyType = ALWAYS`, `healthcheckTimeout = 180`; `get-service-config` після —
`healthcheckTimeout: 180, restartPolicyType: "ALWAYS"`. MCP `redeploy` (деплоймент `3d1ccce7`) упав на
BUILD_IMAGE (`Railpack failed to prepare the build`): у деплойменту з `railway up` нема джерела-репо для
перезбирання; живий деплоймент не зачеплено. Свіжий `railway up --service relayer --ci` → деплоймент
**`5a070a7c` SUCCESS** (21:30:23 за Києвом), `/healthz` ok, `commitIntervalMs 300000`, 5 ринків. Між
`8b33d95d` і `5a070a7c` живою була `ON_FAILURE` × 10 / 30 с.

**`COMMIT_INTERVAL_MS` повернуто на 300000** (рулінг контролера після Task 5). Коміт коштує 200 000
лам. (M-слоти-B), тож при 60 с `FeeEscrow` спорожнів би за ≈16 год. Перевірено читанням `/healthz`
о 18:04 UTC: `commitIntervalMs: 300000`.

### Відкрите після Task 4

- ~~Config-as-code шлях на Railway~~ — застосовано напряму (`5a070a7c`, див. вище); відкрите — перенести
  налаштування сервісу в `.railway/railway.ts`.
- Успішний `commit_aggregate` не пише рядка логу (лише збій).
- Тіки ринків послідовні; петля росте лінійно з кількістю ринків, `CRANK_WATCHDOG_MS` (120 с) від
  неї не масштабується.
- Postgres-тести не запускались (Docker немає); міграцію 008 перевірено лише логом деплою.

## Task 5: сценарії devnet і виміри (M-слоти)

Прогони у два заходи. Частина 1 (14:40–16:00 UTC) — без relayer-а, Railway ще заблокований.
Частина 2 (16:48–17:16 UTC) — relayer живий, `COMMIT_INTERVAL_MS=60000`. Сирі логи лежать у
scratchpad сесії, не в git.

**CU у TEE видно лише учасникам permission.** Для tx, що пише permissioned-акаунт, `getTransaction`
devnet-tee повертає не-членам заглушку: повідомлення 102 B, `computeUnitsConsumed: 0`, без логів.
Відправник (owner/session) — не член `PoolLive`/`MarketRisk` (`[crank, admin]`), тому бачить
заглушку для власних угод. Токени crank і admin бачать повну мету. Для `credit_deposit`/`withdraw`
мета порожня **для кожного** токена. Ймовірна причина (не перевірено): ці tx пишуть ще й
eSPL-акаунти, permission яких немає ні в crank, ні в admin. CU торгових інструкцій нижче —
перечитування crank-токеном (`--cu-reader crank`).

### M-слоти-A: `01-onboard-private.ts` — PASS (друга спроба)

Перша спроба: L1 `init_user` → `TransactionExpiredTimeoutError`, sig не дійшов до кластера. Anchor
`.rpc()` не повторює загублену tx, і трейдер `FVfD8Xc3…` лишився лише з faucet (0.05 SOL).
Друга спроба: owner `FNnwSCpZ…`, open SOL 1.0 @ 117.62. На базі `UserAccount` 207 B і `Positions`
3184 B під Delegation Program.

| Лег (самофінансований скрипт, без nonce/CB) | Мережа | `bytes` | `cu` |
|---|---|---|---|
| `faucet_init` | L1 | 418 | 23 683…28 183 |
| `init_user` | L1 | 343 | 18 741…23 241 |
| `delegateSpl` | L1 | 590 | 30 436…45 436 |
| `delegate_user` | L1 | 543 | 91 236…100 236 |
| `credit_deposit` | ER | 384 | не вимірюється |
| `init_permissions` | ER | 442 | 29 130…41 130 |
| `set_session` | ER | 486 | 28 210…34 210 |

Діапазони CU — по прогонах 01 і трьох прогонах 16. L1-цифри залежать від bump-ів PDA випадкових
ключів, як і в LiteSVM. Розміри tx тієї ж форми, що відправляє апка (спонсоровані, nonce + 2 CB), —
у Task 6.

### Приватність `Positions`: `02-leak-test.ts` — PASS (6/6)

База: власник — Delegation Program, 3184 B без змін проти знімка. Без токена й чужим токеном —
`null`; session і crank бачать 3184 B; owner бачить відкритий слот SOL #0.

### M-слоти-B: `03-commit-cycle.ts` + `07-balances-root.ts` — PASS

| Що | Значення |
|---|---|
| 03, частина 1: 12 × `commit_aggregate()` | усі 12 приземлились в ER; 11/12 з'явились на базі в межах 60 с. Перший — ≈70 с, тому скрипт зарахував його як FAIL (вікно опитування закоротке) |
| `FeeEscrow` в ER за частину 1 | **0** лам. дельти на всіх 12 комітах і годинах комітів relayer-а |
| 07, частина 2: 12 × коміт | 12/12 OK, **−200 000 лам. на кожному** (`BdfNhXM9…` → magic fee vault `EUJssY6k…`), `fee` tx 0, `fee_payer` 0 |
| CU коміту | **48 376** (мета коміту #1, admin-токен; `ScheduleCommit … ID: 128605`) |
| Каденція списань (опитування раз на 2 с, 16:58–17:11) | −200 000 кожні ≈61 с, через 1–2 с після кожного `root: filled=…` relayer-а |
| `BalancesRoot` | цикл #1 `5bF6o8iB…` filled=3, base `root_slot` == ER `root_slot`; цикл #2 `26mPqVAo…` — 64/64 листки змінено |

Чому частина 1 бачила 0, а частина 2 — 200 000, не перевірено. Найімовірніше, діяла безкоштовна
квота комітів на escrow (тиждень 2 міряв «0 лампортів нижче nonce 25»), і її вичерпано.
**Запас:** 191 301 040 лам. у `FeeEscrow` (читання о 18:04 UTC) / 200 000 ≈ 956 комітів. Це
≈3.3 доби при 300 с (живе значення) і ≈16 год при 60 с.

### M-слоти-C: `05-crank-liquidation.ts` — PASS (relayer)

Owner `FDaVm7vw…`, open SOL 1.0 @ 117.27 ≈9.1× (`CQDF7xED…`), форсування `set_params(mmr 9500,
imr 9600)` (`5PcxGDF1…`). **Ліквідовано за 2.9 с** після `set_params`.

| Рядок тіку relayer-а | `cu` | `bytes` | `candidates` | `liquidated` |
|---|---|---|---|---|
| `n=126 market=SOL` (`liq_ticks` 0 → 1) | 28 820 | 515 | 2 | 0 |
| `n=127 market=SOL`, sig `2FAZtKoE…AoZCh` | 30 088 | 515 | 2 | 1 |

Кандидатів два, а не один: відкритий SOL-слот мав ще трейдер 01. Запис історії `reason: liquidated`;
параметри відновлено (`42fJj9iC…`, `match original: true`).

### M-слоти-D (M-G′): `13-liquidation-check.ts` — PASS (лише планувальник)

`CRANK_ENABLED=false` через railway (`/healthz`: `crankEnabled:false, schedulerActive:true, tick:0`).
Owner `Ar6ZN63m…`, open `3p3XF8RR…`, `set_params` `dQ6qumVB…`. **Ліквідовано за 9.0 с**, хвіст
`liq_ticks [0,1,1]` → закрито. Скрипт сам повернув `CRANK_ENABLED=true`.

**Побічний ефект.** Форсовані параметри SOL зачіпають кожну позицію на спільному ринку, тож власна
задача `liquidation_check` ліквідувала й SOL-слот трейдера 01, призначеного для 08. Це висновок, а
не пряме спостереження: слот був відкритий на `candidates=2` у 05, а тік SOL у 16 о 16:54:52 мав
уже 1 кандидата.

### Реєстрація задач: `11-liq-task-migration.ts` — PASS

Owner `BNi2z3ed…`. `open_position` прийнято з `task_context == positions`, `close_position`
скасовує живу задачу, `undelegate_user` — cancel невідомого id (no-op).
`ExternalAccountDataModified` на zero-copy `Positions` немає — перша точка для M-слоти-F.

### M-слоти-E: `16-multi-market.ts` — PASS (чотири прогони)

Один трейдер, слоти #0 SOL і #1 BTC на одному `Positions`, дві задачі `liquidation_check` з різними
`task_id` (прогін 2: SOL −5426448393446346208, BTC −7784038026803801695). `decrease_position` SOL
наполовину → `history.at(-1).reason = decrease` (2), слот лишається відкритим. Форсована ліквідація
**лише BTC** планувальником: SOL `liq_ticks` 0 на кожному опитуванні.

| Прогін | Owner | Ліквідація BTC | Хвіст `liq_ticks` BTC |
|---|---|---|---|
| частина 1, прогін 1 (`--no-janitor`) | `3syiR7JH…` | 8.9 с | 0→1→1→закрито |
| частина 1, прогін 2 | `B4EBrKKS…` | 8.7 с | 0→1→1→закрито |
| фікс-раунд, `--cu-reader crank` | `BhGw7DNf…` | 8.5 с | 0→1→1→закрито |
| частина 2, з janitor-ом, `RELAYER_TOGGLE=1` | `5HVddUMF…` | 10.2 с | 0→1→1→закрито (`sample_seq` 10113→10120) |

**CU/bytes торгових інструкцій в ER (crank-токен):**

| Інструкція | `cu` | `bytes` |
|---|---|---|
| `open_position` SOL / BTC | 42 887…42 889 / 42 986 | 534 |
| `increase_position` | 29 758…29 759 | 533 |
| `add_margin` | 25 513 | 517 |
| `decrease_position` (½) | 28 307 | 525 |
| `close_position` | 28 635 | 517 |
| `undelegate_user` [SOL, BTC] | 68 140…75 640 | 607 |
| `set_params` | 7 635 | 303 |
| `credit_deposit` | не вимірюється (порожня мета для всіх токенів) | 384 |
| `withdraw` | не вимірюється (порожня мета для всіх токенів) | 549 |
| L1 `create ATA` (idempotent) | 13 417 | 304 |
| L1 `close_exited_user` (janitor) | 9 143 | — |

`open_position` в ER — ≈42.9k проти 27 857 у LiteSVM. Гіпотеза (не розкладали): у реальному ER
дорожчі CPI до планувальника й Permission Program.

**Вихід і janitor (частина 2).** `undelegate_user` [SOL, BTC] `5kfACEuc…`, без
`ExternalAccountDataModified`; на базі `UserAccount` 207 B з `exited=1` і `Positions` 3184 B, обидва
під програмою. Janitor: `16:55:54 janitor: closed 5HVddUMF… rent_payer=5HVddUMF… sig=hPgnyS4d…`,
акаунти зникли через **50.8 с** після перевірки виходу. `UserAccount` 1 709 064 → 0, `Positions`
16 832 224 → 0, `rent_payer` +18 541 288, `fee_payer` −5 000. `init_user` списав з власника рівно
18 546 288 (рента + 5 000 комісії), тобто **рента повертається повністю**.

### M-слоти-F: `08-undelegate.ts` — PASS

Трейдер 01 `FNnwSCpZ…`; SOL-слот уже закрито (ліквідовано під час 13), тож close не відправлявся.
`withdraw` 998 222 345 (`5aLh2YDa…`), `undelegate_user` `61opTZjV…` (ринки: SOL): **без
`ExternalAccountDataModified`**, власник на базі змінився за 4.4 с. Скраб перевірено:
`session_key`/`exit_salt`/`last_withdraw_slot` нульові, байти `Positions` [40, 3112) нульові.
Janitor `2w3FL4av…` о 17:15:17, ≈50 с після виходу; рента +18 541 288 власнику. Гейт автоматичного
`exit()` zero-copy `Positions` закрито (також 11 і 16).

### Додаткові виміри

| Що | Значення |
|---|---|
| 10 хв простою після виходу 16 (16:55:17 → 17:05:05) | `FeeEscrow` −1 800 000 = 9 комітів × 200 000. Інших дельт немає: плати за дві задачі над вийшовшим акаунтом при роздільності 2 с / 1 лам. **не видно** |
| Найбільше `candidates=` за весь прогін | 2. `crank_tick` з 12 парами не виміряно (трейдерів замало) |
| Лог relayer-а за 40 хв | без reconnect, watchdog і рядків помилок TEE (`Invalid token`, 503); 3 × `Starting Container` — усі від перемикань `CRANK_ENABLED` (13 і 16) |
| `/healthz` о 17:16 UTC | `ok:true, crankEnabled:true, tick:409`, `tickAge` усіх 5 ринків 1.5 с, `feePayerSol 0.50477`, `crankSol 0.1` |
| Чистий стан після прогонів | SOL mmr 500 / imr 1000 / гістерезис 2 / staleness 2; BTC mmr 500 / imr 1000 / min_size 20 000 / staleness 15 (звірено); трейдери 16 і 01 вийшли й закриті; 05 `FDaVm7vw…` і 13 `Ar6ZN63m…` — без позицій, маржа в ER, не вийшли |

### Баланси Task 5 (лампорти)

| Момент | admin L1 | `fee_payer` L1 | `FeeEscrow` ER | `FeeEscrow` base |
|---|---|---|---|---|
| початок частини 1 (14:40Z) | 1 193 732 040 | 504 802 688 | 200 701 040 | 701 040 |
| кінець частини 1 (після фікс-раунду) | 843 697 040 | 504 802 688 | 200 701 040 | 701 040 |
| початок частини 2 (16:48Z) | 843 697 040 | 504 782 688 | 200 701 040 | 701 040 |
| кінець частини 2 (17:16Z) | 693 682 040 | 504 772 688 | 193 901 040 | 701 040 |

Admin −0.50 SOL: десять свіжих трейдерів по 0.05 SOL (01 ×2, 11, чотири PASS-прогони 16, одна
спроба 16, що впала на гонці створення ATA, 05, 13). `fee_payer` −30 000: шість janitor-закриттів по
5 000 (4 на першому циклі деплою, 2 у частині 2).

### Відкрите після Task 5

- Покинуті devnet-ідентичності: `FVfD8Xc3…` (лише faucet) і `GXQ83pzK…` (гонка ATA), по 0.05 SOL.
- `.rpc()` на L1 без повтору загубленої tx — у 01/05/11 (у 16 є повтор).
- Вікно опитування бази в 03 (60 с) коротше за затримку першого коміту (≈70 с).
- Гілку збою/повтору відновлення параметрів у 16 не перевірено (fault injection на devnet не робили).
- `crank_tick` з 12 парами; стійкість задач до рестарту TEE; CU `credit_deposit`/`withdraw` в ER.

## Task 6: APK на нову програму і smoke з гаманцем

| Що | Значення |
|---|---|
| Збірка | `npm run android -- --no-bundler`, інкрементальна, `BUILD SUCCESSFUL in 55s` |
| APK | `app/android/app/build/outputs/apk/debug/app-debug.apk`, 110 870 032 B, sha256 `4178ed2223f56777a6766f8cdf60a558eb35d3cc7890a98840fd4c464137e531` |
| Сертифікат підпису (SHA-256) | `FA:C6:17:45:DC:09:…:03:3B:9C` — **збігається** з дефолтом relayer-а (`services/relayer/src/assetlinks.ts`) і з живим `/.well-known/assetlinks.json` |
| Бандл Metro | новий program id ×7, старий ×0 |
| Середовище | AVD `local_phone` (fakewallet), проксі `scripts/emu-proxy.cjs`, Metro `--dev-client` |
| Owner (fakewallet) | `2TQerBRHvjxR3hGbSqGaSKZWBhbiB7mRfEWCeVeEFgWi` |

Smoke вів власник; агент на кнопки в гаманці не натискав. Кроки 1–7 — PASS за повідомленням
власника, сигнатури L1 перевірено публічним RPC. Повна таблиця — `docs/emulator-runbook.md` §6.

| Крок | Результат |
|---|---|
| 1 Онбординг на двох акаунтах | PASS. `selfFund: owner has 0 lamports → sponsored`; леги `faucet+init_user` 795 B, `delegate_spl` 812 B, `delegate_user` 765 B (усі `+advance+2 CB`, `feePayer` = `fee_payer`), ER `permissions+session` 506 B (`feePayer` = owner). На L1 три tx о 20:35:10–12 за Києвом, тобто 17:35 UTC (`NtRjGqL7…`, `3cCf6rVL…`, `36BWmyeX…`), потім депозит `2YRYNrwZ…` о 20:35:26 через durable nonce `8HijrvhF…` |
| 2 Вибір ринку і збереження | PASS |
| 3 Open на SOL і BTC | PASS після фіксу дефекту #1 |
| 4 Список позицій | PASS |
| 5 Часткове зменшення → `Partial close` | PASS |
| 6 Close → `Closed` | PASS |
| 7 Архів History після перезапуску | PASS |
| 8 Exit із двома ринками | **не виконано** (власник відклав) |
| 9 Повторний онбординг після janitor-а | **не виконано** (власник відклав) |

**Дефект #1 (виправлено `c0d39db`).** Open мовчки нічого не робив на жодному ринку. Причина: у
Hermes `Buffer.subarray().toString()` повертає `"83,79,76,0,0,0,0,0"` замість `"SOL"`. Тому
`decodeMarket.symbol` ніколи не дорівнював обраному символу, ринок/акаунти лишались `null`, і
`handleOpen` тихо виходив. Знайдено тимчасовим DEBUG-логом (відкочено, не закомічено). Фікс декодує
байти вручну (`pdas.ts`, `codecs.ts`), регресійний тест на звичайному `Uint8Array`. Застосовано
перезавантаженням JS о 20:46; кроки 3–7 пройшли вже на цьому бандлі, бо до фіксу Open не працював.
Нової збірки APK після фіксу не було.

**Дефект #2 (виправлено `b276769`).** HYPE, Open Short 7× → тост `insufficient margin (6010)`.
`LeverageSlider` мав зашиті 1–10×, а `max_lev_bps` ринку ігнорував (у HYPE/ZEC — 5×; до плану 3 усі
ринки мали 10×). Програма поводилась коректно. Фікс: `MarketParams.maxLeverage`, `max` повзунка, клемп
під час рендеру, `impliedLeverage(ntl, free, maxLev)`, `clampLeverage` + тести. JS перезавантажено о
20:58; **на пристрої повторно не перевірено**.

### Відкрите після Task 6

- Кроки 8 (Exit з двома ринками) і 9 (`Exited` → janitor → повторний онбординг) з апки.
- Обидва фікси — без повторного smoke на свіжій збірці APK.
- ER-дії апки (open/decrease/close/add margin/exit) не пишуть сигнатуру в logcat, а збої в
  Trade/Positions видно лише тостом. Доказ кроків 3–6 — скриншоти, а `remaining_accounts` Exit з
  логів не перевірити.
- Phantom (`phantom_phone`) на новій програмі не проганявся.

## Task 7: документи — виконано

Коміти `018cc7f`, `f83e3e1`, `44b41bb`. Цей файл; spec §2.9 «Виміряно (devnet, 01.10.2026)» з
вказівниками на закриті пункти «Не виміряно»/«Відкрите для плану 4»; `CLAUDE.md` — розділ «Правила
тижня 6: позиції-слоти, devnet-виміри (01.10.2026)», рядок у «Документи» і маркери
`[Застаріло з 01.10.2026: …]` на твердженнях, що стали хибними; `docs/deployments.md` (кінцевий стан,
APK, env, політика Railway); `docs/emulator-runbook.md` §6 (таблиця smoke з доказами);
`README.md` (статус і ендпоінти). Ревʼю документів: жодного вигаданого числа; після фікс-раунду кроки
2–7 smoke підписано «за повідомленням власника», виміри — із зазначенням, чиїм токеном читались.
PR #11 оновлено на «plans 1–4 of 4».

Фінального ревʼю всієї гілки не проводилось (рішення власника ще на плані 3) — лише per-task.

## Вартість devnet

| Гаманець | До | Після | Дельта | Що |
|---|---|---|---|---|
| payer `4P1WD9…MGMM` | 6.938610579 | 1.305608419 → +6 (власник, `38NYtGvW…`) → **7.305608419** (18:04 UTC) | −5.633002160 | деплой; з цього 5.62667404 — рента ProgramData нової програми |
| admin `8L4E…kVtH` | 0.80 → +0.7 (власник) = 1.5006478 | **0.693682040** (18:04 UTC) | −0.806965760 | бутстрап і ринки 0.3069 (з них 0.2003 у `FeeEscrow`), 10 трейдерів по 0.05 |
| `fee_payer` `3HgD…3Chnt` | 0.0048 → +0.5 (власник) = 0.504802688 | **0.475688640** (18:04 UTC) | −0.029114048 | 6 janitor-закриттів по 5 000 лам.; решта — після 17:16 UTC, найімовірніше спонсорований онбординг і депозит smoke (рента двох акаунтів, nonce-акаунти). Розбивку не робили |
| `FeeEscrow` ER `BdfN…w8vs` | 200 701 040 лам. | **191 301 040** (18:04 UTC) | −9 400 000 | розрахунок: 9 400 000 / 200 000 = 47 комітів (покрокові дельти спостерігали лише до 17:11 UTC) |
| crank `2w7X…ZerFA` | 0.1 | 0.1 | 0 | — |

Поповнення від власника за план: payer +6, admin +0.7, `fee_payer` +0.5 SOL. **Витрачено**
(без ренти програми, яку повертає лише `program close`) ≈0.65 SOL: admin ≈0.62 (0.807 мінус ≈0.19, що ще
лежать у `FeeEscrow`; у т.ч. 0.0094 списань `FeeEscrow` за коміти і ≈0.5 трейдерам — рента частини з них
повернулась самим трейдерам), `fee_payer` ≈0.03, комісія деплою ≈0.006. Ще ≈0.191 SOL — передоплата комітів у
`FeeEscrow`, не витрачена. Рента старої програми `G2ok…`
(≈4.6 SOL за оцінкою плану) замкнена, доки її не закрито.

## Відкрите після плану 4

- **Незворотні рішення власника:** `solana program close G2ok…` (повертає ренту старої програми,
  старі задачі планувальника помруть разом з нею). Окремо, не незворотне: перенесення налаштувань
  сервісу Railway у `.railway/railway.ts` (політика `ALWAYS` / 180 с уже застосована напряму, `5a070a7c`).
- **Smoke 8–9** з апки, повторний smoke обох фіксів на свіжому APK, Phantom.
- **Не виміряно:** стійкість задач до рестарту TEE; `crank_tick` з 12 парами (розмір і CU); CU
  `credit_deposit`/`withdraw` в ER; `ComputeBudget` 1.4M в ER; справжні рядки помилок TEE для
  класифікатора (за ≈40 хв жодного не було).
- **Relayer:** `dataSlice` для відбору кандидатів (зараз цілі `Positions`); ~~ретеншн таблиці `ticks`~~ (закрито C.5
  02.10: `TICKS_RETENTION_MS`, перший прохід видалив 210 426 тіків); зовнішній uptime-монітор на `/healthz`; лог успішного коміту; `CRANK_WATCHDOG_MS` проти
  довжини петлі (≈3.3 с на 5 ринків, росте з ринками); скасування запланованого кранка не-SOL
  ринку; поповнення `FeeEscrow` (≈3.3 доби запасу при 300 с).
- **Програма:** чи гейтити EMA новим принтом (кожен `crank_tick` повторно застосовує EMA до того
  самого принта).
- **Тести:** Postgres-тести `indexerDb.test.ts` (немає Docker; після C.5 — 14 skipped, міграції 009/010 теж
  лише з деплою); `bootstrap()` на mb-stack (немає mb-stack); локальний `bootstrap()` не створює `BalancesRoot`.
- **Sybil #27** — без змін.
- **Документи:** рента в spec/CLAUDE.md — LiteSVM-формула; на devnet на ≈27 % менше (вище).
- **Умовні ордери (PR #14) і Token information (PR #15), 04.10.2026:** змерджено в `main` і **задеплоєно на devnet того ж
  дня** (програма — слот `507294602`, relayer — деплоймент `58089680`); що виміряно й що лишилось — розділ «Деплой на devnet
  і smoke, 04.10.2026» нижче.

## Графік C.5, частина 2: деплой relayer-а з 16 таймфреймами і бекфілом Hyperliquid (02.10.2026)

Гілка `chart-timeframes` (PR #12, голова `a2f552d`), деплоймент Railway `0968a8e6` (`railway up --service relayer --ci`, 07:17 UTC). Програма не змінювалась. Збірка образу ≈1 хв; перший healthcheck — 404 (процес ще піднімався), далі OK. Smoke апки того ж дня на AVD — підрозділ нижче; окремого APK не збирали (dev-client + Metro).

**Статус задач плану C.5 (02.10.2026):** Tasks 1–11 (relayer, app, документи) ✅; Task 12 — relayer на devnet ✅ (ця таблиця), app на AVD ✅ (підрозділ нижче); Task 13 ✅ Hyperliquid замість Pyth Pro (`3d01b82`, `0c3265a`, `8f6bd34`); Task 14 ✅ крокування за вагою ліміту (`4da24bc`, `35dd402`); Task 15 ✅ дві знахідки smoke (`e8f7947`). Фінальне ревʼю гілки + fix-wave (`3c9db88`, `a35fed8`). **Тести:** relayer 291 (277 + 14 Postgres skipped), app 159, unit 69 і LiteSVM 89 без змін.

| Що | Виміряно |
|---|---|
| Міграція 009 (`candles` + роллап усіх тіків) | `db: applying migration 009_candles.sql` 07:17:51.4 → 010 о 07:17:55.9 — **≈4.5 с** на 908 135 тіків (п'ять ринків, найстаріший 22.09 19:40 UTC) |
| Міграція 010 (CHECK `candles.source` без прив'язки до імені) | ≈1.7 с; `pg_constraint` після: `candles_source_check CHECK (source IN ('oracle','pyth_pro','hyperliquid'))`, `candles_tf_check` не зачеплено |
| Роллап оракула в `candles` | `1m` 15 527, `1h` 267, `1d` 19 рядків `source='oracle'` (з 22.09) |
| Бекфіл Hyperliquid, перший запуск | 07:17:58 → 07:19:27 = **89 с**; `run done rows=35025 weight=1440 markets=5 errors=0`; на кожен ринок × ярус рівно 1 «incomplete» рядок відкинуто (поточна свічка); жодного 429 |
| Вставлено з Hyperliquid | `1d` 6 126 (SOL 1360 / BTC 1369 / ETH 1369 / ZEC 1363 з 01.01.2023, HYPE 665 з 05.12.2024); `1h` 10 538 (по 2145 на ринок, SOL 1958 — решта вже була від оракула); `1m` 18 361 (3.5 доби — межа 5000 свічок/інтервал Hyperliquid) |
| `/healthz.backfill` після запуску | `{enabled: true, lastOkAt: 1790925477638, lastError: null, rows: 35025, source: "hyperliquid"}` |
| `/prices` (limit 1000) | `1M SOL` 46 свічок з 2023-01; `1W HYPE` 96 з 2024-12-02; `1M HYPE` 23; `1W ETH` 197 з 2022-12-26 (понеділок першого тижня 2023); `1h BTC` 1000 з 21.08; `30m HYPE` 172 (≈3.6 доби); `1s SOL` 983 за 1000 с; усі монотонні за `t`; `tf=7m` і `tf=1d` → 400 (ярлик — `24h`) |
| `ticks` до ретеншну | 908 135 рядків (SOL 706 392, BTC 51 686, ETH 51 708, HYPE 49 161, ZEC 49 186) |
| Ретеншн, перший `DELETE` | `retention: deleted 210426 ticks older than 604800000 ms` о 07:22:58.3 — через 300 с після старту, **≈0.7 с** на DELETE (таймер 07:22:57.6); `ticks` 908 680 → 698 611; найстаріший SOL-тік тепер 25.09 07:22 UTC, інші ринки — з 01.10 16:42 (їхні тіки молодші за 7 діб) |

**Висновки.** Оцінка ваги першого запуску (≈1515) була консервативною — реальна 1440, бо `1m` чанки повертають менше 2880 свічок (глибина Hyperliquid 3.5 доби). Крокування 55 мс/одиницю дало 89 с на запуск. Денні свічки ZEC/SOL/BTC/ETH сягають 2023 — на `1M` є ~46 місяців, `1W` — ~197 тижнів. Hyperliquid справді віддає незавершену свічку в кожній відповіді — фільтр `T >= now` спрацював 15 разів з 15. Pyth Pro у деплої вже не було: ключ не знадобився.

**Відкрите після C.5:** ~~Postgres-тести (`indexerDb.test.ts`, тепер 14) локально так і не запускались (нема Docker) — міграції 009/10 перевірено лише живим деплоєм~~ **закрито 04.10.2026:** Docker Desktop 29.5.3 на машині, `postgres:16-alpine` у контейнері, повний relayer-сьют з `TEST_DATABASE_URL` — **304/304, 0 skipped**, `indexerDb.test.ts` 15/15 (міграції 008, 009 з роллапом на таблиці з рядками, 010 CHECK `source`; upsert свічок; бекфіл не перезаписує оракул; ретеншн не чіпає свічки); release-APK на гілку (smoke — на dev-client); ~~другий (добовий) запуск бекфілу~~ **спостережено 04.10:** після редеплою `58089680` запуск пройшов (`lastError: null`, `rows: 0` — нових закритих свічок не було), retry-гілка на реальній помилці ще не траплялась; mount-кейс `scrollTargetFor` повертає 0 замість null (no-op `scrollTo`); живий край `1s` без whitespace до наступного refetch; `lastView` не оновлюється після `render` з tick-ефекту (один зайвий refit). Відкладені дрібниці ревʼю по задачах — spec §2.10 «Реалізовано».

### Smoke апки на AVD (02.10.2026, `local_phone`, dev-client + Metro з гілки `chart-timeframes`)

Прогін робив агент (без гаманця — графік видно без онбордингу; dev-client уже мав сесію з попередніх smoke, тож на SOL/HYPE видно лінії Entry/Liq). Усі скріншоти робились `adb exec-out screencap`.

| Крок | Результат |
|---|---|
| 16 пілюль таймфреймів | ✅ усі є, обрана прокручується в видиме; **знахідка №1:** при монтуванні з дефолтним `1m` ряд зсувався на 46 px і ховав `1s` за край (peek 24 px < пілюля) — виправлено (`e8f7947`: прокрутка лише коли пілюля не вся видна, `scrollTargetFor`), підтверджено холодним стартом |
| `1s` | ✅ плоскі секундні свічки з whitespace між ними, вісь рівномірна; живий край без whitespace до наступного refetch (відома відкладена дрібниця); **знахідка №2:** підписи осі лише `HH:MM PM` («04:08 PM» тричі) — виправлено (`secondsVisible` на `1s`), на пристрої тепер `04:18:13 PM, 04:18:26 PM …` |
| Columns / Baseline / HLC area на `1s` | ✅ рендер без помилок сторінки; у Columns на меншому масштабі видно чергування колонок і порожніх слотів; Baseline — лінія від першої реальної точки; HLC — смуга H–L вироджена на `1s` (одна ціна на свічку), як і очікувалось |
| Ярлики H/L за видимим вікном | ✅ на всіх tf, зокрема на `1s` при зумі (`H 122.63 / L 122.47` для хвилинного вікна) |
| Логотип TradingView | ✅ клік відкриває `tradingview.com` у системному Chrome (`mCurrentFocus = com.android.chrome`), апка повертається без втрати стану |
| Довгі tf з бекфілу | ✅ `1M SOL` — свічки з 2023 (L 9.68, ціна SOL у січні 2023); `2D BTC` — з липня; `1W/1M HYPE` — з грудня 2024 (L 9.31 — стартова ціна HYPE); `8h SOL` з середини вересня |
| Перемикання ринку без кешу (`1s`, SOL → ZEC) | ✅ через 0.4 с на графіку лише ціни ZEC (~1389), H/L ZEC; жодного бару SOL |
| Шум середовища | тост «ws error: undefined» після повернення з Chrome — з `@expo/devtools` (WebSocketWithReconnect dev-client-а), не код апки |

Пастка прогону: горизонтальний **швидкий** свайп по рядку таймфреймів перемикає ринок (жест екрана), повільний драг (≥1 с) скролить ряд. Автопрокрутка анімована — скріншот одразу після тапу ловить проміжний кадр; чекати ≥2 с перед наступним тапом за координатами.

## Умовні ордери: ревʼю PR #13 → PR #14 і два фікси (04.10.2026, лише локальні тести — на devnet НЕ виміряно)

**PR #14 змерджено в `main` 04.10.2026 о 06:43 UTC (`c459847`), PR #13 закрито.** Деплою на devnet ще не було.

PR #13 (колега, гілка `feat/conditional-orders`, база 27.09 + merge main 03.10) додає Limit / Stop-market / TP / SL /
Trailing як 8 `OrderSlot` по 88 Б у `Positions`, виконувані тим самим per-(трейдер, ринок) `liquidation_check`
(`run_orders` після перевірки ліквідації); `place_order`/`cancel_order` на 12-акаунтному `Trade`; у апці — тикет
Market/Limit/Stop з TP/SL, Open Orders, «Add TP / SL» на картці. Дизайн — `docs/superpowers/specs/2026-10-03-conditional-orders-design.md`.
Проти беклогу 6.B: зроблено Limit, Stop-market, TP/SL, Trailing; не зроблено stop-limit, виконання ордерів `crank_tick`-ом
relayer-а, частковий TP/SL, резервування маржі, Margin mode, Borrow Rate.

**Ревʼю (04.10, власне + `/code-review`):**
- Блокер 1 — merge-коміт `142f1ee` видалив `docs/android-install-options.md` (253 рядки) і посилання на нього в
  CLAUDE.md та `docs/emulator-runbook.md`. Злиття перероблено: PR #14 (`feat/conditional-orders-rebased`, коміт
  `564c10f` поверх `main`), 31 файл PR побайтово = `142f1ee`, решта = `main`. Коментар-вказівник у #13.
- Блокер 2 — `place_order` закінчувався `register_liq_task` без валідації `Trade.feed` (лише `open_position` робив це
  через `read_price`): трейдер міг перереєструвати власну задачу зі сміттєвим `feed`, і кожен плановий
  `liquidation_check` скіпав би на `WrongFeed` назавжди (ліквідує лише relayer). **Фікс `8093519`:** перевірка в самому
  `register_liq_task` (`feed.key() == Market.feed`, власник == `Config.oracle_program`). TDD: LiteSVM
  `place_order_with_a_foreign_feed_is_rejected` — червоний до фіксу («expected failure», ордер приймався), зелений після.
- Блокер 3 — `Positions` 3184 → 3888 Б без міграції: `AccountLoader` ріже дані рівно до `size_of + 8`, тож кожен
  делегований акаунт падав би в кожній інструкції (ні закрити, ні вийти, ні ліквідувати); relayer з `main` скіпав би нову
  довжину. Realloc неможливий (на L1 власник — Delegation Program; resize у ER не виміряно). **Фікс `732928b`:**
  хвіст ордерів опційний — `Positions` знову 3176 Б, `Orders = [OrderSlot; 8]` одразу після (`ORDERS_AT` 3184),
  `init_user` виділяє `SPACE_WITH_ORDERS` 3888; `orders_mut`/`load_positions_mut` читають хвіст лише при довжині ≥ 3888
  (один borrow даних — `load_mut()` + окремий borrow хвоста падали б на `RefCell`). Legacy-акаунт торгує, тікає,
  ліквідується обома шляхами й виходить; `place_order`/`cancel_order` → `OrdersUnsupported` (6054). Декодери TS приймають
  обидві довжини (`ordersSupported`). TDD: LiteSVM `legacy_positions_without_order_tail_still_trades_and_refuses_orders`
  (акаунт обрізано до 3184 через `set_account`), decoder-тести в app і relayer — червоні до фіксу (відсутні константи /
  експорти), зелені після.
- Середні (відкриті): повторне відкриття на тіку ліквідації через resting entry (`has_orders` читається до ліквідації);
  `attach_exits` ставить TP перед SL і мовчки губить той, якому не вистачило слота; вхідні ордери приймаються вже
  спрацьованими; прикріплені TP/SL не перевіряються проти ціни виконання, Stop без межі прослизання; `open_core` пише
  `free_margin` до чотирьох `checked_add`, а `run_orders` ковтає помилку; `describeOrder` хардкодить «SOL»/1e9; рядок
  ордера продубльовано в `TradeActivity`/`OrdersCard`.
- Дрібниці: `trailing_stop_price` поза `math.rs`, нечекані `u128`-операції, округлення на користь трейдера (суперечить
  правилу CLAUDE.md, якщо не задокументувати як виняток); правило CLAUDE.md про platform-tools v1.57 — особливість
  середовища автора (CI пройшов звичайним `anchor build`); spec §2.11 і ER/адмін TS-білдери `place_order` відсутні.
- `program_autofixer` по `order.rs`, `liquidation.rs`, зміненим частинам `trade.rs` (включно з обома фіксами) — 0 зауважень.

**Тести після фіксів (04.10.2026, Node 24.18.0):** LiteSVM **110** (108 у PR + 2), unit **73**, app **171** (170 + 1),
relayer **292** (278 + 14 Postgres skipped; 291 на `main`, +1). `tsc` ×3, `expo lint`, `prettier`, `cargo fmt`, clippy
як у CI — чисто. IDL перегенеровано (`OrdersUnsupported`; тип `OrderSlot` зник з IDL, бо більше не поле `Positions`).

**Звірка з референсами скіла `magicblock` (04.10):** resize описано лише для Ephemeral Accounts (живуть тільки в ER,
ніколи не комітяться) — для делегованого акаунта шляху зміни розміру немає, що підтверджує опційний хвіст замість realloc.
Перереєстрація того самого `task_id` — оновлення лише за тієї самої authority (у нас завжди `FeeEscrow` PDA), але
scheduler застосовує її **асинхронно**: успіх tx `place_order` не доводить, що задача оновилась, — міряти за фактом
виконання. У scheduled-інструкції лише `crank_signer_pda(authority)` може бути signer, список акаунтів фіксується при
реєстрації, валідувати акаунти має програма до CPI — саме це закрив `8093519`.

**Не виміряно на devnet (план виміру):** (1) `place_order` TP на smoke-гаманці `2TQe…` (його `Positions` 3184 Б) після
апгрейду має дати `OrdersUnsupported`, а open/close/тік — працювати; (2) новий гаманець: Limit без позиції → дочекатись
тіку планувальника й побачити відкриту позицію, не успіх tx; (3) CU `run_orders` на тік (crank-токен); (4) relayer
редеплоїти разом із програмою (новий декодер приймає обидві довжини). Не пробували: `realloc` делегованого акаунта в ER.
Рента нового `Positions` зростає на 704 Б (≈ +3.7 M лам. на devnet за формулою плану 4) — спонсорований онбординг
дорожчає для `fee_payer`. Коміти PR #14: `564c10f` (злиття), `8093519` (feed), `732928b` (хвіст), `15faede` (документи).

## Token information: ревʼю PR #15 (04.10.2026, змерджено `2bfe24a`; лише локальні тести й один живий запит до CoinGecko)

PR #15 (колега, гілка `feat/token-information`, база — `main` після #14): relayer `GET /assets/:symbol` для SOL/BTC/ETH/HYPE/ZEC —
текст і https-посилання з `services/relayer/assets/assets.json` у репо, числа з CoinGecko (`coins/{id}` + `global`, без ключа;
`COINGECKO_API_KEY` — demo-ключ лише для ліміту), кеш у памʼяті `ASSETS_CACHE_MS` 10 хв, single flight, бекоф 60 с після збою,
старі числа зі `stale: true`, без чисел — текст і `market: null`; `ASSETS_ENABLED=false` вимикає. Апка: третя вкладка
**Token info** у `ChartSection` (`TokenInfoPanel`, `lib/assets.ts` з https-only парсером, `assetFormat.ts` без `Intl`).
Замість окремого `AssetInfoScreen` з Long/Short знизу — вкладка на тому ж екрані (тікет уже під графіком). Пункт 7 беклогу.

**Ревʼю (04.10): блокерів немає.**

| Перевірка | Результат |
|---|---|
| relayer, повний сьют (у PR запускали лише `assets.test.ts`) | **304** (290 + 14 Postgres skipped; було 292) |
| relayer `tsc` | чисто |
| app тести | **181** (було 171) |
| app `tsc`, `expo lint`, `prettier` | чисто — «дві помилки згенерованих файлів» з опису PR не відтворюються; це середовище автора без `postinstall` (`gen:lwc`) |
| живий CoinGecko без ключа | `coins/hyperliquid` і `global` → 200; парсер: rank 11, market cap ≈19.97 B, ATH 97.96 (2026-09-23), max supply 1 B, total ≈955.3 M; total market cap ≈2.88 T |

Що перевірено в коді: https-валідація посилань двічі (при старті relayer-а і в парсері апки); Express 5 — async-помилка в
роуті не підвісить запит; `Dockerfile` копіює весь `services/relayer`, тож `assets.json` потрапляє в образ; роут змонтовано до
`listen`; кольори лише з токенів теми; `key={symbol}` на панелі; факти й дати запуску в `assets.json` звірено. Навантаження на
CoinGecko — 6 запитів на 10 хв на всі пʼять ринків.

**Дрібниці (відкриті):** `TokenInfoPanel` на будь-яку помилку пише «not available for X yet», включно з мережевою — варто
розрізняти 404 і збій мережі; `docs/deployments.md` без нових env (`ASSETS_ENABLED`, `ASSETS_CACHE_MS`, `COINGECKO_API_KEY`);
404 відлунює `req.params.symbol` без обмеження довжини (JSON, безпечно). Поза PR, як і заявлено: share / alert / favorite,
значок активу, CoinMarketCap.

**Не виміряно:** `/assets/:symbol` з живого relayer-а (потрібен `railway up`), вкладка на пристрої, поведінка при 429 від CoinGecko
на спільному egress-IP Railway.

**Знахідка процесу:** фоновий `/code-review` цього разу перевірив не той таргет — під час його роботи гілки перемикались для тестів,
і він проаналізував локальний `main` замість PR. Його вісім знахідок стосуються `docs/android-install-options.md` (неіснуюча команда
`solana-mobile playground`; `gh release create` з `#` не перейменовує файл; `eas.json` уже існує; редагування згенерованого
`build.gradle` не переживе `prebuild`; рядок 7 таблиці про Metro; `minSdkVersion` не в `app.json`; «втрата ключа = інший package»
неточно) — окремий список для правок документа, не частина ревʼю PR #15.

## Деплой на devnet і smoke, 04.10.2026 (програма + relayer з `main` `7a31959`; AVD `local_phone`, fakewallet)

**Програма — апгрейд на той самий id `Fyg2…UfCY`, не новий keypair** (legacy-акаунти переживають завдяки опційному хвосту).
Збірка `anchor build --ignore-keys` з коду `main`: `.so` **1 136 328 Б**, sha256 `ea07c58c…53150e`; IDL з цієї збірки
побайтово = `idl/dexxer_core.json`. Деплой запускав власник через `!` (класифікатор блокує агенту і `solana program deploy`,
і — вперше — `railway up`).

| Крок | Факт |
|---|---|
| `solana program extend … 32768` | потрібен: новий `.so` на 28 888 Б більший за виділені 1 107 440 Б; ProgramData 1 107 485 → **1 140 253 Б**, рента 5 626 674 040 → 5 793 135 480 лам. (**+0.1665 SOL, незворотно**) |
| `solana program deploy … --program-id Fyg2…` | sig `212XaX63…e9Hu`, слот **507294602**, `err: null`, комісія 5 000 лам.; payer `4P1WD9…` 7.3056 → **7.1335 SOL** (разом з extend ≈0.172 SOL; буфер ≈5.77 SOL повернувся) |
| Звірка байтів | `solana program dump` у файл; sha256 перших 1 136 328 Б == локальний `.so`, хвіст розширення нульовий |
| Живий relayer (ще C.5) на оновленій програмі | тікає далі без помилок (`tickAge` 1.2 с) — `crank_tick` сумісний з обома збірками |

**Relayer — `railway up --service relayer --ci` з `main`** → деплоймент **`58089680` SUCCESS** (≈07:58 UTC; healthcheck: 404, 404,
503, далі OK — процес ще піднімався). `/healthz` ok, `db ok`, 5 ринків; перший тік SOL n=1 одразу після старту.

| Що | Виміряно |
|---|---|
| `GET /assets/{SOL,BTC,ETH,HYPE,ZEC}` | 200 (`sol` теж 200 — регістр не важливий), `DOGE` 404; `Cache-Control: public, max-age=60` |
| Перший сплеск: 5 символів поспіль за ≈2 с | CoinGecko **HTTP 429** ×3 у лозі (`assets: refresh failed`); SOL отримав числа, BTC/ETH/HYPE/ZEC віддали `market: null` (текст є) — після 60-с бекофу всі чотири підтягнули rank/mcap на наступному запиті. Поведінка «ніколи не помилка» підтверджена; на спільному egress-IP Railway без ключа ліміт нижчий за 6 запитів/хв |
| `/assets/SOL` | rank 7, market cap 71.16 B, dominance 2.47 %, ATH 293.31 (2025-01-19), circulating rate 92.6 %, `stale: false` |
| `crank_tick` з 1 кандидатом на новій збірці | **24 478…24 492 CU**, 449 B (на збірці плану 4 — 21 428…21 445): ≈+3 050 CU на кандидата за split-лоадер і хвіст ордерів; без кандидатів 15 535 (без змін) |

**Smoke на AVD `local_phone` (агент; fakewallet, owner `2TQe…FgWi` — легасі-акаунт плану 4, `Positions` 3184 Б).** Проксі +
Metro + емулятор за runbook §1; boot 18 с; dev-client бере бандл з Metro (гілка `main`), APK той самий (01.10).

| Крок | Результат |
|---|---|
| Запуск на легасі-акаунті | ✅ Trade відкрився, Positions (1 на HYPE) / Open Orders (0) з нового декодера, без крешу; бейдж `SESSION EXPIRED` |
| Token info · HYPE | ✅ назва, ранг #11, запуск Nov 29 2024, три тексти зі «Show more», ATH $97.96 / ATL $3.81, таблиця (mcap $20B, FDV $85.9B, 24h vol $465.99M, dominance 0.69 %, supply 222.45M/1B/955.31M, rate 23.29 %), Website/Explorer/GitHub (Whitepaper відсутній у `assets.json` — кнопки нема), дисклеймер «Updated 1 min ago» |
| Website | ✅ відкрився `hyperliquid.xyz` у системному Chrome (натиснуто випадково свайпом), повернення без втрати стану |
| Перемикання ринку з відкритою вкладкою | ✅ SOL: «Solana (SOL)», ранг #7, Mar 16 2020, Max. supply «—», Whitepaper є; вкладка Token info лишилась активною, панель перемонтувалась |
| Positions на легасі-акаунті | ✅ три картки (SOL long 3×, HYPE short 3×, ZEC long 5×), Mark/uPnL «—» до активації картки (за дизайном: live `Market` читається лише для активної) |
| Re-authorize session | ✅ Onboarding у режимі reauth → SIWS `sign_messages` → лег `permissions+session` 486 B → `/trade`; `SESSION ACTIVE · 23H LEFT · 20 ACTIONS` |
| Активна картка SOL | ✅ Mark $120.95, uPnL +$0.23, «30 % away from liquidation», картка **Orders · No pending orders · Add TP / SL** |
| **`place_order` TP 130 на легасі-акаунті** | ✅ **tx `5uPqnH9f…HCBD` відхилена `Custom 6054`**, апка показала «This account predates conditional orders — exit and set it up again to use them (6054)» — фікс блокера 3 підтверджено на живій мережі; позиції й сесія не зачеплені |
| Новий гаманець: онбординг, Limit без позиції, TP/SL, виконання планувальником | ⏸ **відкладено власником** (потребує Disconnect → fakewallet створить новий акаунт) |

**Знахідки smoke.**
1. **Тост з помилкою не видно під шітом.** `ToastHost` живе в root layout, а `Sheet` — це RN `Modal`, що малюється поверх усього:
   відмова `place_order` (і будь-якої дії з Increase/Decrease/Margin/Order-шіта) показується тостом ПІД модалкою, шіт лишається
   відкритим, користувач не бачить нічого. Виявлено лише тимчасовим логом у `run()`. Фікс — рендерити тост усередині `Sheet`
   або закривати шіт перед тостом (пункт у 6.B/C.4).
2. **`adb shell input tap` не спрацьовує на `Pressable` всередині `Modal`-шіта** (поля вводу й сегменти працюють); press-hold
   `input swipe x y x+1 y+1 120` спрацьовує. `uiautomator` при цьому показує `enabled=false` на кнопці, хоча вона активна —
   не вірити цьому полю для RN-кнопок у модалці.
3. Fast Refresh з Metro не доносив правки в `src/features/*` (жодного нового бандла в лозі) — повний reload через той самий
   `am start … expo-development-client` intent, що й у runbook §1 п. 7.
4. Horizontal swipe-інерція по екрану Trade зсуває вертикальний скрол — скріншоти робити через ≥1.5 с після жесту.

**Не виміряно / далі:** новий гаманець і Limit без позиції (реєстрація задачі з `place_order`, виконання планувальником — міряти за
фактом відкритої позиції, не за успіхом tx); TP/SL/Trailing на акаунті з хвостом; CU `run_orders` на тік; smoke 8–9 плану 4;
`docs/deployments.md` (нові env `ASSETS_*`/`COINGECKO_API_KEY`, деплоймент `58089680`, слот апгрейду) і маркери в CLAUDE.md
«лише тести — на devnet НЕ виміряно» для ордерів і Token info — оновити.

## Уроки процесу

- Фоновий `/code-review` читає робоче дерево: перемикання гілок під час його роботи підміняє йому таргет. Запускати ревʼю
  на `gh pr diff` / окремому worktree або не чіпати checkout, поки воно працює.

- Гілка колеги, відрізана до серії docs-комітів у `main`, при злитті мовчки видалила новий документ. Перевіряти злиття
  не лише стат-ом PR, а `git diff main <гілка> -- . ':!<файли PR>'` — має бути порожнім.
- Zero-copy акаунт не можна «просто дописати в кінець»: `AccountLoader` вимагає довжину ≥ `size_of + 8`, і коротші
  акаунти цегляться в усіх інструкціях. Опційний хвіст (структура незмінна, читання за довжиною) — безпечна альтернатива
  realloc, якого для делегованих акаунтів немає.
- Агенти не можуть запустити `solana program deploy`: класифікатор дозволів («Production Deploy»)
  блокує і виконавця, і контролера. Деплой — через `!` власника в сесії.
- Railway CLI зависає на stdin без `</dev/null`: `railway variables --service relayer --kv` висів
  понад 10 хв. Синтаксис CLI 5.23: `railway variable set/delete`, `-y`/`--json` всюди.
- `solana balance <addr>` надрукував баланс дефолтного підписанта для всіх трьох адрес. Баланси —
  лише через JSON-RPC `getBalance`.
- Локально немає `psql` і Docker: SQL у Postgres Railway — `railway ssh --service Postgres -- psql …`
  (публічного TCP-проксі в сервісу немає).
- Пробна підписка Railway закінчилась непомітно: relayer лежав з 25.09, Postgres — з 22.09. Нічого
  про це не сповіщало (див. uptime-монітор).
- `solana program dump <id> -` пише файл з іменем `-`, а не в stdout.
- `railway.json` у репо не означає застосованої політики: перевіряти `serviceManifest` деплойменту. Config-as-code Railway
  застарів (`.railway/railway.ts`) — налаштування сервісу виставляти напряму (`update-service`).
- Передеплой сервісу, залитого `railway up`, — лише `railway up`: MCP `redeploy` не має джерела-репо й
  падає на BUILD_IMAGE.
- Процес `railway mcp` плагіна тримає токен, з яким стартував, і стає `Unauthorized`, коли той спливає, —
  перезапустити процес (або конектор Railway claude.ai).
- Сценарій, що форсує параметри спільного ринку, ліквідує **кожного** трейдера на ньому, не лише
  свого (13 забрав трейдера 01).
