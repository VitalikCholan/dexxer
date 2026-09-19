# Dexxer MVP — дизайн-специфікація

**Дата:** 18 вересня 2026 · **Статус:** затверджено в брейнштормі, до написання плану імплементації
**Ціль:** приватний мобільний перп-DEX для Seeker на devnet — власне перп-ядро з позиціями в MagicBlock Private Ephemeral Rollup (PER).
**Дедлайни:** Colosseum 28.09–02.11 · Solana Mobile CLOCK IN (уточнити).
**Формат:** соло, monorepo, дві подачі.

Цей документ **замінює** розділи `dexxer-plan.md` (календар, скоуп) і `dexxer-architecture.md` §2.1 там, де вони розходяться. При розходженні з кодом перемагає код.

---

## 0. Рішення: Опція A — власне ядро на шаблоні MagicBlock

### 0.1 Що обрано

Anchor 1.0.2 + `ephemeral-rollups-sdk` 0.16.2 (features `anchor`, `access-control`). Старт із engine-examples `private-counter`, `binary-prediction`, `session-keys`, `sealed-auction`, `oracle-priced-purchase`, `crank-counter`, `magic-actions`, `delegation-actions`, `ephemeral-account-chats`. Перп-математика — своя, формули з `solana-labs/perpetuals` (Apache-2.0, аудит-звіт як список edge-cases), інваріанти — з Percolator (Kani-властивості → proptest). Пул — власний тестовий капітал.

### 0.2 Чому не інші варіанти (перевірено по живих репозиторіях 18.09.2026)

| Варіант | Факт | Вердикт |
|---|---|---|
| Омнібус над Jupiter Perps (план v2) | Jupiter Perps немає на devnet; лише mainnet/Surfpool з емульованим keeper. Потрібні request state machine, двошарова ліквідація, ADL-розподіл, contention на омнібус-PDA. PER потрібен усе одно. NEAR × Hyperliquid уже зайняли клітинку | Ні для MVP. Jupiter — адаптер ліквідності у v1 |
| Форк Percolator | Per-user portfolio — окремий акаунт (делегується); base-unit колатераль; Apache-2.0; Kani. Але Pinocchio/Anchor v2, власний оракульний шлях (AuthMark/EwmaMark), делегації нема — треба дописувати в чужий код через `ephemeral-rollups-pinocchio`; market-акаунт гарячий. ~2 тижні до першого трейду | Джерело інваріантів, не база |
| `solana-labs/perpetuals` | Archived 13.01.2025; Anchor **0.28.0**, solana-program 1.16.9, `pyth-sdk-solana` 0.8.0 (застарілий), `init-if-needed`. `/audit` є | Формули + аудит-звіт як тест-вектори |
| Flash `flash-perpetuals` | **Репо не існує.** Публічно лише SDK (`flash-sdk-rust`, `examples-v2` MIT, `session-keys` форк MagicBlock, `magicblock-grpc-example`) | Доказ «перп + MagicBlock у проді»; референс session-keys |
| Adrena | `AdrenaFoundation/perpetuals` archived 04.09.2024, 90 комітів, форк solana-labs. Живий контракт закритий | Викреслено |
| Drift `protocol-v2` | Archived 03.09.2026 → `velocity-exchange/protocol-v2`; Anchor 0.29 | Довідник ліквідацій; доступний через Solana MCP |
| Brute | Публічний, **LICENSE відсутній** → all rights reserved | Референс форми; код не брати |
| Syntx | Apache-2.0, Anchor 0.30.1, VenueAdapter (6 методів), адаптери Percolator/Jupiter Perps/Phoenix, 32+ LiteSVM | Референс для Jupiter-адаптера у v1 |
| Mango v4 | Anchor, ризик-двигун health/liquidation | Довідник, свіжіший за Drift |

### 0.3 Що devnet-MVP доводить і не доводить

**Доводить:** позиція фізично невидима на публічному L1 і для не-member'ів через ER RPC (реальний TDX на `devnet-tee-as.magicblock.app`); один тап через session keys; MWA/Seed Vault на Seeker; ліквідаційний crank у TEE за Pricing Oracle; розкриття постфактум через Magic Actions; публічний агрегат пулу.

**Не доводить:** реальну ліквідність і комісії (тестовий мінт, свій пул); anonymity set (тестери — одиниці); атестацію коду валідатора (allowlist MRTD/RTMR — v1); поведінку під корельованим навантаженням; SLA ER.

### 0.4 Формулювання приватності (однакове скрізь)

Приватність від трекерів, копі-ботів, мисливців за ліквідаціями і від нас. **Не** від Intel і не від оператора валідатора MagicBlock. Апаратна гарантія, не криптографічна. `verifyTeeRpcIntegrity` перевіряє справжність TDX-квоти, але не порівнює MRTD/RTMR з allowlist коду — ця перевірка є окремою роботою v1.

> «Hyperliquid ховає нічого. NEAR × Hyperliquid ховає *хто*. Dexxer ховає *що*.»

---

## 1. Скоуп MVP

### 1.1 Є

