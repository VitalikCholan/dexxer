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

**Справжній Rust-баг, знайдений і виправлений (окремо від фандинг-саги):**
`InitPoolLive.pool: Account<'info, Pool>` відхиляв уже делегований на devnet `Pool` з
`AccountOwnedByWrongProgram` (0x0bbf/3007) — `Pool` делегований ще з тижня 1–3, тому власник на L1
уже Delegation Program, а не `dexxer_core`. Виправлено: `pool` → `UncheckedAccount<'info>` +
ручна `Pool::try_deserialize` (перевірка дискримінатора, без перевірки власника), seeds обох
(`pool`, `pool_live`) — з `config.dusdc_mint` замість самопосилального `pool.mint`. Це реальний,
загальний фікс, потрібний для будь-якої майбутньої devnet/mainnet-міграції, де `Pool` уже
делегований до появи `PoolLive`.

### Сага фандингу `init_market_permissions` (6 спроб, усі відхилені)

`market_risk` (тиждень 1) і свіжостворений `pool_live` мають на devnet **точно свій rent-exempt
мінімум, без надлишку** (965,200 і 1,107,440 lamports відповідно) — self-funding CPI (як у
`InitPermissions`) падає з `InsufficientFundsForRent`. Шість різних механізмів фандингу
випробувано й відхилено кожен своєю реальною помилкою (повний trail у doc-коментарі
`InitMarketPermissions` в `instructions/user.rs`):

| # | Підхід | Результат |
|---|---|---|
| 1 | Self-funding (оригінальний код Task 2) | `InsufficientFundsForRent` (рівень транзакції, надлишку нема) |
| 2 | `admin` платить напряму як `mut` CPI-payer у CPI в Permission Program | `InvalidWritableAccount` |
| 3 | Окремий `fee_payer` (== `Config.fee_payer`, доведений як ER-tx-payer через `commit_aggregate`) + `admin` як додатковий підписант | `InvalidAccountForFee` |
| 4 | Caller-side plain `SystemProgram.transfer`, топап перед `init_market_permissions` | `InvalidAccountForFee` — підтверджено окремо: **будь-яка** сира, клієнтом надіслана `SystemProgram`-only інструкція відхиляється цим ER, навіть у пакеті з робочим `commit_aggregate` |
| 5 | `admin` позначений `mut`, CPI-переказ ЗСЕРЕДИНИ інструкції (не сира клієнтська) | Знову `InvalidAccountForFee` — правило: fee payer транзакції ніколи не може бути `mut` на рівні інструкції в цьому ER, незалежно від того, що він фінансує |
| 6 | Прямий lamport-переказ (`try_borrow_mut_lamports`, без CPI взагалі — підручниковий спосіб пересунути lamports між двома PDA, якими володіє програма) з делегованого `fee_escrow` | `UnbalancedInstruction` — відтворено і як цикл на 2 акаунти, і як ізольована пара дебет/кредит; корінь не встановлено в межах бюджету задачі |

Жоден інший делегований акаунт на цьому devnet теж не має надлишку — `Pool`/`Market`/
`BalancesRoot` виміряні точно на своєму rent-exempt мінімумі (1,310,640 / 1,300,480 / 11,176,000
lamports, надлишок 0 у кожного).

**Фінальний стан:** `init_market_permissions` повернуто до простого self-funding виду (байт-в-байт
той самий список акаунтів, що й у Task 2 — жодних `fee_escrow`/`system_program`), з
tolerate-логікою для CPI-помилок (`msg!`, без propagate) — але це не рятує від
`InsufficientFundsForRent`, бо це `TransactionError` (перевіряється рантаймом ПІСЛЯ виконання всієй
транзакції), а не програмний `Result`. Реальний фікс — на боці **клієнта**: `admin.ts`'s
`bootstrapDevnet()` обгортає виклик у try/catch, логує попередження, продовжує — решта bootstrap
(включно з двома критичними кроками міграції) завершується попри це.

**Наслідок:** на цьому devnet `MarketRisk`/`PoolLive` лишаються публічно читаними в ER (ризик #24
не закрито) — відкритий пункт для тижня 5.

### M-F (`tests/er/devnet/09-pool-snapshot.ts`)

