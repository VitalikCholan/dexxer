# Тиждень 4 — результати

PoolLive private aggregate, знімок #24, devnet-міграція (M-F). Гілка `week4-mvp-polish`, база
`93cb8ee` (week 3 фінал). Формат документа — той самий, що й `week3-results.md`: виміряний
підсумок для контролера й спеки, не заміна власних task-звітів
(`.superpowers/sdd/2026-09-22-week4-mvp-polish/task-N-report.md`). Задачі 0–2 нижче — короткі
підсумки; Задача 3 (редеплой + devnet-міграція + M-F + регресія 06/07/08) — з повними деталями,
бо саме вона несе виміряні цифри цього тижня.

## Task 0–2: PoolLive, зняті писачі Pool, permissioning (короткі підсумки)

- **Task 0** (комміт `f43e305`, fix round 1 `0a1f5eb`) — `PoolLive` (`state/pool_live.rs`),
  `POOL_LIVE_SEED`/`SNAPSHOT_STEP`, `floor_step`/`ceil_step` (checked-математика), `init_pool_live`/
  `delegate_pool_live`. Unit **51→54**, LiteSVM **65→67**.
- **Task 1** (комміт `b104912`, fix round 1 `2e242d5`) — усі trading/money-інструкції пишуть
  `PoolLive` замість `Pool`; `commit_aggregate` публікує заокруглений знімок у `Pool`
  (assets floor, liabilities ceil). `SeedPool` пише обидва (`Pool` і `PoolLive`) за рулінгом
  контролера. Unit **54** (без змін), LiteSVM **67→69**.