- **Ринок:** один, SOL-PERP. BTC/ETH — акаунти `Market` у конфігу, вимкнені.
- **Колатераль:** власний devnet-мінт `dUSDC` (6 decimals), фаусет у застосунку. Кастоді через Ephemeral SPL Token: токени в Global Vault на L1, у ER — лише pool eATA.
- **Маржа:** isolated; одна позиція на `(user, market)`, лонг **або** шорт; переворот = close + open. Плече 1–10x.
- **Дії:** `open`, `increase`, `decrease`, `close`, `add_margin`. Тільки market-ордери за mark; slippage-параметр перевіряє програма.
- **Ціна:** Pricing Oracle (Pyth Lazer SOL/USD) у TEE. Mark = EMA(index), рахує crank. Перевірки на кожне читання: feed id, `posted_slot > 0`, staleness ≤ 2 с, confidence, deviation index/mark.
- **Пул:** один `Pool`, контрагент усіх трейдів. OI cap, max position, utilization cap. Коміт на L1 фіксовано кожні 5 хв: сумарний колатераль + coverage-бакет, без розбиття на сторони.
- **Комісії:** open/close 6 bps у пул. Liquidation fee 100 bps.
- **Ліквідація:** crank у ER (High-precision Scheduling), тригер `equity < MMR × notional` за mark з гістерезисом 2 тики, повна. У тому ж потоці tx, що планові дії.
- **Приватність:** усі акаунти нашої програми в ER — permissioned. `Position` — `is_private`, members `[owner, session_key, crank]` (crank подає ліквідаційні tx, тому member), нуль комітів до закриття. `UserAccount` комітить лише `free_margin`, `locked_margin`.
- **13F:** при закритті — Magic Action `write_commitment(nonce, sha256(record ‖ salt))`; після `reveal_after_slot` crank пише `Disclosure`. Затримка — параметр (демо: хвилини; продукт: 30 днів).
- **Гаманець:** MWA — один підпис на онбординг (fallback два); далі session key. Fee payer наш.
- **Мобільний:** Expo/Android. Connect → Onboard/Deposit → Trade → Position → History → Settings. Локальні push без сервера.
- **Бекенду нема.** Приватне — з TEE напряму; публічне — з devnet RPC. Crank — у ER, fallback-скрипт зовні.
- **Trustless exit:** `close` + `withdraw` через ER без нас. При смерті ER — маржа з останнього коміту `UserAccount`; відкрита позиція втрачається (README прямим текстом).

### 1.2 Свідомо ні (v1+)

Hedge mode / кілька позицій на ринок · limit/TP/SL · funding, borrow · часткова ліквідація · нетинг · зовнішній venue-адаптер · compliance gate · бекенд, індексер, WS-сервер · allowlist MRTD · iOS · токен, реферали · Surfpool.

---

## 2. Акаунти й маршрутизація

### 2.1 Матриця акаунтів

| Акаунт | Seeds / власник | Де живе | Коміт на L1 | Приватність в ER | Нотатка |
|---|---|---|---|---|---|
| `Config` | `[b"config"]`, dexxer_core | L1 | — | публічний | admin, crank, paused, oracle program, tee_validator |
| `Faucet` | `[b"faucet", owner]`, dexxer_core | L1 | — | публічний | rate-limit N dUSDC/добу |
| `dUSDC` mint | mint authority = PDA dexxer_core | L1 | — | публічний | 6 decimals |
| `Market` | `[b"market", b"SOL"]` | делегований у TEE | при зміні параметрів | permissioned `[crank, admin]` | параметри, mark-EMA, paused_open |
| `MarketRisk` | `[b"risk", market]` | делегований | **ніколи** | permissioned | OI long/short, бакети ліквідації |
| `Pool` | `[b"pool", dUSDC]` | делегований | **фіксовано 5 хв** | permissioned | capital_total, locked_total, fees, insurance, bad_debt_total |
| `UserAccount` | `[b"user", owner]` | делегований | фіксовано 5 хв, усі разом | `[owner, session, crank]` | free_margin, locked_margin, session_key, expiry, actions_left, nonce. **Витік:** `locked_margin` з гранулярністю 5 хв = верхня межа позиції. Прийнято для MVP |
| `Position` | `[b"position", owner, market]` | делегований | **нуль до закриття** | `is_private`, `[owner, session, crank]` | створюється раз при онбордингу; при закритті обнуляється; undelegate лише при виході після скрабу |
| `DisclosureQueue` | `[b"dq", owner]` | делегований | **ніколи** | `[owner, crank]` | кільце N `ClosedRecord` до reveal |
| Pool eATA | eSPL program | делегований (eSPL) | за eSPL | публічний баланс пулу | єдиний токен-акаунт у ER |
| User eATA | eSPL program | транзитно | — | — | існує лише в момент депозиту/виводу |
| Global Vault dUSDC | eSPL program | L1 | — | публічний | реальні токени всіх |
| Oracle feed SOL/USD | `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` | доступний у TEE | — | публічний вхід | — |
| `DisclosureCommitment` | `[b"commit", nonce]` | L1 | пише Magic Action | публічний хеш | без owner у seeds |
| `Disclosure` | `[b"disclosure", nonce]` | L1 | Magic Action після reveal | публічний | `sha256(Disclosure ‖ salt) == commitment` |
| `FeePayer` + `magic_fee_vault` | наш делегований payer | ER / L1 | — | — | оплата комітів; топ-ап `lamportsDelegatedTransferIx` |

**Два правила, що роблять приватність структурною:**

1. Жоден акаунт із полями позиції не має commit-policy до закриття. `Market`/`Pool` не містять per-user даних. `MarketRisk` і `DisclosureQueue` не комітяться взагалі.
2. Маржа — **облік, не токени.** `open`/`close`/`add_margin` не торкаються жодного токен-акаунта, лише приватних PDA. Токени рухаються тільки на депозиті й виводі, які й так публічні на L1. Причина: eATA належить eSPL-програмі → на ньому не створити `EphemeralPermission`, і трансфер user → pool на кожне відкриття видав би маржу й час.

   *Check 2 (19.09.2026):* eSPL-баланси в ER виявилися owner-scoped уже на рівні RPC — чужий `getAccount` з власним валідним TEE-токеном повертає `null` (`TokenAccountNotFoundError`), тобто токен-акаунт іншого власника невидимий навіть як баланс. Це сильніше за нашу мінімальну вимогу, але **правило лишається незмінним**: приватність маржі не будуємо на цій поведінці eSPL — вона не наша, не документована як гарантія і може змінитися; трансфер на кожне відкриття все одно видав би час дії через метадані tx (§2.3).

### 2.2 Маршрутизація