Також знайдено й виправлено (не пов'язано з фандинг-сагою): цієї сесії devnet SOL faucet
вичерпав rate-limit — `requestAirdrop` підтверджував транзакцію, але доставляв **0 lamports**, що
каскадом ламало `onboardTrader`'s `getOrCreateAssociatedTokenAccount`
(`TokenAccountNotFoundError`). Виправлено: свіжий M-F-трейдер попередньо фондується 3 SOL з
deploy-payer'а (`spikes/keys/payer.json`, devnet-only, без реальної вартості) — `onboardTrader`'s
власна перевірка балансу бачить достатньо й пропускає (зламаний) airdrop-шлях.

| Крок | Результат | Сигнатура |
|---|---|---|
| (a) `Pool` незмінний на base+ER (crank) навколо `open_position` | **PASS** | `open_position`: `jst7tAh6ro6Lo3DSsG7Fhhkhxngg8kmYgkWAGA6aSm4Wgz78FGYA5VMQfzXK9U9Q89FnrxAkgCK5NqsaGxFbKas` |
| (b) `PoolLive.locked_total` (crank) зріс рівно на маржу | **PASS** — 80,000,000 → 100,000,000 (Δ 20,000,000 = 20 dUSDC) | (той самий open) |
| (c) `PoolLive` через stranger TEE-конекшн → відмова/null → PASS «M-F private live aggregate» | **FAIL** — читання УСПІШНЕ (весь акаунт видно); причина — `init_market_permissions` так і не запермішнив `PoolLive` (сага вище) | — (читання) |
| (d) `commit_aggregate` → заокруглений знімок `Pool` | **PASS** — `locked_total=100,000,000` (÷1e8=0), `committed_locked(100M) ≥ live(100M)`, `committed_capital(21.1B) ≤ live(22.1B)` | `commit_aggregate`: `72T9b1DcRqLD8C9PgjC5fKEGy92koA6shCkHFufCx9T3tMERmok8MQWBoDKNW59WqoppaNcoPZyprvouCV87xS9` |
| (e) `MarketRisk` через stranger — інформаційно | **FAIL** (інформаційно, за брифом) — та сама причина | — (читання) |

Підсумок скрипту: `09-POOL-SNAPSHOT FAIL` — чесний результат: (c) — жорсткий гейт M-F за брифом, і
він реально не проходить на цьому devnet із задокументованої причини (не баг тесту). Скрипт сам
по собі повністю робочий: усі сигнатури, усі перевірки виконуються коректно; (c)/(e) автоматично
стануть PASS, щойно ризик #24 буде закрито — жодних змін у скрипті не знадобиться.

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

### Баланси після

| Ключ | Роль | До сесії | Після |
|---|---|---|---|
| `spikes/keys/payer.json` | deploy authority | 6.073550713 SOL | 2.338419953 SOL |
| `devnet-admin` | bootstrap admin | 0.40487656 SOL | 0.3513628 SOL |
| `devnet-crank` | crank identity | 0.1 SOL | 0.1 SOL (не чіпали) |
| `devnet-fee-payer` | ER commit fee payer | 0.25 SOL | 0.25 SOL (не чіпали — вартість 12 коммітів списана з `FeeEscrow`, не з цього гаманця) |

Витрата payer (~3.735 SOL): ~0.666 SOL — разовий extend; 3 SOL — префандинг M-F-трейдера
(devnet-only, лежить у `tests/er/.keys/devnet-snapshot-<runId>.json`, не повернуто — не має
реальної вартості на devnet); решта (~0.07 SOL) — сумарні tx fees за 9 редеплоїв і кілька
позич/поверни циклів із `devnet-admin` (кожен редеплой повністю повертав buffer rent через
`solana program close` або успішний upgrade — жоден деплой не лишив чистого збитку SOL, крім fees).

## Гаунтлет (фінальний стан)

- `cargo fmt --all -- --check` → 0.
- `cargo clippy -p dexxer_core -- -D warnings` → чисто.
- `cargo test -p dexxer_core` → **55/55** (без змін відносно Task 2).
- `cargo +nightly-2026-09-18 test -p dexxer_litesvm` → **71/71** (без змін відносно Task 2).
- `mcp__solana-mcp-server__program_autofixer` — чисто на кожній зміненій ділянці, кожен раунд.
- `anchor build` — чисто (лише попередній `syn`/`anchor-syn` шум, не стосується `dexxer_core`).
- `npx tsc --noEmit`: `tests/er`, `scripts`, `app` — усі чисті.
- IDL: `target/idl/dexxer_core.json` скопійовано в `app/src/idl/dexxer_core.json`, `cmp` — identical.

## Concerns / відкрите для тижня 5

1. **Ризик #24 (публічні `MarketRisk`/`PoolLive` в ER) лишається відкритим на devnet.** Шість
   механізмів фандингу випробувано й відхилено. Наступні кроки: (a) запит до MagicBlock — який
   санкціонований спосіб профінансувати rent НОВОГО `EphemeralPermission`-акаунта для ВЖЕ
   делегованого PDA без надлишку; (b) для майбутнього СВІЖОГО деплою — дати `market_risk`/
   `pool_live` L1 prefund-запас при створенні (за зразком `init_user`'s `extra`-переказу), ДО
   першої делегації — знімає проблему для нових деплоїв, але не для `market_risk` тут (делегований
   ще з тижня 1, шляху undelegate немає).
2. **`UnbalancedInstruction` на прямому lamport-переказі між двома делегованими PDA не пояснено.**
   Це стандартний, підручниковий Solana-патерн — і він падав на цьому конкретному ER-валідаторі з
   причини, не встановленої в межах бюджету задачі. Варта окремого питання в підтримку MagicBlock.
3. **Devnet SOL faucet зараз rate-limited** для IP цієї сесії. Будь-який майбутній devnet-скрипт,
   що покладається на `onboardTrader`'s вбудований airdrop-шлях, потребуватиме того самого
   обхідного префандингу (або чекати на скидання ліміту).
4. `09-pool-snapshot.ts` повністю робочий і автоматично покаже PASS для (c)/(e), щойно ризик #24
   буде закрито — він перевіряє реальний on-chain стан (власника permission-PDA), а не вважає
   успіхом відсутність кинутої помилки.
