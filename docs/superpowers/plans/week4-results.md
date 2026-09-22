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