| Флоу | Підписант | Куди | Що | Відмова |
|---|---|---|---|---|
| Онбординг | owner (MWA, 1 підпис, fallback 2) | L1 | faucet → `init_user` (UserAccount + Position + DisclosureQueue, рента під permission) → `deposit` (eSPL у pool eATA) → `delegate_user` у `tee_validator` з Delegation Actions `create_permission` → session | розбити на 2 tx |
| `credit_deposit` | crank / callback | ER | `free_margin += amount` після підтвердження депозиту на L1 | ризик №1, план Б §7 |
| open / increase / decrease / close / add_margin | session key | TEE ER, token-gated | оракул → маржинальна перевірка → `Position`, `UserAccount`, `MarketRisk`, `Pool` | помилка програми; slippage; paused |
| `crank_tick` | ER scheduler (fallback: наш скрипт) | TEE ER | ~1 с: оракул, mark-EMA, ≤16 кандидатів у `remaining_accounts`, ліквідація | stale → скіп ліквідацій, `stale_ticks++`, після N `paused_open` |
| `commit_aggregate` | crank | ER → L1 | 5 хв: `Pool`, `UserAccount[]`, `Market` при зміні; Magic Actions `write_commitment` для закритих | ретрай; квота через fee vault |
| `mark_committed` | crank | ER | після підтвердження на L1: `ClosedRecord` → `DisclosureQueue`, `Position → Empty` | звірити, що commitment реально записано |
| `reveal` | crank | ER → L1 | `slot ≥ reveal_after_slot` → Magic Action `write_disclosure` | ретрай |
| `withdraw` | owner | ER → L1 | `free_margin −= amount` → eSPL withdraw path | лише free, не locked |
| `undelegate_user` | owner | ER → L1 | `Position.Empty`, `DisclosureQueue` порожня → скраб → `commit_and_undelegate` → close на L1 | `HasOpenPosition` |

### 2.3 Модель витоків

| Канал | Видно | Приховано |
|---|---|---|
| L1 (Solscan) | депозит (гаманець, сума, час), вивід, факт делегації (PDA owner = `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`), 5-хв агрегат `Pool`, `locked_margin` у `UserAccount` (5 хв), commitment-хеші, `Disclosure` після reveal | усе про позицію: ринок, сторона, розмір, entry, PnL, liq price, funding, факт наявності позиції |
| ER RPC не-member | **метадані транзакцій (check 6, 19.09.2026):** `getSignaturesForAddress(PROGRAM_ID)` повертає будь-кому (з токеном і без) повний список підписів програми — `signature`, `slot`, `blockTime`, `err`, `confirmationStatus`; `getTransaction(sig)` по відомому підпису повертає `slot`, `blockTime`, `meta.err`/`status`, `meta.fee`, `computeUnitsConsumed`. Тобто факт, час і успіх дії видно | вміст акаунтів (`getAccountInfo` на permissioned PDA → `null`) і вміст tx: `accountKeys`, `instructions`, `logMessages`, `preBalances`/`postBalances`, token-баланси — усі порожні; `recentBlockhash` занулений |
| eSPL трансфери в ER | тільки депозит/вивід | маржа на open/close |
| Global Vault | сумарний баланс усіх | — |
| Непряме | `вивід − депозит` = PnL за період; `locked_margin × max_lev` = верхня межа розміру | — |

Залишковий витік `locked_margin` можна прибрати комітом `UserAccount` лише при виводі/виході (ціна — втрата locked margin при смерті ER). v1: вибір юзера в налаштуваннях.

**Витік метаданих tx (check 6, 19.09.2026).** `getSignaturesForAddress` по **PDA** повертає порожній масив `[]` — але й власнику теж, тобто ER просто не індексує за адресою PDA; як сигнал приватності цей метод нічого не доводить. Надійний сигнал власник/не-власник — `getAccountInfo` (check 1). Реальний канал — **program id**: він публічний, і його список підписів відкритий усім, разом із таймінгом. Ховати сам факт активності ми не вміємо; ховаємо лише її зміст. Див. ризик №4 у §7.1.

---

## 3. Маржинальна математика й ліквідація

### 3.1 Одиниці

| Величина | Тип | Точність |
|---|---|---|
| Ціна | `u64` | 1e6 |
| Розмір | `u64` | 1e9 |
| Колатераль / notional / PnL | `u64` / `i64` | 1e6 |
| Ставки | `u16`/`u32` | bps |

Проміжні `u128`, `checked_*`, конвертація в `math.rs`. Округлення на користь пулу: комісії й вимоги вгору, виплати вниз.

### 3.2 Формули

```
notional      = size × mark / 1e9
upnl (long)   = size × (mark − entry) / 1e9
upnl (short)  = size × (entry − mark) / 1e9
equity        = margin + upnl − close_fee(notional)
liq_price
  long:  entry × (1 − 1/lev_eff + mmr)     lev_eff = notional / margin
  short: entry × (1 + 1/lev_eff − mmr)
```

Вхід: `margin ≥ IMR × notional`, `lev ≤ max_lev`, `size ≥ min_size`, `OI_side + size ≤ oi_cap`, `notional ≤ max_position`. `increase` — entry як VWAP. `decrease` — залишок ≥ IMR або повне закриття, PnL пропорційно.

### 3.3 Параметри SOL-PERP (в акаунті `Market`)

| Параметр | Старт |
|---|---|
| max_lev | 10x |
| IMR | 1000 bps |
| MMR | 500 bps |
| open/close fee | 6 bps |
| liquidation fee | 100 bps notional |
| oi_cap | 30% капіталу пулу на сторону |
| max_staleness | 2 с — рахувати за ER `Clock` / `publish_time`, **не** за `posted_slot` (check 4, 19.09.2026) |
| max_conf | 50 bps; `conf == 0` = «не заповнено» → hard reject на відкриття (check 4) |
| ema_alpha | під період 1–2 с; фактичний інтервал кранка плаває, див. §3.5 |
| гістерезис | 2 **тики** (не секунди — інтервал тіка не фіксований, check 5, 19.09.2026) |

**Оракул SOL/USD — виміряне (check 4, 19.09.2026).** Feed `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` = PDA із seeds `["price_feed", "pyth-lazer", "6"]` під `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`.