- **Task 2** (комміт `b521a2f`) — `init_market_permissions`: робить `MarketRisk`+`PoolLive`
  permissioned `[crank, admin]` в одному ER-виклику (ризик #24), self-funding CPI за зразком
  `InitPermissions`. Unit **54→55**, LiteSVM **69→71**.

Разом до Task 3: unit **54→55**, LiteSVM **65→71**.

## Task 3: Devnet-редеплой, PoolLive-міграція, вимір M-F, регресія 06/07/08

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-3-report.md`. Нижче — виміряні
таблиці.

### Редеплой

| | значення |
|---|---|
| Програма | `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` |
| Data length до | 1,048,272 байт |
| `solana program extend` | +131,072 байт |
| Data length після | 1,179,344 байт (вистачило на всі наступні редеплої — жодного повторного extend) |
| Баланс payer до extend | 6.073550713 SOL |
| Баланс payer після extend | 5.407699953 SOL (~0.666 SOL, разовий — домінантна реальна вартість задачі) |
| Фінальний деплой (сигнатура) | `4P2tPKgLPDv1CF1eC8VQqHGqmNTY9PKW99F5SfhixtwxQwKuQGbk1Eyn4TM3yhWhUd1mzJ7PmzEdqqietzQC18Yz` |
| Фінальний слот | 502493268 |
| `solana program show --buffers` | порожньо (жодного залишку з 9 деплоїв цієї сесії) |

Між extend і фінальним деплоєм — **9 редеплоїв усього** (ітерація над `init_market_permissions`'s
фандинг-механізмом, див. нижче) — кожен за схемою "позичити SOL у `devnet-admin` за потреби →
deploy → перевірити → повернути позичене". Пік розміру `.so` під час ітерацій — 1,126,376 байт,
у межах виділеного запасу.

**Fix round 1 — редеплой #2:** після виправлення `init_market_permissions` (нижче) —
сигнатура `5pbJA5XeGTmFkTL9w8ErkJbGjFy3krgH8WKperbLoEV6T9xaZaidYGWZ3f2VLrYRxhkWMZ5Myrnid85SMwv8iLuY`,
слот 502556348, data length незмінна (1,179,344 байт, запасу вистачило), `solana program show
--buffers` — порожньо після завершення (перша спроба лишила буфер на 5.653 SOL через 11 write-tx
timeout, відновлено `solana program close` — SOL повернуто payer'у, жодних втрат окрім fees).
Payer перед round 1 мав лише 2.338 SOL (недостатньо для тимчасового buffer-rent ~5.659 SOL) —
профінансовано зворотним sweep'ом залишкового SOL з throwaway devnet-ключів тестів попередніх
задач (§Баланси нижче) до 5.684 SOL, чого вистачило.

**Справжній Rust-баг, знайдений і виправлений (окремо від фандинг-саги):**
`InitPoolLive.pool: Account<'info, Pool>` відхиляв уже делегований на devnet `Pool` з
`AccountOwnedByWrongProgram` (0x0bbf/3007) — `Pool` делегований ще з тижня 1–3, тому власник на L1
уже Delegation Program, а не `dexxer_core`. Виправлено: `pool` → `UncheckedAccount<'info>` +
ручна `Pool::try_deserialize` (перевірка дискримінатора, без перевірки власника), seeds обох
(`pool`, `pool_live`) — з `config.dusdc_mint` замість самопосилального `pool.mint`. Це реальний,
загальний фікс, потрібний для будь-якої майбутньої devnet/mainnet-міграції, де `Pool` уже
делегований до появи `PoolLive`.

### Сага фандингу `init_market_permissions` — round 0 (6 спроб, усі відхилені), round 1 (фікс)

**Round 0 (Task 3, до fix round 1):** `market_risk` (тиждень 1) і свіжостворений `pool_live`
мали на devnet точно свій rent-exempt мінімум, без надлишку (965,200 і 1,107,440 lamports
відповідно) — self-funding CPI (як у `InitPermissions`) падав з `InsufficientFundsForRent`. Шість
in-transaction механізмів фандингу випробувано й відхилено, кожен своєю помилкою:

| # | Підхід | Результат |
|---|---|---|
| 1 | Self-funding (оригінальний код Task 2) | `InsufficientFundsForRent` |
| 2 | `admin` як `mut` CPI-payer у CPI в Permission Program | `InvalidWritableAccount` |
| 3 | Окремий `fee_payer` + `admin` як додатковий підписант | `InvalidAccountForFee` |
| 4 | Caller-side `SystemProgram.transfer`, топап перед викликом | `InvalidAccountForFee` (будь-яка сира `SystemProgram`-only інструкція відхиляється цим ER) |
| 5 | `admin` `mut`, CPI-переказ зсередини інструкції | `InvalidAccountForFee` (tx fee payer ніколи не `mut` на рівні інструкції) |
| 6 | Прямий lamport-переказ (`try_borrow_mut_lamports`) з `fee_escrow` | `UnbalancedInstruction` |

**Round 1 (fix round, ця задача): санкціонований механізм спрацював з першої спроби.** Жодна з
шести in-transaction спроб не була правильним шляхом — фандинг делегованого ER-акаунта йде через
**base-layer eSPL delegated-lamports transfer**, не через саму ER-інструкцію: `admin.ts`'s нова
`fundMarketPermissions()` викликає `lamportsDelegatedTransferIx(admin, dest, 5_000_000n, salt)`
(той самий примітив, що вже фінансує `FeeEscrow` в `scripts/admin/fund-fee-payer.ts`) на base для
кожного з `market_risk`/`pool_live` — обидва вже делеговані на момент виклику (`market_risk` з
тижня 1, `pool_live` — щойно вище в `bootstrapDevnet()`), що й є єдиною вимогою цього примітиву
("destination must already be delegated"). Виміряно:

| PDA | ER-баланс до | Сигнатура top-up (base) | ER-баланс після |
|---|---|---|---|
| `market_risk` | 965,200 | `dNwA7vpu7c7SW31FWCJdah4HgehM4SVnRUQhm9dtuAGq3bnKeL5TVfHrfv1A5b9yFNTLCfXSnxR5ndfLHogjRQr` | 5,965,200 |
| `pool_live` | 1,107,440 | `5zNpG6LJoNRV4A6mdquhYGmuasabtCnP5UDRzyYw1PxGQLsX4CxEcbELH4VLNmcaGFg8f21RgVgTvYnJLxBzx7xJ` | 6,107,440 |

Після топ-апу `init_market_permissions` (`5zuhmV6y6W6szv2js3A58ZZ3zxUQm4cHP7i8x1urTBSqv7fX3NF31VpJMy33NY1NbmeiRsW2hscPTujZuMUVja1x`)
пройшов з першої спроби: `marketRisk permissioned=true, poolLive permissioned=true`. Rust-сторона
(`init_market_permissions` в `instructions/user.rs`) повернута до простого propagate-`?` виду
(байт-в-байт як `InitPermissions`) — жодної tolerate-логіки не потрібно, бо тепер акаунти мають
rent-надлишок. `bootstrapDevnet()` більше не обгортає виклик у try/catch — падіння тут тепер є
реальним провалом bootstrap, не тихо-толерованим станом.

**Наслідок: ризик #24 закрито на цьому devnet.** `MarketRisk`/`PoolLive` більше не читаються
сторонньою ER-конекцією (див. M-F (c)/(e) нижче).

### M-F (`tests/er/devnet/09-pool-snapshot.ts`)

Також знайдено й виправлено (не пов'язано з фандинг-сагою): цієї сесії devnet SOL faucet
вичерпав rate-limit — `requestAirdrop` підтверджував транзакцію, але доставляв **0 lamports**, що
каскадом ламало `onboardTrader`'s `getOrCreateAssociatedTokenAccount`
(`TokenAccountNotFoundError`). Виправлено: свіжий M-F-трейдер попередньо фондується з
deploy-payer'а (`spikes/keys/payer.json`, devnet-only, без реальної вартості) — `onboardTrader`'s
власна перевірка балансу бачить достатньо й пропускає (зламаний) airdrop-шлях. **Fix round 1:**
префандинг зменшено з 3 SOL до **0.3 SOL** (фактична витрата round-0-прогону на весь M-F-потік —
лише ~0.023 SOL, тож 0.3 SOL — щедрий запас без паркування великих сум на throwaway-ключах); у
round-1-прогоні airdrop несподівано **пройшов** (rate limit, схоже, скинувся), але це не мало
значення — префандингу вистачило незалежно.

Round 1 (після фандинг-фіксу вище): усі п'ять кроків **PASS**, включно з (c)/(e), які раніше були
жорсткими/інформаційними FAIL через незапермішнений `MarketRisk`/`PoolLive`.

| Крок | Результат | Сигнатура |
|---|---|---|
| (a) `Pool` незмінний на base+ER (crank) навколо `open_position` | **PASS** | `open_position`: `21YQv48Hwt4RmJH1SP65tnLDA649xghZDE2dDC4RXmWesaL3mUdqKyVbHwtExcYJwV849WNh9NAKZt4c4GrvGf1c` |
| (b) `PoolLive.locked_total` (crank) зріс рівно на маржу | **PASS** — 80,000,000 → 100,000,000 (Δ 20,000,000 = 20 dUSDC) | (той самий open) |
| (c) `PoolLive` через stranger TEE-конекшн → відмова/null | **PASS «M-F private live aggregate»** — читання ЗАБЛОКОВАНЕ (null), ризик #24 закрито | — (читання) |
| (d) `commit_aggregate` → заокруглений знімок `Pool` | **PASS** — `locked_total=100,000,000` (÷1e8=0), `committed_locked(100M) ≥ live(100M)`, `committed_capital(23.1B) ≤ live(23.1B)` | `commit_aggregate`: `5UYwtU1VshiBkhSeYTuHqkzmYYqDH9ZAWFGte6dXoahRDv2UYq7c8U6WeUGH5jkjUEFZBStafqEfjKGEHJzY943X` |
| (e) `MarketRisk` через stranger → відмова/null | **PASS «M-F MarketRisk private»** — читання ЗАБЛОКОВАНЕ (null) | — (читання) |

Підсумок скрипту: **`09-POOL-SNAPSHOT PASS`** (усі 5 кроків, включно з жорстким гейтом (c)).
`commit_aggregate`, підписаний `fee_payer` (не member `PoolLive`), успішно прочитав/записав
`PoolLive` попри permissioning — узгоджується з рулінгом 8 тижня 3 (TEE-permission-шар гейтить
RPC-читання неучасником, не tx-інклюзію); фолбек-рулінг 7 (додати `fee_payer` як третій VIEWER-
член `build_admin_members`) не знадобився.

### Регресія 06/07/08

Усі три **PASS**, з першої спроби:

- `npm run devnet:disclosure` (06) → `06-COMMITMENT-REVEAL PASS`. Повний цикл
  commitment→reveal: `commit_aggregate(position)` — 3.1с до появи на base, `commit_aggregate(dq)`
  — 3.0с, хеш звірено побайтово.
- `npm run devnet:root` (07) → `07-BALANCES-ROOT PASS`. Два цикли root (усі 64 листки змінились
  між циклами), лист відомого трейдера підтверджено; 12×`commit_aggregate` вимір вартості —
  **12/12**, escrow-вартість рівно 200,000 lamports/коміт, без відхилень.
- `npm run devnet:undelegate` (08) → `08-UNDELEGATE PASS`. Повний вихід 06-трейдера: closeout,
  drain, `withdraw(all)`, `undelegate_user` — owner-flip на base за 4.2с, усі scrub-перевірки
  пройшли.

Жодних змін у списках акаунтів цих трьох скриптів не знадобилось — `pool_live` уже підключений
Task 1.

### Баланси після (round 0, кінець Task 3)

| Ключ | Роль | До сесії | Після round 0 |
|---|---|---|---|
| `spikes/keys/payer.json` | deploy authority | 6.073550713 SOL | 2.338419953 SOL |
| `devnet-admin` | bootstrap admin | 0.40487656 SOL | 0.3513628 SOL |
| `devnet-crank` | crank identity | 0.1 SOL | 0.1 SOL (не чіпали) |
| `devnet-fee-payer` | ER commit fee payer | 0.25 SOL | 0.25 SOL (не чіпали — вартість 12 коммітів списана з `FeeEscrow`, не з цього гаманця) |

### Баланси після (fix round 1, кінець задачі)

Payer перед round 1 (2.338 SOL) не вистачало на тимчасовий buffer-rent редеплою (~5.659 SOL) —
профінансовано зворотним sweep'ом throwaway devnet-ключів попередніх задач (§8 брифу — той самий
рух, що й обов'язковий sweep M-F-трейдера): `devnet-snapshot-1790091805182` (2.967 SOL) +
14 дрібних mb-/ruling8-/trader-/session-ключів (~0.379 SOL сумарно) → payer 5.684 SOL, вистачило.
Перша спроба деплою впала на 11 write-transactions (мережевий timeout, не нестача коштів) —
буфер `7T7Y8uhepNtoUUVHeyrU9Q5c9FhLMdSTuzK5ap1mmuDT` (5.653 SOL) закрито `solana program close`,
rent повернуто payer'у, друга спроба пройшла чисто.

| Ключ | Роль | Після round 0 | Фінал (fix round 1) |
|---|---|---|---|
| `spikes/keys/payer.json` | deploy authority | 2.338419953 SOL | **5.537197297 SOL** (net +3.199: sweep-приплив від throwaway-ключів переважив разовий buffer-rent redeploy'у #2, tx fees і M-F трейдер-префандинг/sweep-назад) |
| `devnet-admin` | bootstrap admin | 0.3513628 SOL | **0.3907478 SOL** (top-up 0.1 SOL з payer'а — початковий баланс просів нижче `requireFunded`'s 0.3 SOL floor після topUp-фандингу+07's 12-коміт циклу) |
| `devnet-crank` | crank identity | 0.1 SOL | 0.1 SOL (не чіпали) |
| `devnet-fee-payer` | ER commit fee payer | 0.25 SOL | 0.25 SOL (не чіпали) |
| M-F throwaway trader-ключі | одноразові | 2.977 SOL "запарковано" | **пiдметено назад** до payer, 0.01 SOL лишено на кожному (ruling 8) |

Програма (`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`): data length незмінна 1,179,344 байт,
баланс 5.99194636 SOL, `solana program show --buffers` — порожньо.

## Гаунтлет (фінальний стан, включно з fix round 1)

- `cargo fmt --all -- --check` → 0.
- `cargo clippy -p dexxer_core -- -D warnings` → чисто.
- `cargo test -p dexxer_core` → **55/55** (без змін відносно Task 2).
- `cargo +nightly-2026-09-18 test -p dexxer_litesvm` → **71/71** (без змін відносно Task 2).
- `mcp__solana-mcp-server__program_autofixer` — чисто на кожній зміненій ділянці, кожен раунд
  (round 1: `instructions/user.rs`, `instructions/pool_live.rs`).
- `anchor build` — чисто (лише попередній `syn`/`anchor-syn` шум, не стосується `dexxer_core`).
- `npx tsc --noEmit`: `tests/er`, `scripts`, `app` — усі чисті (round 1 знахідка: `tests/er`'s
  `@types/node` — стара версія 12.20.55, без ambient-модулів для `node:`-префіксних імпортів;
  виправлено використанням `"crypto"` замість `"node:crypto"` в `admin.ts`, узгоджено зі стилем
  решти `tests/er` — жоден інший файл там не використовує `node:`-префікс).
- IDL: `target/idl/dexxer_core.json` скопійовано в `app/src/idl/dexxer_core.json`, `cmp` — identical.

## Concerns / відкрите для тижня 5

1. ~~Ризик #24 (публічні `MarketRisk`/`PoolLive` в ER) лишається відкритим на devnet.~~
   **Закрито fix round 1** — санкціонований механізм фандингу (`lamportsDelegatedTransferIx` на
   base, до вже делегованих PDA) спрацював з першої спроби; `init_market_permissions` пройшов,
   M-F (c)/(e) PASS. Шість round-0 in-transaction спроб лишаються задокументованими як довідка,
   чому саме цей шлях (a не інший) — сага вище.
2. **`UnbalancedInstruction` на прямому lamport-переказі між двома делегованими PDA лишається
   непоясненим**, але вже не є блокером — round 1 не потребував цього шляху. Не варте окремого
   запиту в підтримку MagicBlock, якщо не знадобиться знову.
3. **Devnet SOL faucet був rate-limited на початку сесії, але скинувся під час fix round 1**
   (round-1 M-F-прогону airdrop пройшов). Малий (0.3 SOL) префандинг-воркараунд лишено в
   `09-pool-snapshot.ts` як страховку — дешевий, не шкодить, навіть якщо airdrop працює.
4. `09-pool-snapshot.ts` підтвердив на практиці те, що передбачалось: (c)/(e) стали PASS без
   жодної зміни скрипту, щойно ризик #24 закрито — скрипт від початку перевіряв реальний on-chain
   стан (власника permission-PDA), не відсутність кинутої помилки.

## Task 4: relayer на Railway (короткий підсумок)

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-4-report.md`. `services/relayer`
(Express + `ws`, перейменований/розширений `scripts/crank-fallback`, комміт `ab6be5a`) — Dockerfile
(10-стадійний), деплой на Railway (`railway up --service relayer --ci`, проєкт `dexxer`, оточення
`production`). Домен `https://relayer-production-1ae7.up.railway.app`, `GET /healthz` →
`{"ok":true,"tick":79,"crankSol":0.1,"feePayerSol":0.25,"schedulerActive":false,"db":"ok"}` live.
Ключі `CRANK_KEY_B58`/`FEE_PAYER_KEY_B58` — Railway variables (base58), ніколи в git. Fix round 1
(`58300ab`) — graceful `SIGTERM` тепер чекає завершення поточного `crank_tick` перед закриттям
(`shutdown.ts`, 3 нові тести); підтверджено на реальному redeploy (лог: SIGTERM mid-tick-5 → tick 5
довершився → лише тоді процес вийшов). `docs/deployments.md` заведено цією задачею (проєкт/сервіс
id, домен, ролі ключів, program/PDA-адреси — без секретів).

## Task 5: індексер публічних даних (короткий підсумок)

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-5-report.md`. Другий підсервіс у
тому ж `relayer`-процесі (`INDEXER_ENABLED=true`), читає ЛИШЕ публічні акаунти (оракул без токена
на TEE RPC, `Pool`/`BalancesRoot`/`Disclosure` на base RPC) — ніколи `crank`/`fee_payer`. REST
`/prices?tf=&limit=`, `/mark`, `/pool/latest`, `/disclosures?limit=`, `/root/latest` + WS `mark`-
фрейми — усі live на Railway з реальними devnet-даними (комміт `3644066`). Постгрес-міграція
`001_indexer.sql`. Fix round 1 (`b462ce3`): `/mark` і WS `mark` тепер несуть `stale`-прапорець
(окрема TEE→base стейлнес-логіка — контролер вирішив, що base-копія оракула є застарілим commit-
знімком, тож фейловер туди показував би заморожену ціну як живу, гірше за відкриту помилку);
golden vector для `tag=0` (Partial) feed-формату. Суїта `services/relayer` **22→27** тестів.

## Task 6 (fix round 1): sponsored rent, whitelist за позиціями акаунтів, атомарний rate-limit

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-6-report.md`, розділ
"Fix round 1 (fresh implementer)". Контролерський рулінг мав 5 знахідок (A–E); нижче — виміряні
підсумки.

**A.1 (програма, `payer` окремо від `owner`)** — `FaucetInit`/`InitUser` отримали
`#[account(mut)] pub payer: Signer<'info>`; кожен `init, payer = payer`. Редеплой на devnet
(`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, підпис `66hN978d…`). **Підтверджено на реальному
devnet**: `faucet_init`+`init_user` в одній sponsored tx списали з owner **лише** ATA-рент
(~1,488,440 lamports), решту рент PDA — з `fee_payer`.

**A.2 (eSPL)** — `delegateSpl(..., { payer: feePayerPubkey, ... })`; підтверджено на devnet —
`delegateSpl`+`delegate_user` пройшли в одній sponsored tx (за умови, що owner мав достатньо для
`delegate_user`'s власного CPI, див. нижче).

**A.3 (ER-леґ) — СПРОБУВАНО, ВІДКОТЛЕНО.** Спонсорування permissions+session-леґу (`feePayer =
fee_payer`, TEE-з'єднання, SystemProgram-transfer сесійного топ-апу в тому ж tx) відхилено самим
TEE: `"InvalidAccountForFee"` — fee_payer не є валідним fee-payer'ом для ER-транзакції, яку сам
не ініціював (підтверджує `session.ts`'s коментар: ER клонує лише L1-баланс для читання, не
приймає довільний неделегований акаунт як платника комісії). Відкотлено до pre-fix-round
дизайну (owner-funded ER-леґ + окремий сесійний топ-ап) — підтверджено повним проходженням
`tests/er/devnet/01-onboard-private.ts` (PASS, включно з `open_position`, сесійним підписом).
Релеєрський whitelist (`sponsor.ts`) залишає підтримку цієї форми (init_permissions/set_session/
SystemProgram-transfer) як готовність на майбутнє — код мертвий, поки додаток не використовує ці
шляхи.

**B (whitelist за позиціями акаунтів)** — `checkInstruction` тепер валідує позицію `payer`/`owner`
за IDL/SDK-порядком акаунтів для кожної інструкції (`IxShape`), не лише дискримінатор/опкод; жоден
інший ключ не може дорівнювати `fee_payer`. Закриває конкретну атаку зі звіту: fee_payer підставлений
у слот `owner`/`payer` іншого акаунта. Тести: `services/relayer/test/sponsor.test.ts` — 52/52
(fee_payer у owner-слоті; fee_payer у ATA payer-слоті з чужим owner; дублікат `init_user`;
transfer на не-сесійний pubkey/понад ліміт/від owner; payer ≠ fee_payer).

**C (атомарний rate-limit)** — `SponsorStore.reserve` через `INSERT ... ON CONFLICT (owner,
"window", slot) DO NOTHING RETURNING`; конкурентний тест (два `Promise.all` на той самий owner)
дає рівно один 200 і один 429. **Пост-верифікаційна знахідка (не входила в A–E):** оригінальний
ліміт "1 sponsored tx на owner на 60 хв" робив повний onboarding (2–3 sponsored-леґи на того ж
owner в тому ж вікні) фізично неможливим — леґ 2 завжди впирався в 429 від леґу 1. Виявлено лише
під час наскрізної верифікації проти живого relayer. Виправлено: `MAX_SPONSOR_CALLS_PER_OWNER_WINDOW
= 6` слотів на owner на вікно (кожен слот — окремий unique-індекс `(owner, "window", slot)`,
атомарність fix-у C не порушена). Нова міграція `004_sponsors_slot.sql` (адитивна — `003` вже
застосована на живій БД, редагування заднім числом не подіяло б).

**D (свіжість blockhash)** — `collectBatchLegs` не читає blockhash взагалі (тільки стан акаунтів);
blockhash береться прямо перед `signTransactions`. Між леґами — `Connection.isBlockhashValid`
перед відправкою; протермінований леґ перебудовується й підписується окремо (`re-sign leg i
(blockhash expired)`, один додатковий MWA-промпт) замість падіння всього батчу.

**E (винесення файлу)** — `collectBatchLegs`/`runBatchedOnboarding`/`BatchLeg`/`runDevDeposit` →
`app/src/features/onboard/batchOnboarding.ts`; `useOnboarding.ts` — тонка hook-обгортка (React
state, `buildCtx`, legacy `runFlow`).

**Пост-верифікаційна знахідка (не входила в A–E, не виправлено цього раунду):** `delegate_user`
не має окремого `payer` (тільки `owner`), і його власний CPI до Delegation Program потребує
більше lamports від owner, ніж вже існуючий permission-rent prefund в `init_user` покриває —
виміряно на devnet: ~1.1–1.35M lamports понад ATA-рент (~1.49M) і власний rent-floor гаманця
owner (~0.65M). Тобто **справді нульовий owner і після цього fix round не пройде онбординг** —
реальний виміряний мінімум ≈0.0033–0.0035 SOL, не нуль. Не виправлено (поза скоупом цього
раунду — потребує окремого дослідження Delegation Program CPI).

**Емулятор:** контролер зупинив верифікацію на емуляторі на середині сесії (мережева
нестабільність AVD — `UnknownHostException` на `rpc.magicblock.app`, задокументована ще в
оригінальному task-6-звіті); ручний прогін 0-SOL онбордингу перенесено в Task 11. Наскрізна
верифікація логіки виконана натомість через `tests/er`-скрипт з реальним TEE/relayer
(деталі — task-6-звіт, розділ "Fix round 1").

## Task 7: Scheduler `i64::MAX` на devnet — застосовано, і нова знахідка (ліквідації без relayer — FAIL)

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-7-report.md`. Тех-борг №18
(§7.1) закривається **частково**: `i64::MAX`-планувальник — робочий mark-backstop, але не
ліквідаційний backstop (нова архітектурна знахідка, не гіпотеза).

**`scripts/admin/schedule-eternal.ts`** (новий, аналог `schedule-crank.ts` з `iterations =
9223372036854775807`): `Config.scheduler_signer` вже дорівнював `crank_signer_pda(admin)`
(з тижня 2, `set_scheduler_signer` не знадобився), `schedule_crank` над тим самим детермінованим
`task_id -8632762600545312817` — **прийнято з першої спроби**, sig
`2rF82FDokgMurrZTNqvG9DkDjXZh3tjvoczEZw7tG79XH1Go4984McYeg2C7c2bGT8n6EntsNfX8WiXE8FDQy3ER`.
Вбудований 60-секундний пруф: 11 семплів `Market.mark`/`mark_slot`, 11 різних слотів
(`339119462 → 339125562`), монотонно.

**M-G (relayer crank вимкнено через новий `CRANK_ENABLED`, default `true`):**

| Крок | Дія | Результат |
| --- | --- | --- |
| 1 | `railway variable set CRANK_ENABLED=false` + редеплой (`db16e79e…`) | `/healthz.crankEnabled:false` |
| 2 | поллінг `/healthz` ~70 с | `tick` стояв на `0` (relayer-петля не стартувала), `schedulerActive:true` безперервно — **PASS `scheduler ticks without relayer`** |
| 3 | `05-crank-liquidation.ts` (свіжий трейдер, ~9.09× long, `set_params(mmr_bps=9500, imr_bps=9600)`, поллінг `liq_ticks` 90×1 с) | `liq_ticks` плаский `0` усі 90 семплів — **FAIL `scheduler liquidates without relayer`** |
| 4 | `railway variable set CRANK_ENABLED=true` + редеплой (`47ff81f6…`) | `crankEnabled:true`, `schedulerActive:null` (задумано — не атрибутовано, поки власний crank теж увімкнений), `tick` знову росте |

**Крок 3 — root cause архітектурна, не таймінгова.** `ScheduleCrank`
(`programs/dexxer_core/src/instructions/crank.rs`) реєструє заплановану `crank_tick`-задачу
з **фіксованим** набором акаунтів, без `remaining_accounts` — список акаунтів Magic Actions
задачі не можна поповнювати кандидатами ліквідації на кожен тік, він застигає в момент
`schedule_crank`. Код прямо документує це в коментарі до `ScheduleCrank`: «carries NO
remaining_accounts (liquidation candidates are supplied by the fallback script's own
`crank_tick` calls, not by the scheduler)». Отже запланований тік завжди виконується з нулем
кандидатів `[Position, UserAccount]` — рухає лише `Market.mark`/EMA, ніколи не оцінює й не
ліквідовує жодну позицію, скільки б не чекати. Підтверджено емпірично: `Position.liq_ticks`
(мав би зрости на будь-якому тіку, що взагалі оцінив цю позицію, задовго до 2-тікового
гістерезису) лишався рівно `0` усі 90 секунд поллінгу, попри позицію, форсовану на ~19× понад
95%-й `mmr_bps`. Позицію безпечно відновлено (`set_params`-відкат, sig `39riRACXRoA8Bi…`,
`restoredOk: true`) — лишається нешкідливим тестовим сміттям, як інші стари позиції в
`docs/deployments.md`.

**Field-for-field звірка (fix round 1, декодовано з Borsh-даних обох `set_params` tx напряму,
`solana confirm -v`, і перевірено live-читанням `Market` через `teeConn(crank)` після задачі):**

| Поле | До | Форсовано (`234nfZt…`) | Відновлено (`39riRACX…`) | Live зараз |
| --- | --- | --- | --- | --- |
| `imr_bps` | `1000` | `9600` | `1000` | `1000` |
| `mmr_bps` | `500` | `9500` | `500` | `500` |

Решта 13 полів `MarketParams` незмінні на всіх чотирьох колонках (`set_params` завжди пише
повний struct; форсована й відкатна tx кожна передала копію оригіналу з різницею лише у двох
полях вище). Повна таблиця — `docs/deployments.md`'s «Scheduler (Task 7)» розділ.

**Наслідок для дизайну:** §2.5.2's формулювання «падіння Railway → ліквідації йдуть у TEE самі»
було хибним припущенням — виправлено в спеці (§2.5.2, §7.1 №18). `i64::MAX`-планувальник —
чистий mark/EMA-backstop (закриває №18 у цій частині), ліквідаційний backstop без зовнішнього
процесу лишається нереалізованим (потребує або реєстру кандидатів у програмі, яку планувальник
міг би прочитати сам, або підтримки `remaining_accounts` у Magic Actions — пост-MVP, §2.4.5).

**Relayer (`services/relayer`):** новий env `CRANK_ENABLED` (default `true`) — `false` пропускає
`startCrank` цілком; `/healthz.ok` більше не залежить від стейлнесу тіку, коли crank навмисно
вимкнений (`ok = !crankEnabled || !stale`). Новий `src/marketWatch.ts` — неавтентифіковане
читання публічного `Market` на ER (байтове порівняння акаунта раз на 2 с), незалежне від
`cfg.crank`'s TEE-токена; керує `getSchedulerActive`/`computeSchedulerActive` (`health.ts`):
`null`, доки `CRANK_ENABLED=true` (не атрибутовано — і relayer, і scheduler можуть рухати
`Market`); `true`/`false` (вікно 10 с) лише коли `CRANK_ENABLED=false`. 8 нових unit-тестів
(`computeSchedulerActive` + `crankEnabled`'s ефект на `ok`), `services/relayer` **60/60**
(було 52), `tsc --noEmit` чисто в `services/relayer` і `scripts`.

**Баланси:** `devnet-admin` `0.2507278 → 0.4007278` (дозарядка +0.15 SOL з `payer`, sig
`3Lby7PHhrYwpD7yFgcfT8q1XHYqK9NZY1ujbje9n7BobVaeo6jSH1zKodydpmqMsPXFW1boxjR3vqmUNDbZpU1dt`)
`→ 0.3507228 SOL` (після `schedule_crank` + 2× `set_params`). `payer`
`5.221662297 → 5.071657297 SOL`. Railway `crank`/`fee_payer` баланси не змінились за час
вимірювання (`0.1`/`0.202817912 SOL`).

Доки оновлено: `docs/deployments.md` (новий розділ «Scheduler (Task 7)»), spec §7.1 №18,
spec §2.5.2, `CLAUDE.md`'s рядок про планувальник — усі узгоджено відображають «застосовано,
mark-backstop так, ліквідаційний backstop ні».

## Task 8: дизайн-токени, UI-примітиви, 5-табовий layout (короткий підсумок)

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-8-report.md`. Комміт `51579fa`.
`app/scripts/gen-tokens.ts` (`npm run gen:tokens`) читає `docs/design/tokens.json` → генерує
`app/src/theme/tokens.ts` (детерміновано, форматовано Prettier). IBM Plex Sans/Mono (`@expo-google-
fonts/*`), `useTheme()` (dark-only, без light mode). 12 UI-примітивів (`Button, Input, Segment,
LeverageSlider, Card, Row, Badge, Sheet, Toast, Skeleton, EmptyState, Address`). Нові таби
**Trade · Positions · History · Ledger · Account**; Developer-екрани (Onboard/Position/Demo/Spikes/
UI gallery) переїхали в Account → Settings. Гаунтлет чистий (`tsc`, `expo lint`, `prettier`).
Емулятор — не запускався агентом (правило).

## Task 9: клієнтський шар даних — `accountSubscribe`-first `useLiveAccount`, indexer-клієнт, History одразу

**Спайк `accountSubscribe` на TEE (виконано контролером до задачі, 23.09.2026):**
`accountSubscribe` через `wss://devnet-tee.magicblock.app?token=<member-токен>` **працює**
і для публічних (`Market`), і для permissioned акаунтів — 72 нотифікації за 25 с. Ключовий
наслідок: TEE шле нотифікацію на кожен ER-слот **незалежно від того, чи змінились байти
акаунта** — push сам собою не є сигналом "щось змінилось". `useLiveAccount` (`app/src/lib/
live.ts`) тепер звіряє сирі байти (`Buffer.equals`) перед `decode`/`setState` на КОЖНОМУ push
і на кожному fallback-полі; колишній безумовний 1 с-пол (Task 8) став fallback-лише: пол на
2 с, тільки поки жоден push не прийшов за останні 5 с, або якщо сам `onAccountChange`-subscribe
впав синхронно (той самий сценарій, що й раніше — `try/catch` навколо підписки).

**Файли:**
- `app/src/lib/live.ts` — `useLiveAccount` переписано на диф-перед-setState + push-first/
  poll-fallback (вище)
- `app/src/lib/status.ts` (новий) — `disclosureStatus(record, slot, hasCommitmentOnL1?)` /
  `formatSlotsAsTime(n)`, з state machine `Position.closed` → `commit_aggregate` (
  `write_commitment`, `commitment_written=true`) → `mark_committed` (crank, переносить у
  `DisclosureQueue`) → `due_reveals`/`write_disclosure` (L1 `Disclosure`), звірено з поточним
  `programs/dexxer_core/src/{instructions/{commit,disclosure},state/{position,disclosure}}.rs`
- `app/src/lib/indexer.ts` (новий) — `useMark`/`useCandles`/`usePoolHistory`/`useDisclosures`/
  `useRootLatest` (react-query REST) + один спільний модульний WS (`RELAYER_URL`'s `/ws`,
  reconnect з експоненційним backoff, кап 15 с) патчить кеш на `mark`/`pool`/`disclosure`-фрейми;
  `useIndexerConnected()`
- `app/src/lib/program.ts` — `DecodedPosition` отримав поле `closed: DecodedClosedRecord | null`
  (декодування `Position.closed: Option<ClosedRecord>` за фіксованим offset тега; `bump` після
  нього лишається недекодованим — Borsh-offset після `Option` не фіксований)
- `app/src/features/history/HistoryScreen.tsx` — третє джерело `useLiveAccount(conn, position,
  decodePosition)`: `state==='Closed' && closed` рендерить рядок `committing`/`committed`
  негайно, до першого `commit_aggregate`; два `setInterval`-поли (слот 2 с, revealed 5 с)
  замінено на react-query `useQuery`
- `app/src/features/trade/TradeScreen.tsx` — 2 с-пол `readPosition`/`readMarket` замінено на
  `useLiveAccount` для обох акаунтів; ручний `refresh()` після open/close прибрано — push
  наздоганяє сам

**Рішення (merge key):** три джерела History (`Position.closed`, `DisclosureQueue.records`,
L1 `Disclosure`) взаємовиключні в часі (`mark_committed` одночасно спорожняє `Position.closed`
і заповнює чергу; `due_reveals` одночасно спорожняє чергу й пише `Disclosure`) — дедуп не
потрібен, рядки просто конкатенуються. Матчинг із L1 лишається за хешем (Task 8b, ruling 9),
не за `nonce`; хеш тепер персистується і з `Position.closed`, і з чергою (раніше — лише з черги).

**Рішення (L1-дані для History лишаються прямим читанням, не `indexer.ts`):** `useDisclosures()`
з нового `indexer.ts` — публічна, пагінована, Postgres-backed стрічка з нижнім `side`
(`'long'`/`'short'`, не `'Long'`/`'Short'` — див. `services/relayer/src/indexer/accounts.ts`'s
`sideToString`) і без гарантії роботи (`INDEXER_ENABLED` може бути `false`). "Чи розкрилась
САМЕ моя угода" лишилось точним `pdas.disclosure(hash)`-читанням через `baseConn`, просто
обгорнутим у react-query (`refetchInterval: 5000`) замість hand-rolled `setInterval` —
коректність не приносилась у жертву формі.

**`indexer.ts`'s WS:** один модульний singleton (лічильник монтованих споживачів), стартує при
першому хуку, ніколи явно не закривається при 0 споживачах (дешево тримати відкритим при
переходах між табами; тільки перестає плекати reconnect-спроби) — reconnect: `1000 * 2^attempt`,
кап 15 000 мс, скидається на `open`.

**Гаунтлет:** `cd app && npx tsc --noEmit` чисто; `npm run lint:check` чисто (один
`react-hooks/set-state-in-effect` у `indexer.ts` — той самий "реконсиляція з зовнішньою
системою на маунті" патерн, що вже є в `live.ts`/`useTradeSession.ts`, задокументовано
inline-коментарем, той самий `eslint-disable` спосіб). Тест-раннера в `app/` нема (перевірено
`package.json`) — для чистих модулів (`status.ts`) додано `__DEV__`-guarded self-check
(`assertDisclosureStatusSelfCheck`), той самий патерн, що `program.ts`'s `assertLeafGolden`/
`assertCommitmentGolden`; продубльовано й запущено окремо через `node` — всі кейси PASS.
Емулятор/on-device — не запускався агентом (`docs/superpowers/plans/...`'s правило); ручний
чек-лист — у `task-9-report.md`.

## Task 10: екрани застосунку за макетами Claude Design (короткий підсумок)

Повний звіт: `.superpowers/sdd/2026-09-22-week4-mvp-polish/task-10-report.md`. 7 коммітів
(`e12fce3`..`39f7782`) + fix round 1 (`2b306e0`). Bigint-порт `math.rs` у `app/src/lib/math.ts`
(`notional`/`fee`/`requiredMargin`/`liqPrice`/slippage-ліміти), `__DEV__`-самоперевірка проти
`math.rs`'s власних `#[cfg(test)]`-векторів — усі 5 збіглись. Шість екранів переписано на
`ui/*`-примітиви: **Trade** (SVG-графік без бібліотеки, Long/Short тікет, слайдер плеча),
**Positions** (жива uPnL, Increase/Decrease sheets, дистанція до ліквідації), **Ledger** (без
гаманця — три таби лише на `indexer.ts`), **Account** (Deposit/Withdraw/Receipt/Exit-чек-лист),
**Onboard** (3-крокова `batchOnboarding.ts`-пачка, копі-фікс контролера: «rent сплачений, ≈0.004
SOL на делегування» замість «SOL не потрібен»), **History** (рестайлінг, `Position.closed`/
`DisclosureQueue`/L1 `Disclosure` — логіка тижня 9 не чіпалась). Гаунтлет чистий (`tsc`,
`expo lint`, `prettier`). Fix round 1 (контролер): `TradeScreen.tsx`'s три незалежні
stale/disconnected-перевірки об'єднано в один `oracle`-предикат (dot/banner/gate більше не можуть
розійтись); видалено невикористаний `account-feature.tsx`. Емулятор — не запускався агентом.

## Підсумок тижня 4

Гілка `week4-mvp-polish`, база `93cb8ee` (week 3 фінал) → **29 коммітів** до
`2b306e0` (поточний HEAD цього документа). Зроблено: `PoolLive`+знімок (ризик #24 закрито),
devnet-редеплой+міграція (M-F), `services/relayer` на Railway (crank+індексер+`/sponsor`),
sponsored rent онбординг (Task 6, частково закриває ризик #22), scheduler `i64::MAX` на живому
розкладі (ризик #18 закрито як mark-backstop), дизайн-токени+UI-примітиви+5 табів, клієнтський
`accountSubscribe`-шар, шість екранів за макетами Claude Design.

**Тести:** unit `dexxer_core` **55/55** (було 51), LiteSVM `dexxer_litesvm` **71/71** (було 65),
`services/relayer` **27/27** (нові цього тижня). `tsc --noEmit`/`expo lint`/`prettier --check` чисті
в `app`, `tests/er`, `scripts`, `services/relayer`.

**Живі URL:** relayer/індексер `https://relayer-production-1ae7.up.railway.app` (`/healthz`,
`/mark`, `/prices`, `/pool/latest`, `/disclosures`, `/root/latest`, `wss://…/ws`); devnet-tee
`https://devnet-tee.magicblock.app`; base RPC `https://rpc.magicblock.app/devnet`; програма
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` (детальніше — `docs/deployments.md`).

**Паркований залишок (тиждень 5+):**
- ER-леґ онбордингу лишається owner-funded (`delegate_user`'s CPI не приймає `fee_payer`,
  TEE `InvalidAccountForFee`) — реальний мінімум ≈0.0033–0.0035 SOL, не нуль (Task 6).
- `delegate_user` rent — не досліджено окремо (потребує Delegation Program CPI-дослідження).
- Планувальник `i64::MAX` — mark-backstop, НЕ ліквідаційний backstop; ліквідації лишаються
  повністю залежними від `services/relayer`/`crank-fallback` (Task 7, ризик #18 звужений).
- Oracle-стейлнес в індексері рахується за часом прийому (ingestion time), не за `posted_slot`'s
  block time — прийнятно для rolling-архіву, не для точного леджера (Task 5).
- `PositionScreen.tsx` (стара, легасі) — досі має хардкоджений hex і прихований route, не
  переписана під токени (поза скоупом Task 10, ще існує як dev-посилання).
- `HistoryScreen.tsx` — 456 рядків, рестайлінг Task 10 не рефакторив структуру файлу, лише JSX.
- Anonymity set при `PoolLive`-знімку (ризик #24) — differencing на кроці 100 dUSDC при малому
  числі одночасних трейдерів лишається відкритим; повне рішення — ZK-знімок (§2.4.5, пост-MVP).