- **Ідентичність фіду — лише через деривацію PDA** від `Config.oracle_program` + seeds. `writeAuthority` у даних акаунта — System Program (`1111…1111`), тобто ніколи не ставиться; як доказ походження він непридатний.
- **`exponent` зберігається як `+8`**, не `−8`: ціна = `price / 10^exponent` (raw `11282999668`, expo `8` → ≈ $112.83). Ніколи не `price × 10^exponent`.
- **`conf` був `0` на кожному читанні** (base і TEE). Нуль трактуємо як «не заповнено», а не як «нульова невизначеність» → жорстка відмова на `open`/`increase`; на закриття й ліквідацію — не блокує.
- **`posted_slot` — це слот ER** (~317 млн проти ~500 млн на L1). Порівнювати його з L1-слотом не можна; staleness рахуємо за ER `Clock` і `publish_time`.
- Розмір акаунта — **134 байти**: 133 за IDL `PriceUpdateV2` (`verificationLevel` = `Full`) + 1 кінцевий байт `0x00` невідомого призначення. Декодування полів до `posted_slot` включно він не зачіпає, але парсер має читати за офсетами, не за довжиною.
- На base devnet той самий акаунт існує, але мертвий (`price = 0`, `posted_slot = 0`, owner — Pyth receiver). Свіжий він **лише всередині TEE** (owner — `PriCems…`, `age = 0 с`).

### 3.4 Mark vs index

Index — Pyth Lazer через Pricing Oracle. Mark — EMA(index) у `Market.mark`, `mark_slot`. Ліквідація за mark; вхід/вихід за index у момент tx + slippage. Deviation guard `|index − mark| > X%` → `paused_open`, закриття дозволені. Компроміс: EMA відстає при тренді → ліквідація пізніше, ніж за index.

### 3.5 Crank

Цикл ~1 с: (1) оракул + валідація; stale → скіп ліквідацій, mark не оновлюється; (2) mark-EMA; (3) кандидати з бакетів `±δ` від mark у `MarketRisk`; (4) `equity < MMR × notional` два тики → `liquidate`: закриття за mark, liq fee у пул, лишок → `free_margin`, `ClosedRecord{Liquidated}`; (5) bad debt → `Pool.insurance`, далі капітал, `bad_debt_total` публічний через коміт; (6) одна форма tx з плановими діями.

Тригер — MagicBlock scheduler; fallback — `scripts/crank-fallback` з ключем `Config.crank`.

**Виміряне на devnet-tee (check 5, 19.09.2026):** при запиті `execution_interval_millis = 1000` за 20 с відбулося **27 тіків** (~740 мс середнього інтервалу, ≈1.35 тіка/с). Тобто запитаний інтервал — це **підлога, не період**: тіки приходять раніше, ніж замовлено, і рівний крок не гарантований. Наслідки, обов'язкові до виконання:

- будь-який гістерезис і будь-яке «через N секунд» — рахувати **в тіках**, а не в секундах; нічого нижче за течією не має права припускати фіксовану дельту між тіками;
- бюджет CU/квот рахувати від **верхньої** межі частоти, а не від запитаної;
- продуктовий `crank_tick` **зобов'язаний** валідувати, що викликач — очікуваний crank signer PDA делегаційної програми (вендорний приклад цього не робить: його `increment` permissionless, будь-хто може викликати ліквідаційну логіку поза чергою);
- у продукту має бути **cancel-шлях** для запланованої задачі — у спайку його не було, задача просто самозавершилася після 30-ї ітерації.

### 3.6 Інваріанти (proptest + LiteSVM)

- `Σ free_margin + Σ position.margin + pool.fees + pool.insurance == pool.capital_total` після кожної інструкції.
- `liq_price(long) < entry < liq_price(short)` при рівному lev.
- Округлення не зменшує пул.
- Ліквідація не дає юзеру більше `margin + upnl`.
- Після `close`/`liquidate`: `Position` обнулена, `oi_side −= size`.

### 3.7 Відомі слабкості

MMR 5% при 10x — рух 5% за 1–4 с = bad debt на пул (тестовий). EMA відстає. Один оракул; deviation guard проти другого джерела — v1.

---

## 4. Програма `dexxer_core`

### 4.1 Структури

```rust
#[account] pub struct Config {
    version: u8, admin: Pubkey, crank: Pubkey, paused: bool,
    oracle_program: Pubkey, tee_validator: Pubkey, bump: u8,
}

#[account] pub struct Market {
    version: u8, symbol: [u8; 8], feed: Pubkey,
    max_lev_bps: u32, imr_bps: u32, mmr_bps: u32,
    open_fee_bps: u16, close_fee_bps: u16, liq_fee_bps: u16,
    oi_cap: u64, max_position: u64, min_size: u64,
    max_staleness_slots: u64, max_conf_bps: u16, max_deviation_bps: u16,
    mark: u64, mark_slot: u64, ema_alpha_bps: u16,
    paused_open: bool, stale_ticks: u16, bump: u8,
}

#[account] pub struct MarketRisk {
    version: u8, market: Pubkey,
    oi_long: u64, oi_short: u64, open_positions: u32,
    buckets: [LiqBucket; 64],
    bump: u8,
}

#[account] pub struct Pool {
    version: u8, mint: Pubkey, vault_eata: Pubkey,
    capital_total: u64, locked_total: u64, fees_accrued: u64,
    insurance: u64, bad_debt_total: u64,
    last_commit_slot: u64, bump: u8,
}

#[account] pub struct UserAccount {
    version: u8, owner: Pubkey,
    session_key: Pubkey, session_expiry: i64, actions_left: u32,
    free_margin: u64, locked_margin: u64,
    nonce: u64, bump: u8,
}

#[account] pub struct Position {
    version: u8, owner: Pubkey, market: Pubkey,
    state: PositionState,          // Empty | Open | Closed
    side: Side, size: u64, entry: u64, margin: u64,
    liq_price: u64, opened_slot: u64,
    closed: Option<ClosedRecord>,  // до mark_committed
    bump: u8,
}

pub struct ClosedRecord {
    market: Pubkey, side: Side, size: u64, entry: u64,
    exit: u64, pnl: i64, fees: u64, reason: CloseReason,   // User | Liquidated
    opened_slot: u64, closed_slot: u64,
    salt: [u8; 32], nonce: u64, reveal_after_slot: u64,
    commitment_written: bool,
}

#[account] pub struct DisclosureQueue {
    version: u8, owner: Pubkey, head: u8, len: u8,
    records: [ClosedRecord; 8],
    bump: u8,
}

#[account] pub struct DisclosureCommitment { hash: [u8; 32], batch_slot: u64 }
#[account] pub struct Disclosure {
    owner: Pubkey, market: Pubkey, side: Side, size: u64,
    entry: u64, exit: u64, pnl: i64, fees: u64, reason: CloseReason,
    opened_slot: u64, closed_slot: u64, nonce: u64,
}
```

### 4.2 Інструкції

**Колонка «Підписант» — обов'язкова явна перевірка в коді, не опис.** `EphemeralPermission` гейтить **лише читання** акаунтів; сабміт і виконання транзакції не гейтяться зовсім, а `getAuthToken` видається будь-якому ключу з валідним підписом і членства не перевіряє (check 9, 19.09.2026). Тобто не-member спокійно надсилає tx у ER і мутує permissioned-акаунт, якщо сама інструкція його не зупинила. Кожна ER-інструкція сама доводить право підписанта: `has_one`/`constraint` проти `Config.crank`, `Position.owner`, `UserAccount.session_key`, плюс `session_expiry` і `actions_left`.

| Інструкція | Шар | Підписант | Guards |
|---|---|---|---|
| `init_config`, `init_market`, `init_pool`, `set_params`, `pause`, `unpause` | L1 | admin | — |
| `faucet_mint` | L1 | user | rate-limit |
| `init_user` | L1 | owner | UserAccount + Position(Empty) + DisclosureQueue, рента під `EphemeralPermission::size_of(3)` |
| `delegate_user` | L1 | owner | делегує три PDA у `tee_validator`; Delegation Actions `create_permission(private, [owner, session, crank])` |
| `deposit` | L1 | owner | eSPL delegateSpl → pool eATA; подія для `credit_deposit` |
| `credit_deposit` | ER | crank | ідемпотентно за `(owner, l1_signature)`; `free_margin += amount` |
| `set_session` | ER | owner | оновлює `session_key`, `session_expiry`, `actions_left`, members |
| `open_position` | ER | session / owner | `!paused`, `!paused_open`, `Empty`, оракул, IMR, lev, OI cap, max_position, min_size, slippage, `actions_left > 0` |
| `increase_position` | ER | session | те саме, `Open`, VWAP entry |
| `decrease_position` | ER | session | `Open`, залишок ≥ IMR або повне закриття |
| `add_margin` | ER | session | `free_margin ≥ amount` |
| `close_position` | ER | session | `Open`, оракул, slippage → `ClosedRecord`, `Closed` |
| `crank_tick` | ER | crank | оракул, EMA, ≤16 remaining_accounts, MMR + гістерезис |
| `commit_aggregate` | ER | crank | `MagicIntentBundleBuilder`: `Pool`, `UserAccount[]`, `Market` при зміні; `add_post_commit_actions(write_commitment)` для `Closed && !commitment_written` |
| `write_commitment` | L1 (Magic Action) | injected escrow signer — **обов'язкова перевірка** | seeds `[b"commit", nonce]`; контекст `#[action]` **мусить** оголосити `source_program` (`address = crate::ID`) перед `escrow_auth`/`escrow` (check 7, 19.09.2026) |
| `mark_committed` | ER | crank | `ClosedRecord` → `DisclosureQueue`, `Position → Empty` |
| `reveal` | ER → L1 (Magic Action) | crank | `slot ≥ reveal_after_slot` → `write_disclosure`, запис видаляється з черги; у `write_disclosure` той самий обов'язковий `source_program` (check 7) |
| `withdraw` | ER → L1 | owner | `free_margin ≥ amount` → eSPL withdraw |
| `undelegate_user` | ER → L1 | owner | `Empty`, черга порожня → скраб → `commit_and_undelegate` |

### 4.3 Помилки

`Paused`, `OpenPaused`, `StaleOracle`, `OracleConfidence`, `OracleDeviation`, `WrongFeed`, `InsufficientMargin`, `LeverageTooHigh`, `PositionTooSmall`, `PositionTooLarge`, `OiCapExceeded`, `SlippageExceeded`, `PositionNotEmpty`, `PositionNotOpen`, `NotLiquidatable`, `Unauthorized`, `SessionExpired`, `NoActionsLeft`, `HasOpenPosition`, `QueueFull`, `MathOverflow`, `InvalidActionSigner`, `DuplicateDeposit`.

### 4.4 Модулі

```
programs/dexxer_core/src/
  lib.rs            #[ephemeral] #[program]
  state/            config, market, market_risk, pool, user, position, disclosure
  instructions/     admin/, user/, trade/, crank/, disclosure/
  math.rs           чисті формули §3.2 + liq_price + ema, округлення, decimals
  oracle.rs         читання Pricing Oracle + валідація
  risk.rs           перевірки IMR/MMR, бакети, вибір кандидатів — поверх math.rs
  errors.rs
```

**Межа `math.rs` / `risk.rs`.** `math.rs` — чисті формули без Anchor-типів і без політики: `notional`, `upnl`, `fee`, `required_margin`, `equity`, `vwap_entry`, `decrease_pnl`, **`liq_price`**, **`ema`** (mark-EMA §3.4). Усі ставки — `u32` bps, проміжні `u128`, кожен крок `checked_*`, округлення на користь пулу. `risk.rs` — політика поверх них: перевірки IMR/MMR, `is_liquidatable` у контексті ринку, бакети `MarketRisk`, вибір ≤16 кандидатів на тік. `math.rs` повертає `MathError`; конвертація в `anchor_lang::error::Error` — через `From<MathError>` → `DexxerError` в `errors.rs`, щоб формули не знали про Anchor.

**`oracle.rs` — з check 4 (19.09.2026).** Feed перевіряти **деривацією PDA** `["price_feed", "pyth-lazer", <symbol>]` під `Config.oracle_program`, не по `writeAuthority` (він = System Program, порожній). Ціна = `price / 10^exponent`, `exponent` на цьому фіді `+8`. `conf == 0` → відмова на відкриття. Staleness — за ER `Clock`/`publish_time`; `posted_slot` — ER-слот, з L1-слотом не порівнюється. Акаунт 134 байти (133 IDL + 1 хвостовий) — читати за офсетами, не валідувати за довжиною.

Anchor-правила: `has_one`/`seeds`/`bump`/`constraint` на кожному акаунті; `init_if_needed` не використовувати; `program_id` оракула — з `Config`; `remaining_accounts` валідувати явно; `version: u8` у кожному PDA.

- **Кожна ER-інструкція сама перевіряє підписанта.** `EphemeralPermission` гейтить тільки читання; ні `getAuthToken`, ні сабміт tx членства не перевіряють (check 9, 19.09.2026). Тому авторизація — завжди в логіці програми: `has_one`/`constraint` проти `Config.crank`, `Position.owner`, `UserAccount.session_key`, плюс `session_expiry` і `actions_left`. «Акаунт permissioned» ніколи не є підставою пропустити перевірку.
- **Кожен `#[action]`-контекст оголошує `source_program`.** Порядок акаунтів обов'язково `[...дані, source_program, escrow_auth, escrow]`, і `source_program` пінимо `#[account(address = crate::ID)]`. Делегаційна програма вставляє id програми-призначення окремим акаунтом при CPI-диспатчі, а макрос `#[action]` (SDK 0.16.2) дописує лише `escrow_auth`/`escrow`. Без явного поля всі акаунти після даних зсуваються на один, і дія відхиляє сама себе як `Unauthorized` (check 7, 19.09.2026 — саме так падав `update_leaderboard` у спайку).

---

## 5. Мобільний клієнт

### 5.1 Стек

Expo + `expo-dev-client`, Expo Router, TS strict, NativeWind; `create-solana-dapp` (Solana Mobile Expo). **`@solana/web3.js` v1** (SDK MagicBlock 0.17.0 → web3.js ^1.98; Anchor TS → web3.js v1), `@wallet-ui/react-native-web3js`, `@anchor-lang/core`, `@magicblock-labs/ephemeral-rollups-sdk`. Поліфіли `react-native-quick-crypto` + `react-native-nitro-modules`, `polyfill.js` першим імпортом. `expo-secure-store` для session key. TanStack Query + Zustand + `react-native-mmkv`. `react-native-wagmi-charts` (лінія). `expo-notifications` локальні. Jest + RNTL; Maestro.

### 5.2 Три з'єднання

| | URL | Для чого |
|---|---|---|
| `base` | `https://rpc.magicblock.app/devnet` + fallback | онбординг, депозит, `Disclosure`, `Pool` |
| `router` | `https://devnet-router.magicblock.app` | `getDelegationStatus` → fqdn |
| `tee` | `https://devnet-tee.magicblock.app?token=…` | торгові дії, `Position`/`UserAccount`, WS |

Blockhash — з того з'єднання, куди шлемо. `skipPreflight: true` лише за документованою несумісністю.

### 5.3 Доступ до TEE

1. `verifyTeeRpcIntegrity` → провал = екран «TEE не підтверджено», торгівля заблокована.
2. `challenge(session_key)` → підпис session key → `login` → token. Session key **у members** permission.
3. Token у пам'яті + MMKV з TTL; 401 → повтор без юзера.

### 5.4 Session key

> **Рантайм-знахідки MWA (check 8, 19.09.2026):** `useMobileWallet().account.address` — base58-рядок, не `PublicKey` (типи брешуть); `signMessages` повертає `message ‖ signature` (169 байт), для TEE-челенджу брати останні 64 байти з ed25519-верифікацією; L1-транзакції з MWA — тільки `signAndSendTransaction` (гаманець шле сам, інакше blockhash протухає за round-trip); ER-транзакції — `signTransactions` + власна відправка на TEE-ендпоінт (бюджет ≈1.6–4.6 с). Helper: `app/src/spikes/mwa.ts`.

Генерується локально; secret у SecureStore. Реєструється в MWA-tx онбордингу. `session_expiry` 7 днів + `actions_left` (урок GMX One-Click). Прострочено → MWA `set_session` у ER. Fee payer ER-tx — session key після lamports top-up (підтверджено, check 9, 19.09.2026: свіжий ключ після top-up був payer'ом і єдиним підписантом ER-tx, `meta.err: null`). Втрата телефона → owner робить `set_session(new)`.

**Членство в permission ≠ право на дію (check 9, 19.09.2026).** Три різні перевірки, які легко сплутати: (1) видача auth-token (`getAuthToken`) — лише підпис, членство не перевіряється, токен отримує будь-хто; (2) **читання** permissioned-акаунта — гейтиться членством, не-member бачить `null`; (3) **сабміт і виконання tx** — не гейтиться нічим, крім логіки самої інструкції. У check 9 session key не був членом (читання давало `null`), але його tx успішно змінила лічильник. Наслідок для нас: session key має бути **і** в `members` (щоб клієнт читав `Position`/`UserAccount`), **і** перевірений у програмі через `UserAccount.session_key` + `session_expiry` + `actions_left` — одного членства мало, воно нічого не забороняє.

### 5.5 Екрани й стани

| Екран | Дані | Дії |
|---|---|---|
| Connect | MWA | Seeker detection; Digital Asset Links `dexxer.xyz/.well-known/assetlinks.json` — обов'язково |
| Onboard / Deposit | base | фаусет → одна MWA-tx |
| Trade | tee: `Market.mark`, `free_margin`; index | слайдер плеча з відстанню до ліквідації у %, size, side, slippage, повна вартість до підтвердження |
| Position | tee: WS `Position` (check 10 PASS — WS основний; poll 1 с лише при реконекті) | size, entry, mark, uPnL, liq price, «crank перевірено N с тому»; close / add margin / decrease |
| History | tee: `DisclosureQueue`; base: `Disclosure` | «розкрито / розкриється через …» |
| Settings | — | revoke сесії, видалити акаунт і дані, TEE-статус, push toggle |

Стани: `TeeUnverified`, `SessionExpired`, `OraclePaused` (закриття доступне), `ErUnreachable` (останній стан з MMKV, дії заблоковані).

### 5.6 Локальні push

У форграунді WS; у фоні poll 30–60 с через `expo-background-task`. Android Doze — не гарантовано. Notifier у TEE — v1.

### 5.7 Навантаження на Seeker

Тонкий клієнт: рендер + підпис. Ризики не CPU: батарея у фоні, розриви мережі (WASM `@phala/dcap-qvl` у Hermes — перевірено, працює: check 11) (`ManagedWebsocket`-патерн: реконект з backoff, повтор підписок, snapshot).

---

## 6. Тулчейн, середовища, тести, CI

### 6.1 Тулчейн

Solana 3.1.9 · Rust 1.89.0 · Anchor 1.0.2 · `ephemeral-rollups-sdk` 0.16.2 · TS SDK 0.17.0 · Node 24.18.x · `@magicblock-labs/ephemeral-validator` 0.13.7. Версії звіряти з `Cargo.toml` engine-examples.

Пін Solana лишається **3.1.9**. Примітка: спайки 19.09 фактично виконувалися на `solana-cli` 3.1.10 і Node 24.18.0 — сумісно, розбіжностей не виявлено; пін не рухаємо, `.nvmrc` = `24.18.0`.

### 6.2 Репозиторій

```
dexxer/
  programs/dexxer_core/
  tests/unit/  tests/litesvm/  tests/er/
  app/
  scripts/admin/  scripts/crank-fallback/  scripts/demo/
  docs/
```

### 6.3 Драбина валідації

| Рівень | Інструмент | Доводить | Не доводить |
|---|---|---|---|
| 1 | `cargo test` + proptest | формули, округлення, інваріанти | акаунти |
| 2 | LiteSVM | guards, стани, комісії, ліквідація в `crank_tick` | делегацію, permission, scheduler, Magic Actions |
| 3 | `mb-stack` | делегація, ER-запис, коміт, undelegate, permission через QFS, Magic Action | TEE, router, scheduler, eSPL у TEE |
| 4 | devnet + `devnet-tee-as` | реальний TDX, оракул, eSPL, scheduler, TEE-токен, WS, MWA з емулятора | навантаження, SLA, MRTD |
| 5 | Seeker | MWA з реальними гаманцями, assetlinks, фон/батарея | — |

PER-межа доводиться тільки на рівні 4.

### 6.4 Обов'язкові тести

- §3: proptest інваріантів на випадкових послідовностях; edge-cases з `/audit` perpetuals як вектори.
- §4: кожна інструкція × кожен guard; state machine `Position`; переповнення `DisclosureQueue`; `write_commitment` без escrow-підписанта → відхилено; `undelegate_user` при `Open` → `HasOpenPosition`; `credit_deposit` ідемпотентний.
- Оракул: правильний feed / чужий / `posted_slot == 0` / stale / conf / exponent.
- ER: делегація → open → commit `Pool` без полів позиції (байти на base) → close → commitment → reveal → hash збігається → exit.
- Витік (рівень 4): після серії трейдів `Position` з base = байти онбордингу; з TEE без токена — відмова; з чужим токеном — відмова.
- Мобільний: Jest; Maestro «connect → faucet → open → position → close»; реконект через airplane mode.

### 6.5 CI

| Job | Тригер | Кроки |
|---|---|---|
| `program` | PR | fmt, clippy `-D warnings`, `cargo test`, `anchor build`, LiteSVM, `cargo audit` |
| `er-local` | PR (allow-fail спочатку) | `mb-stack` + сценарії рівня 3 |
| `app` | PR | `tsc`, eslint, jest |
| `devnet-smoke` | nightly / manual | деплой, рівень 4, витік-тест |
| `apk` | тег | EAS Build |

Solana MCP `program_autofixer` — на кожну зміну програми до коміту.

### 6.6 Демо-скрипт

`scripts/demo/` — три кадри: (1) Hypurrscan адреси кита на Hyperliquid — усі поля публічні; (2) Solscan devnet: гаманець тестера — депозит → делегація → тиша; PDA owner `DELeGG…`, байти незмінні; (3) Solana Explorer з `?cluster=custom&customUrl=<devnet-tee>` без токена — відмова; з токеном власника — позиція. Ганяється перед кожним записом відео.

---

## 7. Ризики, перевірки тижня 0, календар

### 7.1 Ризики

| # | Ризик | Удар | Мітигація | Коли |
|---|---|---|---|---|
| 1 | eSPL у TEE не працює або депозит L1 → `credit_deposit` не зв'язується | блокер кастоді | План Б: власний escrow-vault на L1; `deposit` пише `free_margin` до делегації; поповнення = undelegate → deposit → redelegate | тиждень 0 |
| 2 | ER не читає неделеговані L1-акаунти | архітектурний | усе, що читає ER-інструкція, — делеговане | тиждень 0 |
| 3 | Scheduler у TEE нестабільний | ліквідації | `crank-fallback` на Railway | тиждень 2 |
| 4 | Tx з приватними акаунтами видно не-member'ам | ламає демо | **АКТИВОВАНО (check 6, 19.09.2026).** Метадані (факт, слот, час, успіх, fee, CU) не гейтяться; список підписів по program id відкритий усім. Мітигація: (а) однакова форма tx для всіх дій — ззовні `open`, `close`, `add_margin` нерозрізнювані; (б) cover traffic — `crank_tick` кожну ~1 с є природним chaff'ом, і торгова tx за самими метаданими нерозрізнювана від тіку кранка; (в) чесно описати канал у README і в §2.3. **Спільний sponsor-payer сам по собі не допомагає** — витік іде від списку підписів program id, а не від payer'а | тиждень 0 → постійно |
| 5 | Delegation Actions не дають один MWA-підпис | UX | два підписи | тиждень 1 |
| 6 | ~~`dcap-qvl` WASM не працює в Hermes~~ **ЗАКРИТО (check 11, 19.09.2026):** `verifyTeeRpcIntegrity` виконується на Hermes за ~3.2 с без шимів | довіра | allowlist MRTD/RTMR лишається v1 | — |
| 7 | ~~MWA не підписує tx з ER-blockhash~~ **ЗАКРИТО (check 8, 19.09.2026):** MWA-підпис tx з ER-blockhash прийнято TEE; blockhash→підпис 1.6–4.6 с | `set_session` | `set_session` через MWA на ER — ок; трейди — session key. L1-транзакції з MWA слати через `signAndSendTransaction` (blockhash протухає за round-trip) | — |
| 8 | Смерть devnet-tee під час демо | демо | записане відео + `mb-stack` резерв | тиждень 4 |
| 9 | Соло, 4 тижні | усе | порядок жертв | постійно |
| 10 | Colosseum забороняє код до 28.09 | тиждень 0 | перевірити 19.09; тиждень 0 = spikes | 19.09 |

**Порядок жертв:** локальні push → History-екран → `DisclosureQueue`/reveal (лишити commitment) → increase/decrease → **ніколи**: ліквідаційний crank, приватність `Position`, тест на Seeker.

### 7.2 Перевірки тижня 0 (spike-скрипти поверх engine-examples)

| № | Що | Пройшло, коли | Якщо ні |
|---|---|---|---|
| 1 | `private-counter` на 1.0.2/0.16.2 → devnet-tee, permission через Delegation Actions | чужий гаманець — відмова на read | стоп, Discord MagicBlock |
| 2 | eSPL у TEE: `delegateSpl` → transfer в ER | баланс змінився | ризик №1 → план Б |
| 3 | ER читає неделегований L1-акаунт read-only | свіже значення | ризик №2 |
| 4 | Pricing Oracle SOL/USD у devnet-tee: `posted_slot > 0`, свіжий publish time | ціна в лозі | блокер |
| 5 | Scheduler: crank-counter у TEE, ~1 с тики | лічильник росте | ризик №3 |
| 6 | Не-member: `getSignaturesForAddress` / `getTransaction` по приватному акаунту на TEE RPC | відмова / пусто | ризик №4 |
| 7 | Magic Action через `MagicIntentBundleBuilder` пише L1-акаунт; перевірка escrow-підписанта | акаунт на devnet | без 13F |
| 8 | MWA (Mock Wallet) підписує tx з ER-blockhash | прийнято TEE | ризик №7 |
| 9 | Session key як payer у ER після top-up | прийнято | payer = sponsor |
| 10 | WS `accountSubscribe` з токеном з RN | оновлення йдуть | poll 1 с |
| 11 | `verifyTeeRpcIntegrity` у Hermes | true на емуляторі | ризик №6 |

### 7.3 Календар (від 18.09)

**Тиждень 0 · 19–27.09 — spikes, нуль продуктового коду**

| Дні | Що | Артефакт |
|---|---|---|
| 19 | Правила Colosseum. Тулчейн. `private-counter` → devnet-tee (перевірка №1) | лог відмови чужому |
| 20–21 | Перевірки №2, 3, 4, 5, 7 | таблиця пройшло/ні; рішення по ризиках 1–3 |
| 22–23 | `create-solana-dapp` Expo, поліфіли, Mock MWA; перевірки №6, 8, 9, 10, 11 | MWA connect + tx у TEE з емулятора |
| 24 | Оновити docs (Flash/Adrena, версії, Drift → velocity; план під A) | коміт docs |
| 25–26 | `math.rs` формули + proptest **як червоні тести**; Publisher Policy чекліст; `dexxer.xyz` + assetlinks | тести червоні |
| 27 | Два деки (скелет). Пост №1 | — |

**Тиждень 1 · 28.09–04.10 — ядро без приватності.** Стани, `math.rs`, `risk.rs`, `oracle.rs`; open/close/add_margin/`crank_tick`; LiteSVM зелений; делегація + eSPL на mb-stack. П'ятниця: CLI на mb-stack — депозит → open → crank ліквідує → close.

**Тиждень 2 · 05.10–11.10 — приватність, devnet-tee, мобільний скелет.** Permission на всі акаунти; deploy devnet + devnet-tee; session keys; `commit_aggregate`; витік-тест рівня 4. Expo: Connect → Onboard → Trade → Position. П'ятниця: open з емулятора без промпту; чужий не бачить; Solscan мовчить.

**Тиждень 3 · 12.10–18.10 — 13F, полірування.** `ClosedRecord` → `DisclosureQueue` → `write_commitment` → `reveal`; History; локальні push; TEE-атестація або fallback; crank-fallback; CI. П'ятниця: повний цикл + три кадри демо.

**Тиждень 4 · 19–25.10 — Seeker, відео, подача.** Реальний Seeker; відео 2–3 хв; README; подачі. Пост №3.

**Резерв · 26.10–02.11.**

### 7.4 Успіх

Реальний Seeker: депозит → приватний лонг → Solscan мовчить → чужий гаманець отримує відмову → crank ліквідує тестову позицію за MMR → закриття → commitment на L1 → reveal, хеш збігається. Не встигли 13F або push — чесний розділ README. Не встигли Seeker — провал.

---

## 8. Відкриті питання (закриваються тижнем 0, не документом)

1. Механізм зв'язку депозиту на L1 з `credit_deposit` в ER (eSPL callback? наш crank читає L1 події?) — **НЕ закрито тижнем 0.** Check 2 довів лише механіку eSPL (`delegateSpl` + `transferSpl` у TEE, баланси сходяться), але самого зв'язку «депозит на L1 → нарахування в ER» не перевіряв. → тиждень 1, дні 1–2.
2. Чи можна створити `EphemeralPermission` на трьох PDA в одній Delegation Actions-транзакції — **НЕ закрито тижнем 0.** Check 1 створив permission на **одному** PDA; три в одній tx не пробували. → тиждень 1, дні 1–2.
3. Розмір `Position` + `DisclosureQueue` та рента при онбордингу — **НЕ закрито тижнем 0**, бо структури ще не зафіксовані в коді. Порахувати після §4.1 → тиждень 1, дні 1–2.
4. Чи потрібен `MarketRisk.buckets` на MVP-обсязі — лишити структуру, заповнювати лінійно.
5. Formatting `Disclosure` для explorer — чи достатньо `getProgramAccounts` по discriminator без індексера при десятках записів.

---

*Живе разом із `dexxer-architecture.md` (обґрунтування, витік-модель, конкурентна рамка) і `solana-perp-privacy-landscape.md` (ринок). `dexxer-plan.md` §2–3 застарілі й замінюються §1 і §7.3 цього документа.*
