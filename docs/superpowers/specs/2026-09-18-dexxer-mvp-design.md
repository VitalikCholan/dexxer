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
- **Приватність:** усі акаунти нашої програми в ER — permissioned. `Position` — `is_private`, members `[owner, session_key, crank]` (crank подає ліквідаційні tx, тому member), нуль комітів до закриття. ~~`UserAccount` комітить лише `free_margin`, `locked_margin`.~~ **(week 2, 21.09.2026 — переглянуто)** див. нове правило нижче: приватний акаунт **не комітиться на L1 як є взагалі**.
- **Приватність — фундаментальне правило (week 2, 21.09.2026):** у PER приватність — це **фільтрація читання в TEE/QFS, не шифрування** (доки MagicBlock `onchain-privacy`/`local-development`: QFS блокує не-членам `getAccountInfo`/gPA; байти не зашифровані). На L1 фільтра немає — тому **сирий приватний (permissioned) акаунт ніколи не комітиться на L1**: це зробило б його байти публічними й знищило б приватність, і TEE такий коміт не пропускає (спостережено, ризик №13). Наслідок для дизайну: усе, що має вийти на L1 (публічний агрегат, trustless-exit-доказ, 13F-розкриття), виходить **лише через окремий ПУБЛІЧНИЙ похідний акаунт** — `Pool` (агрегат), майбутній commitment/root-акаунт (exit-докази + `write_commitment`-хеші). Приватні `Position`/`UserAccount`/`MarketRisk`/`DisclosureQueue` живуть у TEE й на L1 у відкритому вигляді не потрапляють ніколи. Trustless-exit будується на публічному root-і балансів + merkle-доказі власника, **не** на комітах сирого `UserAccount`.
- **13F:** при закритті — Magic Action `write_commitment(nonce, keccak256(record ‖ salt))`; після `reveal_after_slot` crank пише `Disclosure`. Затримка — параметр (демо: хвилини; продукт: 30 днів). **(week 3, 21.09.2026)** обидві Magic Actions їздять на коміті публічного `Pool` (#13); `mark_committed` повертає `Position → Empty` — знімає ліміт «одна позиція за прогін». Плюс публічна квитанція боргу `BalancesRoot` (хешовані листки, без L1-claim — сейф у eSPL). Повний дизайн — §2.4.
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
| `Market` | `[b"market", b"SOL"]` | делегований у TEE | при зміні параметрів | **публічний в ER (без permission)** **(week 3, Task 11 — виправлено; §7.1 ризик #24)** — `delegate_market` не створює `EphemeralPermission` (код `instructions/admin.rs`'s `DelegateMarket`: *«Neither carries user-scoped fields, so no ER permission account is created for them here»*); попередній запис «permissioned `[crank, admin]`» був хибним, permission на `Market`/`MarketRisk` ніколи не створювався жодною інструкцією | параметри, mark-EMA, paused_open |
| `MarketRisk` | `[b"risk", market]` | делегований | **ніколи** | **публічний в ER (без permission)** **(week 3, Task 11 — виправлено; §7.1 ризик #24)** | OI long/short, open_positions; **без бакетів на MVP (week 1, 20.09.2026, §8 Q4)** — `buckets: [LiqBucket; 64]` не реалізовано, кандидати на ліквідацію йдуть парами `[Position, UserAccount]` у `remaining_accounts`, не через вибірку `MarketRisk` |
| `Pool` | `[b"pool", dUSDC]` | делегований | **фіксовано 5 хв** | **публічний в ER (без permission)** **(week 3, Task 11 — виправлено; §7.1 ризик #24)** — `delegate_pool` теж не створює `EphemeralPermission` (лише `UserAccount`/`Position`/`DisclosureQueue` через `init_permissions`, `instructions/user.rs`); попередній запис «permissioned» тут теж був хибним | capital_total, `protocol_liquidity` **(week 1, 20.09.2026)** — власний капітал пулу, контрагент PnL, сідується `seed_pool`; locked_total, fees, insurance, bad_debt_total |
| `UserAccount` | `[b"user", owner]` | делегований | ~~фіксовано 5 хв, усі разом~~ **(week 2, 21.09.2026)** — лише всередині `withdraw`'s власного commit-intent; `commit_aggregate` комітить **тільки `Pool`**, жодного періодичного коміту `UserAccount` немає | `[owner, session, crank]` | free_margin, locked_margin, session_key, expiry, actions_left, nonce, **`last_withdraw_slot: u64` (week 2)** — per-account cooldown. ~~Витік: locked_margin з гранулярністю 5 хв...~~ **(week 2)** витік зменшено: `UserAccount` тепер комітиться лише на `withdraw`, не кожні 5 хв — `locked_margin`/`free_margin` на L1 відстають до наступного виводу коштів, не оновлюються фоново. **Відкрите питання (тиждень 3, §7.1, §8):** сам цей `withdraw`-коміт на реальному devnet-tee жодного разу не долетів до L1 в межах спостереження — конфіг 1 (звичайний `owner`-payer): 30+ хв, і досі до-withdraw значення; конфіг 2 (`FeeEscrow`+vault payer, свіжа ідентичність): ще ~3.5 хв (третє незалежне підтвердження), і досі те саме — SPL-нога (ER `free_margin -=` і base ATA `+=`) щоразу коректна, лише байти `UserAccount` на L1 лишаються застарілими |
| `Position` | `[b"position", owner, market]` | делегований | **нуль до закриття** | `is_private`, `[owner, session, crank]` | створюється раз при онбордингу; при закритті обнуляється; undelegate лише при виході після скрабу. **(week 3)** + `commitment_written: bool` — `commit_aggregate` емітує `write_commitment` лише для `Closed && !commitment_written`; `mark_committed` повертає `Empty` |
| `DisclosureQueue` | `[b"dq", owner]` | делегований | **ніколи** | `[owner, crank]` | кільце N `ClosedRecord` до reveal |
| Pool eATA | eSPL program | делегований (eSPL) | за eSPL | публічний баланс пулу | єдиний токен-акаунт у ER |
| User eATA | eSPL program | транзитно | — | — | існує лише в момент депозиту/виводу |
| Global Vault dUSDC | eSPL program | L1 | — | публічний | реальні токени всіх |
| Oracle feed SOL/USD | `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` | доступний у TEE | — | публічний вхід | — |
| `Disclosure` | `[b"disclosure", hash]` **(week 3, Task 8b, рулінг 9)** | L1 | Magic Action після reveal | публічний | `owner = Pubkey::default()` (угода публічна, трейдер — ні, §2.3), `version`, `bump`, і поля `ClosedRecord` без `salt`/`reveal_after_slot`/`commitment_written`; `hash = commitment_hash(args, salt)` — не `nonce` (per-user лічильник, колізує між трейдерами), `write_disclosure` перевіряє `commitment_hash(args, salt) == Commitment.hash` перед записом |
| `Commitment` **(week 3, §2.4.1; seed — Task 8b, рулінг 9)** | `[b"commit", hash]` | L1 | Magic Action `write_commitment` на коміті `Pool` | публічний | `{ version, hash: keccak256(record ‖ salt), slot, nonce, bump }`; `write_disclosure` звіряє проти нього; PDA сідується самим `hash`, не `nonce` |
| `BalancesRoot` **(week 3, §2.4.2; layout — Task 5, рулінг 5)** | `[b"balances_root"]` | делегований у TEE, **публічний** | разом із `Pool` (5 хв) | публічний (без per-user полів у відкритому вигляді) | `leaf = keccak256(owner ‖ free_margin ‖ exit_salt ‖ root_slot)`, паддинг `keccak256(padding_seed ‖ i)`; квитанція боргу, **без L1-claim** (сейф у eSPL). **`#[account(zero_copy)] #[repr(C)]`, не Borsh** — by-value `Account<BalancesRoot>` (2 KiB, домінує `leaves: [[u8;32];64]`) пробивав SBF-стек (LiteSVM-проба `Access violation in stack frame 3`); лейаут `root_slot:u64 \| leaves:[[u8;32];64] \| version:u8 \| filled:u8 \| bump:u8 \| _pad:[u8;5]` = 2064 B (+8 B дискримінатор = `BalancesRoot::SIZE` 2072 B) |
| `FeePayer` + `magic_fee_vault` | наш делегований payer | ER / L1 | — | — | ~~оплата комітів; топ-ап `lamportsDelegatedTransferIx`~~ **(week 2, 21.09.2026) — план замінено.** `Config.fee_payer` (простий `Pubkey`, підписант верхнього рівня) **структурно ніколи** не може стати CPI-payer'ом fee-vault-шляху: акаунт, оголошений `Signer<'info>` на верхньому рівні прямо викликаної інструкції, не має приватного ключа програмного PDA. Реальний CPI-payer — окремий делегований `FeeEscrow` PDA, див. новий рядок нижче. `lamportsDelegatedTransferIx` теж не підійшов напряму (вимагає вже делегованого `destination`) — сесії/`devnet-fee-payer` фандяться звичайним `SystemProgram.transfer` |
| `FeeEscrow` **(week 2, 21.09.2026, новий)** | `[b"fee_escrow"]`, dexxer_core | делегований у TEE | — | permissioned (без per-user полів) | CPI-payer для `commit_aggregate`/`commit_market` (через `.magic_fee_vault(...)`, `build_and_invoke_signed`) і для `withdraw`'s commit-intent (без vault-вимоги для цього шляху); `init_fee_escrow`/`delegate_fee_escrow`, admin-gated, адреса `magic_fee_vault` (devnet-tee) = `EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b` (M3b). Спільний на всю систему → griefing surface, мітигований (не усунений) `withdraw`'s `MIN_WITHDRAW`/cooldown — §7.1 новий ризик |

**Два правила, що роблять приватність структурною:**

1. Жоден акаунт із полями позиції не має commit-policy до закриття. `Market`/`Pool` не містять per-user даних. `MarketRisk` і `DisclosureQueue` не комітяться взагалі.
2. Маржа — **облік, не токени.** `open`/`close`/`add_margin` не торкаються жодного токен-акаунта, лише приватних PDA. Токени рухаються тільки на депозиті й виводі, які й так публічні на L1. Причина: eATA належить eSPL-програмі → на ньому не створити `EphemeralPermission`, і трансфер user → pool на кожне відкриття видав би маржу й час.

   *Check 2 (19.09.2026):* eSPL-баланси в ER виявилися owner-scoped уже на рівні RPC — чужий `getAccount` з власним валідним TEE-токеном повертає `null` (`TokenAccountNotFoundError`), тобто токен-акаунт іншого власника невидимий навіть як баланс. Це сильніше за нашу мінімальну вимогу, але **правило лишається незмінним**: приватність маржі не будуємо на цій поведінці eSPL — вона не наша, не документована як гарантія і може змінитися; трансфер на кожне відкриття все одно видав би час дії через метадані tx (§2.3).

### 2.2 Маршрутизація

| Флоу | Підписант | Куди | Що | Відмова |
|---|---|---|---|---|
| Онбординг | owner (MWA, 1 підпис, fallback 2) | L1 | faucet → `init_user` (UserAccount + Position + DisclosureQueue, рента під permission) → `deposit` (eSPL у pool eATA) → `delegate_user` у `tee_validator` з Delegation Actions `create_permission` → session | розбити на 2 tx |
| `credit_deposit` **(week 1, 20.09.2026 — закриває ризик №1, §8 Q1)** | owner | ER | CPI SPL-transfer user eATA → pool eATA + `free_margin += amount`; ідемпотентність конструктивна — той самий переказ вдруге не пройде, бо кошти вже витрачені першим (`tests/er/q1-deposit.ts`, `week1-results.md` Task 13 Q1: CU 18 090, немає крана, немає `l1_signature`, `DuplicateDeposit` прибрано) | insufficient funds (SPL) при повторі |
| open / increase / decrease / close / add_margin | session key | TEE ER, token-gated | оракул → маржинальна перевірка → `Position`, `UserAccount`, `MarketRisk`, `Pool` | помилка програми; slippage; paused |
| `crank_tick` | ER scheduler (fallback: наш скрипт) | TEE ER | ~1 с: оракул, mark-EMA, ≤16 кандидатів у `remaining_accounts`, ліквідація | stale → скіп ліквідацій, `stale_ticks++`, після N `paused_open` |
| `schedule_crank`/`cancel_crank` **(week 2, 21.09.2026, нові)** | admin | ER (Magic Actions) | реєструє/скасовує запланований `crank_tick` через `ScheduleCrankCpi`/`CancelCrankCpi`; підписант запланованого виконання — `crank_signer_pda(admin)` (per-authority PDA, не `Config.crank`/плоский `CRANK_SIGNER`), записаний у `Config.scheduler_signer` окремою base-layer адмін-інструкцією `set_scheduler_signer` **перед** плануванням (§3.5, §4.2) | `Config.scheduler_signer` не збігається з `crank_signer_pda(admin)` → заплановані тіки не проходять signer-перевірку |
| `commit_aggregate` | crank/fee-payer | ER → L1 | ~~5 хв: `Pool`, `UserAccount[]`, `Market` при зміні~~ **(week 2/3)** — комітить `Pool` + `BalancesRoot` (§2.4.2), CPI-payer — делегований `FeeEscrow` (§2.1), не `ctx.accounts.payer` напряму; `.magic_fee_vault(...)` вмикає fee-vault шлях. **(week 3, реалізовано)** та сама інструкція, той самий bundle: `remaining_accounts` (`Position`/`DisclosureQueue`, ≤`MAX_ACTIONS_PER_COMMIT=4` дій сумарно) емітує `write_commitment` (для `Closed && !commitment_written`) **і** `write_disclosure` (для записів `DisclosureQueue` з `reveal_after_slot ≤ slot`, через `due_reveals`) — окремої `reveal`-інструкції немає, обидва види дій живуть у `commit_aggregate`. Викликається **щоцикл незалежно від наявності кандидатів** — коміт `Pool`+`BalancesRoot` фіксований, а `remaining_accounts` просто порожній, коли нема закритих/due-записів | ретрай; 10 безкоштовних-назавжди plain-комітів на акаунт без escrow (виміряно, `0xA0000000`=`COMMIT_LIMIT_ERR`), escrow дозволяє перетнути цей ліміт; `TooManyActions` (6039) на `Position`-шляху при переповненні бюджету дій |
| `mark_committed` | crank | ER | після підтвердження на L1: `ClosedRecord` → `DisclosureQueue`, `Position → Empty` | crank спостерігає `Commitment` на base і викликає (ER не читає L1); crank-асертовано, ризик #20 — **не перевіряє сам факт коміту**, лише `commitment_written`-прапорець і `config.crank`-підпис |
| `withdraw` | owner | ER → L1 | `require!(amount ≥ MIN_WITHDRAW)`, `require!(slot ≥ last_withdraw_slot + WITHDRAW_COOLDOWN_SLOTS)` **(week 2, 21.09.2026 guards)** → `free_margin −= amount` → SPL vault→owner transfer (ER) → commit-intent `UserAccount` через `FeeEscrow` payer (лишається невиміряним, чи долітає — §2.1) → клієнт: `undelegateIx(owner, mint)` на ER → поллінг base ATA до `owner == TOKEN_PROGRAM_ID` → `withdrawSpl(owner, mint, amount)` на base (виміряний сегментований час — §3.5-суміжне, `week2-results.md` Task 1 M4: undelegate ≈2062 мс, poll ≈176 мс, withdrawSpl ≈559 мс) | лише free, не locked; `InvalidParams` (< MIN_WITHDRAW); `WithdrawCooldown` |
| `undelegate_user` | owner | ER → L1 | `Position.Empty`, `DisclosureQueue` порожня, `free_margin == 0` → скраб (усі приватні поля `UserAccount`/`DisclosureQueue`, включно з `last_withdraw_slot`/`exit_salt`) → **явний `exit()`** на всі три скрабнуті акаунти (рулінг 10, нижче) → `CloseEphemeralPermissionCpi` ×3 → `commit_and_undelegate` → close на L1 | `HasOpenPosition`; `QueueNotEmpty`; `BalanceNotZero`. **M-A підтверджено PASS на `dexxer_core`** (Task 8, раунд 2, 22.09.2026): сигнатура `3422sohxAKSVmsBwiNU2bnP4cwCsh9uVeiDnE4v6dqArgvg2m9rcuwEwc8DincruURianTrv8tojNGbephdfJt92`, owner-flip base за 4.4 с, скраб перевірено трьома незалежними `solana account`-читаннями |

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

### 2.4 Дизайн тижня 3: 13F-пайплайн, `BalancesRoot`, вихід **(week 3, 21.09.2026)**

Затверджено брейнштормом 21.09 після знахідки #13 (§2.1 «фундаментальне правило»: сирий приватний акаунт ніколи не йде на L1). Усі L1-записи тижня 3 їздять **лише на коміті публічного `Pool`** як Magic Actions; хеші виходять із TEE тільки як *аргументи* публічних L1-інструкцій.

**2.4.1 13F-пайплайн (ядро)**

| Крок | Хто / де | Що робить |
|---|---|---|
| `close_position` / ліквідація (є) | session / crank, ER | пише `Position.closed = ClosedRecord{…, salt, nonce, reveal_after_slot}`, стан `Closed`. Нове поле `Position.commitment_written: bool = false` |
| `commit_aggregate` (розширено) | fee-payer/crank, ER | crank передає `remaining_accounts` = `Position`-и з `Closed && !commitment_written` **і** `DisclosureQueue`-и з due-записами (він member обох, знаходить через gPA). Програма в TEE рахує `hash = commitment_hash(record, salt)` (keccak256), додає `add_post_commit_actions(write_commitment(nonce, hash))` для позицій і `write_disclosure(args, salt)` для due-записів (через `due_reveals`) до коміту `Pool`+`BalancesRoot`, ставить `commitment_written = true`. **Обидва види дій — в одному `commit_aggregate`, без окремої `reveal`-інструкції** (§2.4.1 нижче поновлено фактом реалізації, Task 3). Сумарна кількість дій за виклик — `MAX_ACTIONS_PER_COMMIT = 4` (виміряний реальний cap мосту — 28/29, §2.4.4 M-C; 4 лишено з великим запасом, бо `write_commitment`/`write_disclosure` дорожчі за акаунтами, ніж вимірювана дія) |
| `write_commitment` | L1, `#[action]` | створює `Commitment [b"commit", hash]` **(seed — Task 8b, рулінг 9; хеш, не nonce)**. **Обов'язково** `source_program` (`address = crate::ID`) перед escrow-акаунтами (check 7) |
| `mark_committed` | crank, ER | crank **спостерігає** `Commitment` на base (ER не читає L1 — ризик #2) і викликає; програма переносить `ClosedRecord` у кільце `DisclosureQueue`, `Position → Empty`. **Знімає обмеження «одна позиція на трейдера за прогін»** (тижні 1–2) — виміряно на devnet (Task 8, M-B), друга позиція тим самим гаманцем відкрилась одразу після. Crank-асертовано — ризик #20, `mark_committed` **не** перевіряє існування `Commitment` на L1 самостійно |
| `write_disclosure` | L1, `#[action]` | створює `Disclosure [b"disclosure", hash]` **(seed — Task 8b, рулінг 9)**, **перевіряє `commitment_hash(args, salt) == Commitment.hash`**, інакше `BadDisclosureHash`. Той самий `source_program`-чек. Викликається з `commit_aggregate` (вище), не окремою `reveal`-інструкцією |

Затримка — `Config.disclosure_delay_slots` (є): демо хвилини, продукт 30 днів. Латентність commitment і reveal ≤ 5 хв (крок `commit_aggregate`, виміряно М-B: `Commitment` видно на base через 1.1–1.4 с після ER-сигу, `Disclosure` — через 3.0 с).

**2.4.2 `BalancesRoot` — публічна квитанція боргу (підхід A з брейншторму)**

- Акаунт `[b"balances_root"]`, **публічний**, делегований при bootstrap, комітиться разом із `Pool`. **`#[account(zero_copy)] #[repr(C)]`** (Task 5, рулінг 5 — не Borsh, детальніше §2.1/§4.1): `root_slot: u64, leaves: [[u8;32]; 64], version: u8, filled: u8, bump: u8, _pad: [u8;5]`.
- `set_balances_root(begin: bool, finalize: bool, padding_seed: [u8;32])` (ER, crank-gated, сигнатура — Task 5/7/8): crank передає `UserAccount`-и як `remaining_accounts` (≤`ROOT_BATCH=16` за виклик, кілька викликів на 64 слоти — `begin` скидає `root_slot`/`filled`, `finalize` заповнює хвіст паддингом). **Програма сама** рахує `leaf = keccak256(owner ‖ free_margin ‖ exit_salt ‖ root_slot)` з реальних байтів акаунта → crank **може пропустити** юзера (блокує вихід, ризик #19), **не може підробити** баланс. Порожні слоти = `keccak256(padding_seed ‖ i)`; seed на L1 не зберігається → паддинг не відрізнити від листків, точне N приховано.
- `UserAccount.exit_salt: [u8;32]` — нове поле; клієнт передає 32 випадкові байти в `init_user`.
- **Прив'язка до `root_slot`** — усі 64 листки змінюються кожного коміту незалежно від активності → зовні не видно, чий баланс змінився. **Виміряно (Task 8, M-E):** два послідовних цикли на реальному devnet-tee — усі 64/64 листки дійсно змінились між ними. **Фіксовані 64 слоти** → не видно кількості юзерів.
- **Що це дає і чого не дає.** Юзер локально (`keccak256` на пристрої) доводить: «на слоті S протокол засвідчив, що мені належить X». **Claim на L1 — не існує:** кастоді — eSPL, Global Vault `2BX6ZNoX…` належить програмі `SPLxh1LV…`, не `dexxer_core`; наша програма фізично не може підписати переказ із нього. Вихід при живому TEE — `withdraw` + `undelegate_user`; вихід без TEE — залежність від eSPL/MagicBlock, для яких root і є доказом боргу. Це узгоджено з моделлю довіри §0.4 («не від оператора») і з «бекенду нема» (eSPL = міст L1↔ER).
- **Приватність:** root публікує лише хеш `free_margin` — строго приватніше за дозволений spec'ом тижня 1 сирий коміт `UserAccount`. Жодного поля позиції. Crank уже member усіх `UserAccount` (ліквідації) — коло тих, хто бачить баланси, не розширюється.

**2.4.3 `undelegate_user` — вихід при живому TEE**

Owner, ER: `require!(Position.Empty && DisclosureQueue порожня && free_margin == 0)` (спершу `withdraw`) → **скраб** приватних полів (`UserAccount`: `session_key`/`session_expiry`/`actions_left`/`nonce`/`exit_salt`/`last_withdraw_slot`; `DisclosureQueue`: `head`/`len`/`records`) → **явний `exit()`** на всі три скрабнуті акаунти (рулінг 10 нижче — критично, інакше Anchor'ів автоматичний пост-хендлерний `exit()` переписує акаунт уже після зміни власника й runtime кидає `ExternalAccountDataModified`) → `CloseEphemeralPermissionCpi` ×3 (акаунти стають публічними — безпечно, бо порожні) → `MagicIntentBundleBuilder.commit_and_undelegate` трьох PDA → на L1 акаунти повертаються програмі.

**M-A результат (Task 8, два раунди на devnet-tee):** раунд 1 — `ExternalAccountDataModified` на обох повторах (сигнатури `3SsSoNnc…`, `44RWU8R8…`), корінь знайдено методичним ревʼю Anchor 1.0.2's `exit_with_expected_owner` (тавтологічна перевірка `expected_owner == program_id`, не читає живий `owner`) — **рулінг 10**. Фікс: три явні `a.user_account.exit(&crate::ID)?; a.position.exit(&crate::ID)?; a.dq.exit(&crate::ID)?;` одразу після скрабу, до CPI. Раунд 2 (той самий фікс на реальному devnet-tee, свіжий трейдер) — **PASS з першої спроби**, сиг `3422sohxAKSVmsBwiNU2bnP4cwCsh9uVeiDnE4v6dqArgvg2m9rcuwEwc8DincruURianTrv8tojNGbephdfJt92`, owner-flip на base за 4.4 с, скраб перевірено (`session_key`/`exit_salt`/`last_withdraw_slot` нульові, `DisclosureQueue.len==0`, `Position.state==Empty`) трьома незалежними `solana account`-читаннями.

**2.4.4 Виміри тижня 3 (Task 1, до продуктового коду) — результати**

| # | Що | Вирішує | Результат |
|---|---|---|---|
| M-A | `commit_and_undelegate` після `CloseEphemeralPermissionCpi` долітає на L1? | дизайн `undelegate_user` (2.4.3) | **PASS** на одноакаунтному спайку з першої спроби (Task 1); на реальному `dexxer_core` (3 акаунти) — FAIL раунд 1 (`ExternalAccountDataModified`, рулінг 10), **PASS раунд 2** після явного `exit()`-фіксу (Task 8) |
| M-B | Magic Action на коміті `Pool` реально виконується на L1 (`write_commitment` створює PDA)? | весь 2.4.1 | **PASS** (Task 8) — `Commitment`/`Disclosure` реально створюються, хеш збігається, друга позиція тим самим гаманцем відкрита |
| M-C | ліміт actions на один bundle | cap `Position`-ів за `commit_aggregate` | **28 PASS / 29 FAIL** (`0xa0000002`) на свіжому, ніколи не коміченому акаунті (Task 1, fix round 1) — перший сирий сет 24/25 виявився зіткненням із Path-A 10-комітною квотою на акаунт без escrow (`0xa0000000`=`COMMIT_LIMIT_ERR`, не той самий ліміт). `MAX_ACTIONS_PER_COMMIT` лишено `4` — реальна дія (`write_commitment`/`write_disclosure`, 5–6 акаунтів) дорожча за вимірювану (5 акаунтів рівно), повторний вимір на реальній формі не проведено (Task 8, поза бюджетом) |
| M-D | планувальник (#18): cap `iterations`, персистентність через рестарт валідатора, self-reschedule CPI | некостильний планувальник | `iterations = i64::MAX` **PASS**, реально тіка́є (81 тік за ~65 с); `0`/`-1` **FAIL** (`invalid instruction data`, симуляція, без підпису); self-reschedule (запланований `crank_tick` сам викликає `schedule_crank`) **FAIL** при реєстрації (`missing required signature`); персистентність через рестарт валідатора — **не виміряно** (нема вікна рестарту в сесії) |
| M-E | вартість fee-vault-комітів після nonce 25 для 2 акаунтів (`Pool` + `BalancesRoot`) | §8 п.7, бюджет crank-а | **100 000 лампортів/акаунт-коміт, щойно акаунтів власний commit-nonce ≥ 25** (`fees-and-commit-economics.md`, правило тижня 2 M3a) — round 1: **100 000 лампортів/коміт** (свіжий `BalancesRoot`, лише `Pool` уже за порогом, 12/12 однаково); round 2: **200 000 лампортів/коміт** (обидва акаунти вже за порогом nonce 25 — 100k+100k, 12/12 однаково); арифметика точно збігається: `12 × 200 000 = 2 400 000` = виміряна дельта ескроу `198 247 040 → 195 847 040` |

**2.4.5 Апгрейди (свідомі наступні кроки, не борг)**

| Апгрейд | Коли | Що змінюється |
|---|---|---|
| Merkle-root замість плаского списку (підхід B) | N > 64 | на L1 лише 32-байтний root; листки ті самі — міграції даних немає; застосунок будує proof локально з опублікованого списку |
| Root рахує програма інкрементально (підхід C) | коли довіра до crank-а щодо root-у стане неприйнятною | без crank-асерту, але log N хешів на кожній зміні балансу (CU), зміна лейауту |
| **Власний L1-vault замість eSPL → суверенний exit** | пост-MVP, окремий редизайн кастоді з новим спеком | депозити в наш PDA-vault, ER = чистий облік, `claim_from_root(proof)` стає справжнім. Ціна: переписати deposit/`credit_deposit`/`withdraw`/`delegate_pool`, повернути собі проблему мосту L1↔ER (потрібен атестатор депозитів або per-deposit делеговані квитанції — конфлікт із «бекенду нема»), зламати зафіксоване арх-рішення тижня 0. Не тиждень 3 |
| **ZK-доказ забезпеченості над приватним root-ом** (week 3 обговорення, 22.09.2026) | пост-MVP, після мітигації #24 (приватний робочий агрегат + публічний знімок) | Публічний знімок несе не сирі `protocol_liquidity`/`locked_total`, а `root + Groth16-proof + огрублений коефіцієнт забезпечення`: схема доводить інваріант §3.6 «Σ маржа + Σ нереалізований PnL за mark ≤ активи пулу» над приватними позиціями як private inputs, прив'язаними до `BalancesRoot`. Примітиви Solana: `alt_bn128` syscalls (BN254 pairing, верифікація Groth16 ≈170–500k CU — раз на 5-хв коміт, дешево), `sol_poseidon` (circomlib-сумісний; **листки root-у переводяться з keccak на Poseidon**, бо keccak у схемі дорогий), Agave 4.0 — BN254 G2 + BLS12-381 для batch-верифікації; тулчейн 2026 — Noir → Sunspot → Gnark-Groth16 + згенерований Solana-верифікатор, наша програма робить CPI у нього з `commit_aggregate`. Прувер = crank у TEE (лише там позиції у відкритому вигляді): ZK знімає довіру до TEE щодо **правдивості числа забезпеченості**, не щодо приватності виконання (вона лишається TEE). Виграш для приватності — differencing-атака при малому anonymity set втрачає точні дельти агрегату (лишається лише «solvent» + огрублений ratio). Ціна: trusted setup Groth16 (або UltraHonk/STARK без setup, але дорожча верифікація), окрема верифікатор-програма, аудит схеми, зміна хеш-примітиви — тижні роботи; пітч-теза «забезпеченість доведена математично, позиції не бачить ніхто» |

**Не в тижні 3:** локальні push, TEE-атестація в застосунку, increase/decrease UI, Railway для crank-fallback.

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
| max_conf | 50 bps; `conf == 0` = «не заповнено» → hard reject на відкриття (check 4). **(week 1, 20.09.2026)** `Market.max_conf_bps == 0` вимикає перевірку conf повністю (`oracle::check_open_quality`, guard пропускається до `require!(conf > 0)`) — новий ризик №11 у §7.1: demo-конфіг ставить `max_conf_bps = 0`, бо devnet-фід стабільно повертає `conf == 0` |
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

**Реалізовано (week 1, 20.09.2026).** Два окремі місця, обидва в `u128`/`checked_*`:

- `oracle::check_deviation` — на `open_position`/`increase_position`, одразу після `check_open_quality`: якщо `Market.mark > 0` і `|index − mark| · 10 000 / mark > Market.max_deviation_bps`, → `DexxerError::OracleDeviation`. `close`/`decrease` цю перевірку ніколи не викликають — вихід має лишатись доступним завжди.
- `crank_tick` — знімок `prev_mark` до EMA-апдейту, `dev_bps` рахується проти `prev_mark` (не проти щойно оновленого mark, інакше EMA цього ж тіку маскує власне відхилення). При спрацюванні: `paused_open = true`, mark усе одно оновлюється EMA (щоб guard сам розходився, коли mark наздоганяє index), але цикл кандидатів на цей тік пропускається (`return Ok(())`) — ліквідацій за тік, чий index відхилився, не буває. Перший тік (`mark == 0`) — сід `mark = index`, перевірки немає.

### 3.5 Crank

Цикл ~1 с: (1) оракул + валідація; stale → скіп ліквідацій, mark не оновлюється; (2) mark-EMA; (3) кандидати з бакетів `±δ` від mark у `MarketRisk`; (4) `equity < MMR × notional` два тики → `liquidate`: закриття за mark, liq fee у пул, лишок → `free_margin`, `ClosedRecord{Liquidated}`; (5) bad debt → `Pool.insurance`, далі капітал, `bad_debt_total` публічний через коміт; (6) підписант `crank_tick` — `Config.crank` або `CRANK_SIGNER` PDA (`magicblock_magic_program_api::pda`); перевірка виконавця scheduler-а — тиждень 2 на devnet **(week 1, 20.09.2026)**.

**Кандидати (week 1, 20.09.2026).** `MarketRisk.buckets` не реалізовано (§8 Q4, §2.1) — кандидати на ліквідацію передаються явно в `remaining_accounts` парами `[Position, UserAccount]`, ≤16 пар (`MAX_CANDIDATES`), кожен акаунт перевіряється на власність програми, writable-прапорець і збіг PDA-деривації перед десеріалізацією (`programs/dexxer_core/src/instructions/crank.rs`). Вибір кандидатів для передачі — відповідальність викликача (crank/fallback-скрипт), не бакетів у `MarketRisk`.

Тригер — MagicBlock scheduler; fallback — `scripts/crank-fallback` з ключем `Config.crank`.

**(week 2, 21.09.2026) Кандидати без реєстру: crank як permission-член.** M2 (`week2-results.md` Task 1) виміряно підтвердив: `getProgramAccounts` із crank-токеном повертає приватні `Position`-акаунти, членом яких є crank (memcmp за дискримінатором акаунта). `MarketRisk.traders`-реєстр (§8 Q4 питання про масштаб) **не додається** — `scripts/crank-fallback/index.ts` шукає кандидатів через gPA + crank-токен, як і планувалось у §2.1/§4.2, а не через окремий індекс. Клієнтський фільтр (не програмна зміна): застарілі `UserAccount`-акаунти (менший layout, лишені попередніми тестовими прогонами) пропускаються до побудови `remaining_accounts` — один недекодований кандидат інакше зривав би весь тік через ранній `?`-return у `crank_tick`.

**(week 2, 21.09.2026) Планувальник реально тікає, підписант — per-authority PDA, не `Config.crank`/плоский `CRANK_SIGNER`.** Три послідовні знахідки на реальному devnet-tee (`week2-results.md` Task 6, три fix-раунди): (1) заплановане виконання `crank_tick` підписує Magic Program сам, значенням `crank_signer_pda(authority)` = `find_program_address(["crank-executor", authority], CRANK_PROGRAM_ID)`, де `authority` — payer (`admin`) `schedule_crank`-транзакції, а не плоский `CRANK_SIGNER` чи `Config.scheduler_signer`-плейсхолдер із Task 1 M1; (2) writable, неделегований акаунт (тут — `Config`) заборонений у `ScheduleCrankCpi`'s `instruction_accounts` безумовно — записати `crank_signer_pda(admin)` у `Config` **в тій самій транзакції**, що й реєструє кранк, структурно неможливо; (3) розв'язано переносом запису на окрему базову admin-інструкцію `set_scheduler_signer` (той самий `AdminConfig`-патерн, що й `pause`/`unpause`), викликану **до** `schedule_crank`. Після цього: `Market.mark_slot` монотонно росте (+18 300 слотів за 183 с) без жодного зовнішнього fallback-процесу — перше пряме підтвердження, що ER-планувальник Magic Actions самостійно виконує `crank_tick` на `dexxer_core`. `crank_tick`'s власний three-way signer-констрейнт (`Config.crank` / `Config.scheduler_signer` / плоский `CRANK_SIGNER`) лишився незмінним усі три раунди — працює через другу гілку тепер, коли `Config.scheduler_signer` дійсно містить `crank_signer_pda(admin)`.

**Уточнення liq fee / insurance (week 1, 20.09.2026).** Тригер ліквідації (крок 4) рахує equity з `close_fee_bps` (6 bps) — `risk::liquidatable_now` → `math::equity(margin, upnl, close_fee)`, поріг `eq/notional < mmr_bps`. Але фактичне розрахування (крок 4, `finalize_close`) стягує `liq_fee_bps` (100 bps), а не `close_fee_bps`. На дефолтних параметрах (`mmr_bps=500`, `close_fee_bps=6`, `liq_fee_bps=100`) це дає трейдеру ефективну «подушку» ≈4,06 % notional на межі спрацювання тригера (margin+upnl на межі = (mmr_bps+close_fee_bps)=506 bps notional; після відрахування liq_fee_bps=100 bps лишається `to_user` ≈406 bps = 4,06 % notional) — ліквідація на самій межі MMR не обнуляє маржу трейдера. Крок 5 спрощено на тиждень 1: `insurance` лише накопичує `liq_fee_bps` (`risk::settle_into_pool`, гілка `liquidation`), **не** витрачається на bad debt — рядок спеки нижче «bad debt → `Pool.insurance`, далі капітал» на тиждень 1 відкладено: нестача одразу йде з `protocol_liquidity` (`settle_into_pool`, `checked_sub` без відкату до `insurance`), `bad_debt_total` — лише статистика.

**Виміряне на devnet-tee (check 5, 19.09.2026):** при запиті `execution_interval_millis = 1000` за 20 с відбулося **27 тіків** (~740 мс середнього інтервалу, ≈1.35 тіка/с). Тобто запитаний інтервал — це **підлога, не період**: тіки приходять раніше, ніж замовлено, і рівний крок не гарантований. Наслідки, обов'язкові до виконання:

- будь-який гістерезис і будь-яке «через N секунд» — рахувати **в тіках**, а не в секундах; нічого нижче за течією не має права припускати фіксовану дельту між тіками;
- бюджет CU/квот рахувати від **верхньої** межі частоти, а не від запитаної;
- продуктовий `crank_tick` **зобов'язаний** валідувати, що викликач — очікуваний crank signer PDA делегаційної програми (вендорний приклад цього не робить: його `increment` permissionless, будь-хто може викликати ліквідаційну логіку поза чергою);
- у продукту має бути **cancel-шлях** для запланованої задачі — у спайку його не було, задача просто самозавершилася після 30-ї ітерації.

### 3.6 Інваріанти (proptest + LiteSVM)

**(week 1, 20.09.2026)** Інваріант переписано під `Pool.protocol_liquidity` (§2.1, §4.1):

```
protocol_liquidity + Σ free_margin + Σ position.margin + fees_accrued + insurance == capital_total == баланс pool eATA
```

`bad_debt_total` — статистика, окремий лічильник; токени не рухає й у суму інваріанта не входить (перевіряється кожним LiteSVM-тестом трейдингу/кранка (`trade`, `resize`, `crank`, `invariants`) через `assert_invariant`/`assert_invariant_ctx`, `tests/litesvm/src/lib.rs`; `admin`/`smoke`/`user` не викликають цю перевірку — там немає торгових дій, що впливають на інваріант).

- `liq_price(long) < entry < liq_price(short)` при рівному lev.
- Округлення не зменшує пул.
- Ліквідація не дає юзеру більше `margin + upnl`.
- Після `close`/`liquidate`: `Position` обнулена, `oi_side −= size`.

### 3.7 Відомі слабкості

MMR 5% при 10x — рух 5% за 1–4 с = bad debt на пул (тестовий). EMA відстає. Один оракул; deviation guard проти другого джерела — v1.

---

## 4. Програма `dexxer_core`

### 4.1 Структури

**(week 1, 20.09.2026)** Структури нижче — фактичний код тижня 1 (`programs/dexxer_core/src/state/*.rs`), не план 18.09. Розходження з початковою версією й чому:

- `Config` отримав `dusdc_mint: Pubkey` (пряме посилання на мінт, замінює похідний доступ) і `disclosure_delay_slots: u64` (параметр затримки розкриття з §1.1/§2.2, раніше не був полем).
- `Market.max_staleness_slots` перейменовано на `max_staleness_secs: u64` — staleness рахується за секундами ER `Clock`, не за слотами (check 4, 19.09.2026, §3.3). Додано `liq_hysteresis_ticks: u8` і `max_stale_ticks: u16` як поля `Market` (гістерезис і поріг паузи — параметри ринку, не константи; check 5, 19.09.2026, §3.5).
- `MarketRisk.buckets: [LiqBucket; 64]` не реалізовано (§8 Q4): кандидати на ліквідацію передаються явно в `remaining_accounts` (§3.5, §4.2), а не вибираються з бакетів у акаунті.
- `Pool.vault_eata` перейменовано на `vault_ata: Pubkey` (це L1 ATA пулу, делегується під eATA — `delegate_pool`, §4.2); додано `protocol_liquidity: u64` (§2.1) — сідується `seed_pool`, є частиною інваріанта §3.6.
- `UserAccount` без змін структурно.
- `Position.liq_ticks: u8` — лічильник гістерезису ліквідації (§3.5), веде crank; `closed: Option<ClosedRecord>` лишився. Додано `oi_notional: u64` — точний внесок позиції в `MarketRisk.oi_long`/`oi_short`, підтримується синхронно на open/increase/decrease. Причина: `entry` — VWAP, що округлюється вгору на кожному `increase_position`, тож перерахунок `notional(size, entry)` при закритті/ліквідації міг перевищити реальний залишок OI (подвійне округлення: VWAP вгору, потім `notional` знов вгору) і underflow'нути `checked_sub` у бухгалтерії OI. Зменшення OI-леджера завжди йде через `Position.oi_notional`, ніколи через перерахунок з VWAP entry.
- Додано `Faucet { version: u8, owner: Pubkey, day_start: i64, minted_today: u64, bump: u8 }` (`[b"faucet", owner]`, §2.1) з `FAUCET_DAILY_LIMIT` — не було в §4.1 плану 18.09, інструкції `faucet_init`/`faucet_mint` §4.2 без `init_if_needed`.

**(week 2, 21.09.2026)** Подальший дрейф від структур тижня 1:

- `Config` отримав чотири нові поля: `scheduler_signer: Pubkey` (адреса, яку `crank_tick`'s signer-констрейнт приймає для запланованих тіків — тиждень 2 з'ясував, що правильне значення — `crank_signer_pda(admin)`, пишеться окремою base-layer інструкцією `set_scheduler_signer`, не аргументом `init_config`), `fee_payer: Pubkey` (лишається записаним у `Config`, але сам структурно ніколи не активує fee-vault-шлях — §2.1, §2.2), `magic_fee_vault: Pubkey` (адреса `FeeEscrow`-vault'а, передається в `.magic_fee_vault(...)`), `crank_task_id: i64` (документоване vestigial-поле — жодна інструкція більше його не пише, реальний `task_id` живе лише в аргументі `cancel_crank(task_id: i64)`, бо запис `Config` у тій самій транзакції, що й `ScheduleCrankCpi`, заборонений on-chain — див. §3.5).
- Нова `FeeEscrow { version: u8, bump: u8 }` (`[b"fee_escrow"]`, §2.1) — делегований admin-gated PDA, єдине призначення — бути CPI-payer'ом `commit_aggregate`/`commit_market`/`withdraw`'s commit-intent.
- `UserAccount` отримав `last_withdraw_slot: u64` — per-account cooldown для `withdraw` (`WITHDRAW_COOLDOWN_SLOTS = 300`), мітигація griefing-ризику спільного `FeeEscrow` (§7.1).
- `MarketRisk.traders`-реєстр (розглядався планом §147 як умовний, «лише якщо gPA не працює для приватних акаунтів») **не додано** — M2 (`week2-results.md` Task 1) підтвердив, що gPA з crank-токеном повертає приватні `Position`, реєстр не потрібен (§3.5).
- `state/permissions.rs` (новий модуль, не окремий акаунт) — `OWNER_FLAGS`/`VIEWER_FLAGS`/`build_members(owner, session, crank)`; `init_permissions`/`set_session` тепер створюють/перебудовують **приватний** 3-членний `EphemeralPermission { is_private: true, members: [owner, session, crank] }` замість тижня-1 публічної 0-членної версії — реалізує §1.1/§2.1 приватність, яка на тиждень 1 була навмисно відкладена.

**(week 3, 22.09.2026)** Дрейф структур тижня 3 (§2.4):

- `UserAccount` отримав `exit_salt: [u8; 32]` (перед `bump`) — випадкові байти, передані клієнтом в `init_user(exit_salt)`; листок `BalancesRoot` хешує `free_margin` разом із ним, щоб root не був корельований між циклами без знання salt.
- `Position.closed: Option<ClosedRecord>` — сам `ClosedRecord` без змін структурно (`commitment_written: bool` уже було полем тижня 3-дизайну), але **справжній порядок полів у коді** — `market, side, size, entry, exit, pnl, fees, reason, opened_slot, closed_slot, salt, nonce, reveal_after_slot, commitment_written` (Task 9 звірив побайтово; попередній чернетковий порядок плану, де `salt` йшов останнім, був хибним і виправлений тут).
- `DisclosureCommitment { hash, batch_slot }` (план 18.09) перейменовано й переформовано в `Commitment { version: u8, hash: [u8;32], slot: u64, nonce: u64, bump: u8 }` (Task 0) — сідиться хешем, не `nonce` (Task 8b, рулінг 9, §2.1).
- `Disclosure` отримав `version: u8` (перше поле) і `bump: u8` (останнє); `owner: Pubkey` лишається полем структури, але завжди записується `Pubkey::default()` — угода публічна, трейдер ні (§2.3). Полів `salt`/`reveal_after_slot`/`commitment_written` **немає** (вони мутабельна бухгалтерія черги, не частина розкритого запису).
- `BalancesRoot` (новий, `[b"balances_root"]`) — **`#[account(zero_copy)] #[repr(C)]`, не Borsh** (Task 5, рулінг 5 — by-value Borsh-десеріалізація 2 KiB-акаунта пробивала SBF-стек, LiteSVM-проба зафіксувала `Access violation in stack frame 3` до конверсії): `{ root_slot: u64, leaves: [[u8;32]; 64], version: u8, filled: u8, bump: u8, _pad: [u8;5] }`, `BalancesRoot::SIZE = 2072` B (8 B дискримінатор + 2064 B структура, без padding holes для `bytemuck::Pod`). Доступ через `AccountLoader<'info, BalancesRoot>`, не `Account<'info, BalancesRoot>`.

```rust
#[account] pub struct Config {
    version: u8, admin: Pubkey, crank: Pubkey, paused: bool,
    oracle_program: Pubkey, tee_validator: Pubkey, dusdc_mint: Pubkey,
    disclosure_delay_slots: u64,
    scheduler_signer: Pubkey, fee_payer: Pubkey, magic_fee_vault: Pubkey,  // week 2
    crank_task_id: i64,        // week 2, vestigial — never written after init_config (§3.5)
    bump: u8,
}

#[account] pub struct FeeEscrow { version: u8, bump: u8 }   // week 2, [b"fee_escrow"], CPI-payer only

#[account] pub struct Market {
    version: u8, symbol: [u8; 8], feed: Pubkey,
    max_lev_bps: u32, imr_bps: u32, mmr_bps: u32,
    open_fee_bps: u16, close_fee_bps: u16, liq_fee_bps: u16,
    oi_cap: u64, max_position: u64, min_size: u64,
    max_staleness_secs: u64, max_conf_bps: u16, max_deviation_bps: u16,
    mark: u64, mark_slot: u64, ema_alpha_bps: u16,
    liq_hysteresis_ticks: u8, max_stale_ticks: u16,
    paused_open: bool, stale_ticks: u16, bump: u8,
}                                               // 128 B (з дискримінатором)

#[account] pub struct MarketRisk {
    version: u8, market: Pubkey,
    oi_long: u64, oi_short: u64, open_positions: u32,
    bump: u8,
}                                               // без buckets (§8 Q4)

#[account] pub struct Pool {
    version: u8, mint: Pubkey, vault_ata: Pubkey,
    capital_total: u64, protocol_liquidity: u64, locked_total: u64,
    fees_accrued: u64, insurance: u64, bad_debt_total: u64,
    last_commit_slot: u64, bump: u8,
}

#[account] pub struct UserAccount {
    version: u8, owner: Pubkey,
    session_key: Pubkey, session_expiry: i64, actions_left: u32,
    free_margin: u64, locked_margin: u64,
    nonce: u64,
    last_withdraw_slot: u64,   // week 2 — per-account cooldown guard on withdraw
    exit_salt: [u8; 32],       // week 3 — BalancesRoot leaf salt, set once in init_user
    bump: u8,
}                                               // 150 B з дискримінатором (week 3: 118 + 32)

#[account] pub struct Position {
    version: u8, owner: Pubkey, market: Pubkey,
    state: PositionState,          // Empty | Open | Closed
    side: Side, size: u64, entry: u64, margin: u64,
    liq_price: u64, opened_slot: u64, liq_ticks: u8,
    oi_notional: u64,              // точний внесок в MarketRisk.oi_long/oi_short
    closed: Option<ClosedRecord>,  // до mark_committed
    bump: u8,
}                                               // 265 B (з дискримінатором)

#[account] pub struct Faucet {
    version: u8, owner: Pubkey, day_start: i64, minted_today: u64, bump: u8,
}                                               // FAUCET_DAILY_LIMIT / добу

pub struct ClosedRecord {
    market: Pubkey, side: Side, size: u64, entry: u64,
    exit: u64, pnl: i64, fees: u64, reason: CloseReason,   // User | Liquidated
    opened_slot: u64, closed_slot: u64,
    salt: [u8; 32], nonce: u64, reveal_after_slot: u64,
    commitment_written: bool,
}                                               // 139 B (Task 9 offsets; field order verified vs code)

#[account] pub struct DisclosureQueue {
    version: u8, owner: Pubkey, head: u8, len: u8,
    records: [ClosedRecord; 8],
    bump: u8,
}

// week 3 (Task 0): DisclosureCommitment { hash, batch_slot } renamed/reshaped to Commitment.
#[account] pub struct Commitment {          // [b"commit", hash] — seed = hash, not nonce (Task 8b, ruling 9)
    version: u8, hash: [u8; 32], slot: u64, nonce: u64, bump: u8,
}
#[account] pub struct Disclosure {          // [b"disclosure", hash]
    version: u8,
    owner: Pubkey,               // always Pubkey::default() — the trade is public, not the trader (§2.3)
    market: Pubkey, side: Side, size: u64,
    entry: u64, exit: u64, pnl: i64, fees: u64, reason: CloseReason,
    opened_slot: u64, closed_slot: u64, nonce: u64,
    bump: u8,
}

// week 3 (Task 5, ruling 5): zero_copy/repr(C), NOT Borsh — see §2.1/§4.1 note above.
#[account(zero_copy)]
#[repr(C)]
pub struct BalancesRoot {                   // [b"balances_root"], SIZE = 2072 B incl. discriminator
    root_slot: u64,
    leaves: [[u8; 32]; 64],
    version: u8, filled: u8, bump: u8,
    _pad: [u8; 5],
}
```

### 4.2 Інструкції

**Колонка «Підписант» — обов'язкова явна перевірка в коді, не опис.** `EphemeralPermission` гейтить **лише читання** акаунтів; сабміт і виконання транзакції не гейтяться зовсім, а `getAuthToken` видається будь-якому ключу з валідним підписом і членства не перевіряє (check 9, 19.09.2026). Тобто не-member спокійно надсилає tx у ER і мутує permissioned-акаунт, якщо сама інструкція його не зупинила. Кожна ER-інструкція сама доводить право підписанта: `has_one`/`constraint` проти `Config.crank`, `Position.owner`, `UserAccount.session_key`, плюс `session_expiry` і `actions_left`.

**(week 1, 20.09.2026)** Таблиця нижче — фактичні інструкції тижня 1. Окремої `deposit`-інструкції на L1 нема: `credit_deposit` сам виконує SPL-transfer і нарахування в одній ER-tx (закриває §8 Q1, детально — §2.2). `init_market`/`init_pool`/`set_params`/`pause`/`unpause` розбито по рядках і доповнено новими адмінськими інструкціями (`seed_pool`, `delegate_market`, `delegate_pool`, `faucet_init`), яких не було в плані 18.09.

| Інструкція | Шар | Підписант | Guards |
|---|---|---|---|
| `init_config`, `set_params`, `pause`, `unpause` | L1 | admin | — |
| `init_market` | L1 | admin | `MarketParams::validate()`; ініціалізує `Market` + `MarketRisk` |
| `delegate_market` | L1 | admin | делегує `Market` + `MarketRisk` у `tee_validator` (без `EphemeralPermission` — жодних per-user полів) |
| `init_pool` | L1 | admin | ініціалізує `Pool` + pool ATA (`associated_token`) |
| `seed_pool` | L1 | admin | admin ATA → pool ATA, звичайний SPL-transfer, **до** делегування; `capital_total` і `protocol_liquidity += amount` |
| `delegate_pool` | L1 | admin | eATA init → депонує **весь поточний баланс** pool ATA (не 0 — task-13 знахідка) → делегує eATA → делегує `Pool`; усі п'ять eSPL/делегаційних PDA (`pool_eata`, `vault`, `vault_ata`, `eata_buffer/record/metadata`) звіряються on-chain деривацією, не довіряються клієнту |
| `faucet_init` | L1 | owner | створює `Faucet` (без `init_if_needed`) + перший мінт під rate-limit |
| `faucet_mint` | L1 | owner | `FAUCET_DAILY_LIMIT`/добу, вікно 86 400 с котиться |
| `init_user(exit_salt: [u8;32])` **(week 3: аргумент `exit_salt`)** | L1 | owner | UserAccount + Position(Empty) + DisclosureQueue, рента під `EphemeralPermission::size_of(3)` на кожен із трьох PDA (`market` тут — address-only перевірка через seeds, не `Account<Market>`: після `delegate_market` акаунт належить Delegation Program на L1); `UserAccount.exit_salt = exit_salt` — клієнт передає 32 випадкові байти (`app/src/lib/session.ts`'s `getOrCreateExitSalt`, `expo-secure-store`) |
| `delegate_user` | L1 | owner | делегує три PDA у `tee_validator` |
| `init_permissions` | ER | owner | три `CreateEphemeralPermissionCpi`/`UpdateEphemeralPermissionCpi` в одній tx — `UserAccount`, `Position`, `DisclosureQueue`, кожен PDA сам платить (закриває §8 Q2); ~~тиждень 1: публічний, 0 членів~~ **(week 2, 21.09.2026) реалізовано:** `EphemeralMembersArgs { is_private: true, members: build_members(owner, session, crank) }` (`state/permissions.rs`) — приватна 3-членна версія `[owner, session, crank]`, гілка `Update` замість `Create`, якщо `perm.owner == PERMISSION_PROGRAM_ID` (перемикає week-1 публічний permission на приватний); ідемпотентність — та сама перевірка власника, не `perm.lamports() > 0` |
| `credit_deposit` | ER | owner | CPI SPL-transfer user eATA → pool eATA + `free_margin += amount`; ідемпотентність конструктивна (кошти вже витрачені першим переказом), не за `(owner, l1_signature)`; `DuplicateDeposit` прибрано (закриває §8 Q1, ризик №1) |
| `set_session` | ER | owner | оновлює `session_key`, `session_expiry`, `actions_left`; **(week 2, 21.09.2026)** додатково перебудовує всі три `EphemeralPermission` (`UpdateEphemeralPermissionCpi`, PDA сама підписує через `invoke_signed`), пропускається per-PDA якщо permission ще не існує |
| `open_position` | ER | session / owner | `!paused`, `!paused_open`, `Empty`, оракул, IMR, lev, OI cap, max_position, min_size, slippage, `actions_left > 0` |
| `increase_position` | ER | session | те саме, `Open`, VWAP entry |
| `decrease_position` | ER | session | `Open`, залишок ≥ IMR або повне закриття |
| `add_margin` | ER | session | `free_margin ≥ amount` |
| `close_position` | ER | session | `Open`, оракул, slippage → `ClosedRecord`, `Closed` |
| `crank_tick` | ER | `Config.crank` **або** `Config.scheduler_signer` **або** плоский `CRANK_SIGNER` PDA (`magicblock_magic_program_api::pda`) | оракул, EMA; кандидати — явні пари `[Position, UserAccount]` у `remaining_accounts`, ≤16 пар (`MAX_CANDIDATES`), кожна пара звіряється на власність програми, writable-прапорець і PDA-деривацію перед десеріалізацією; MMR + гістерезис через `Position.liq_ticks`. **(week 2, 21.09.2026)** середня гілка (`scheduler_signer`) — та, що реально працює для запланованих тіків, коли поле містить `crank_signer_pda(admin)` (§3.5); констрейнт сам не змінювався три fix-раунди |
| `schedule_crank`/`cancel_crank` **(week 2, 21.09.2026, нові)** | ER (Magic Actions) | admin (`has_one`) | будує/скасовує запланований `crank_tick_ix` через `ScheduleCrankCpi`/`CancelCrankCpi`; `schedule_crank` вимагає 7 `remaining_accounts` (`task_context` першим — `AccountInfo`'s інваріантна лайфтайм-семантика 0.16.2 забороняє свіжозібраний локальний масив, потрібен `ctx.remaining_accounts`, genuinely `'info`-scoped); читає (не пише) `config.scheduler_signer` — писати `Config` у тій самій tx, що й `ScheduleCrankCpi`, заборонено (writable-неделегований акаунт, §3.5) | `MissingRequiredSignature`, якщо `config.scheduler_signer != crank_signer_pda(admin)` |
| `set_scheduler_signer` **(week 2, 21.09.2026, новий)** | L1 | admin (`AdminConfig`, той самий патерн, що `pause`/`unpause`) | пише `config.scheduler_signer = new_scheduler_signer`; клієнт передає `crank_signer_pda(admin)`; викликається **перед** `schedule_crank` | `Unauthorized` |
| `init_fee_escrow`/`delegate_fee_escrow` **(week 2, 21.09.2026, нові)** | L1 | admin | ініціалізує й делегує `FeeEscrow` PDA у `tee_validator`, той самий патерн, що `delegate_market`/`delegate_pool` | — |
| `commit_aggregate` | ER | fee-payer (`FeeEscrow`, CPI-рівень) / crank (виклик) | ~~`MagicIntentBundleBuilder`: `Pool`, `UserAccount[]`, `Market` при зміні~~ **(week 2/3, реалізовано)** — комітить `Pool` **і** `BalancesRoot`; CPI-payer — делегований `FeeEscrow` (`build_and_invoke_signed`, не `ctx.accounts.payer` напряму, §2.1/§2.2); `.magic_fee_vault(config.magic_fee_vault)`. **`remaining_accounts`** (`Position`/`DisclosureQueue`, ≤`MAX_ACTIONS_PER_COMMIT=4` дій сумарно) → `add_post_commit_actions` з `write_commitment` (для `Closed && !commitment_written`) **і** `write_disclosure` (для due-записів `DisclosureQueue`, через `due_reveals`) — обидва в одному bundle, окремої `reveal`-інструкції немає. **Викликається щоцикл незалежно від наявності кандидатів** (fix round 1, Task 7) — фіксований 5-хв коміт `Pool`+`BalancesRoot` не залежить від того, чи є щось у `remaining_accounts` | ретрай; `InvalidCandidate` на чужому/недекодовному remaining-акаунті; `TooManyActions` (6039) — лише на `Position`-шляху, `DisclosureQueue`-шлях сам себе кепить бюджетом дій без помилки |
| `commit_market` **(week 2, 21.09.2026, новий)** | ER | admin | той самий шаблон, комітить `market`, без fee vault (admin не делегований payer тут) | — |
| `write_commitment(nonce: u64, hash: [u8;32])` | L1 (Magic Action) | injected escrow signer — **обов'язкова перевірка** | seeds `[b"commit", hash]` **(не `nonce`, Task 8b рулінг 9)**; контекст `#[action]` **мусить** оголосити `source_program` (`address = crate::ID`) перед `escrow_auth`/`escrow` (check 7, 19.09.2026); емітується з `commit_aggregate` на коміті `Pool` для `Position` з `Closed && !commitment_written` |
| `write_disclosure(args: DisclosureArgs, salt: [u8;32])` **(week 3)** | L1 (Magic Action) | injected escrow signer | seeds `[b"disclosure", hash]`, `hash = commitment_hash(&args, &salt)`; перевіряє `hash == Commitment.hash` (`BadDisclosureHash` інакше); `Disclosure.owner = Pubkey::default()`; той самий `source_program`-чек; емітується з `commit_aggregate`, не окремою `reveal`-інструкцією |
| `mark_committed` | ER | crank | `ClosedRecord` → `DisclosureQueue`, `Position → Empty`; crank-асертовано (не перевіряє `Commitment` на L1 самостійно) після спостереження `Commitment` на base — виміряно PASS на devnet (M-B), знімає обмеження «одна позиція за прогін» |
| `init_balances_root`/`delegate_balances_root` **(week 3, нові)** | L1 | admin | той самий `AdminConfig`-патерн, що `init_fee_escrow`/`delegate_fee_escrow`: ініціалізує (`AccountLoader::load_init`, `space = BalancesRoot::SIZE`) і делегує `BalancesRoot` у `tee_validator` |
| `set_balances_root(begin: bool, finalize: bool, padding_seed: [u8;32])` **(week 3)** | ER | crank | `remaining_accounts` = `UserAccount`-и (≤`ROOT_BATCH=16`); кожен звіряється на власність програми, дискримінатор і PDA-деривацію (`InvalidLeafAccount` інакше — фільтрує й застарілий/чужий акаунт); програма сама рахує `leaf = keccak256(owner ‖ free_margin ‖ exit_salt ‖ root_slot)`; `begin` скидає `root_slot`/`filled`, `finalize` заповнює хвіст паддингом `keccak256(padding_seed ‖ i)` до 64; пише публічний `BalancesRoot` (zero_copy), що комітиться з `Pool` — **§2.4.2**. Виміряно PASS (M-E): два послідовних цикли — 64/64 листків змінились |
| `withdraw` | ER → L1 | owner | ~~`free_margin ≥ amount` → eSPL withdraw~~ **(week 2, 21.09.2026)** `require!(amount ≥ MIN_WITHDRAW=1_000_000)`, `require!(slot ≥ last_withdraw_slot + WITHDRAW_COOLDOWN_SLOTS=300)` → `free_margin -= amount` → SPL transfer vault→owner (ER) → commit-intent `UserAccount` через `FeeEscrow` payer + `magic_fee_vault` (потрібен для CPI навіть без live-fee — валідатор вимагає акаунт у списку щоразу, коли payer делегований) → клієнт: `undelegateIx` → поллінг base ATA → `withdrawSpl`. Коміт `UserAccount` не долітає до L1 за задумом (§2.1, ризик #13 — TEE-фільтр, не баг) | `InsufficientMargin`; `InvalidParams` (< MIN_WITHDRAW); `WithdrawCooldown` |
| `undelegate_user` **(week 3, реалізовано)** | ER → L1 | owner | `require!(Position.Empty && DisclosureQueue.len==0 && free_margin==0 && locked_margin==0)` → скраб `UserAccount`/`DisclosureQueue` (усі приватні поля, включно з `last_withdraw_slot`/`exit_salt`) → **явний `a.user_account.exit(&crate::ID)?`/`a.position.exit(&crate::ID)?`/`a.dq.exit(&crate::ID)?`** одразу після скрабу (Task 8c, рулінг 10 — без цього Anchor'ів автоматичний пост-хендлерний `exit()` перезаписує акаунт уже після зміни власника → `ExternalAccountDataModified`) → `CloseEphemeralPermissionCpi` ×3 → `commit_and_undelegate` трьох PDA. **M-A PASS на реальному `dexxer_core`** (Task 8, раунд 2, сиг `3422soh…`, owner-flip за 4.4 с) | `HasOpenPosition`; `QueueNotEmpty`; `BalanceNotZero` |

### 4.3 Помилки

**(week 1, 20.09.2026)** `DuplicateDeposit` прибрано — `credit_deposit` без окремого `deposit`-кроку й без `l1_signature`, ідемпотентність конструктивна (§2.2, §4.2). Додано `PoolInsolvent`, `InvalidCandidate` (crank_tick, §3.5/§4.2), `InvalidOracleAccount`, `AmountZero`, `InvalidParams` (валідація `MarketParams`), `FaucetLimit`. Порядок нижче — код (`programs/dexxer_core/src/errors.rs`); коди `6000..` стабільні для LiteSVM-тестів, нові варіанти лише дописуються в кінець.

`MathOverflow`, `DivisionByZero`, `InvalidInput` (три `MathError`-конверсії, оголошені першими — коди 6000–6002 — і не входили до первісного списку §4.3 плану 18.09, хоч існували в коді й тоді), `Paused`, `OpenPaused`, `StaleOracle`, `OracleConfidence`, `OracleDeviation`, `WrongFeed`, `InvalidOracleAccount`, `InsufficientMargin`, `LeverageTooHigh`, `PositionTooSmall`, `PositionTooLarge`, `OiCapExceeded`, `SlippageExceeded`, `PositionNotEmpty`, `PositionNotOpen`, `NotLiquidatable`, `Unauthorized`, `SessionExpired`, `NoActionsLeft`, `HasOpenPosition`, `QueueFull`, `InvalidActionSigner`, `PoolInsolvent`, `InvalidCandidate`, `AmountZero`, `InvalidParams`, `FaucetLimit`, `WithdrawCooldown` **(week 2, 21.09.2026)** — код `6030`, `withdraw`'s per-account cooldown-гейт (§2.2, §4.2, `WITHDRAW_COOLDOWN_SLOTS = 300`).

**(week 3, 22.09.2026)** Дев'ять нових варіантів дописано строго в кінець, коди `6031`–`6039`: `CommitmentNotWritten` (6031), `RevealTooEarly` (6032), `QueueNotEmpty` (6033, `undelegate_user`), `RootFull` (6034, `set_balances_root` — 65-й листок у циклі), `InvalidLeafAccount` (6035, `set_balances_root` — чужий/недекодовний/застарілий `UserAccount`), `NotClosed` (6036), `BadDisclosureHash` (6037, `write_disclosure` — `commitment_hash(args, salt) != Commitment.hash`), `BalanceNotZero` (6038, `undelegate_user`), `TooManyActions` (6039, `commit_aggregate`'s `Position`-шлях, `MAX_ACTIONS_PER_COMMIT` перевищено — `DisclosureQueue`-шлях сам кепить бюджет без помилки, Task 3).

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

**(week 1, 20.09.2026)** `check_open_quality` реалізує вимикач: `market.max_conf_bps == 0` повертає `Ok(())` одразу, без перевірки `conf_bps > 0` і без порівняння з лімітом — це навмисний параметр ринку (`MarketParams`), не баг, потрібний, бо devnet-фід стабільно віддає `conf == 0` (check 4). Ризик №11 §7.1.

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

**(week 2, 21.09.2026) Реалізовано (Tasks 7–8).** `app/src/lib/er.ts`'s `useTeeConnection()` — owner-нога: MWA `signMessages` + `getAuthToken` (той самий шаблон, що `tests/er/lib/env.ts`'s `teeConn`, через `spikes/mwa.ts`'s `pickSignature` для неоднорідної відповіді `signMessages`). `app/src/lib/session.ts`'s `teeConnectionForSession` — session-нога: підписує локально збереженим `Keypair`, без MWA взагалі (для торгових дій Task 8). Знахідка Task 7: Anchor's `Program.account.<x>.fetch()` падає на Hermes/RN (`buffer-layout`'s `UInt#decode`, `readUIntLE is not a function` — Anchor-бандл закриває власне посилання на буфер незалежно від `global.Buffer`); обхідний шлях — ручні fixed-offset Borsh-читання (`readConfigDusdcMint`, `readUserAccountSessionKey`, `decodePosition`, `decodeMarket` тощо в `app/src/lib/program.ts`), звірені побайтово проти реальних devnet-акаунтів (Task 8 Evidence). Побудова інструкцій (`.methods(...).instruction()`) Anchor-бандлом не зачеплена — лише декодування акаунтів.

### 5.4 Session key

> **Рантайм-знахідки MWA (check 8, 19.09.2026):** `useMobileWallet().account.address` — base58-рядок, не `PublicKey` (типи брешуть); `signMessages` повертає `message ‖ signature` (169 байт), для TEE-челенджу брати останні 64 байти з ed25519-верифікацією; L1-транзакції з MWA — тільки `signAndSendTransaction` (гаманець шле сам, інакше blockhash протухає за round-trip); ER-транзакції — `signTransactions` + власна відправка на TEE-ендпоінт (бюджет ≈1.6–4.6 с). Helper: `app/src/spikes/mwa.ts`.

Генерується локально; secret у SecureStore. Реєструється в MWA-tx онбордингу. `session_expiry` 7 днів + `actions_left` (урок GMX One-Click). Прострочено → MWA `set_session` у ER. Fee payer ER-tx — session key після lamports top-up (підтверджено, check 9, 19.09.2026: свіжий ключ після top-up був payer'ом і єдиним підписантом ER-tx, `meta.err: null`). Втрата телефона → owner робить `set_session(new)`.

**(week 2, 21.09.2026) Реалізовано (Task 7 `app/src/lib/session.ts`).** `getOrCreateSessionKeypair(owner)`/`getSessionKeypair(owner)` — `Keypair` генерується локально, зберігається в `expo-secure-store` під ключем `dexxer.session.<owner base58>`, ніколи не покидає пристрій. **Топ-ап сесії — відхилення від букви плану:** не `lamportsDelegatedTransferIx`, а звичайний `SystemProgram.transfer(owner, session, 0.01 SOL)` на base — `lamportsDelegatedTransferIx`'s `destination` мусить бути вже делегованою (те саме обмеження виміряно в Task 1 M2/M3, Task 5's `fund-fee-payer.ts`), а сесія — звичайний, ніколи не делегований keypair. Звичайний гаманець із base SOL має видимий баланс і в ER (клонується разом з рештою стану) — саме цього достатньо, щоб сесія сплачувала власні ER-комісії, як і задумано. Онбординг-стани (Task 7 `useOnboarding.ts`): `Disconnected → NotOnboarded → Funded → Initialized → Delegated → Credited → Permissioned → SessionSet`, кожен крок ідемпотентний (перевіряє on-chain стан перед виконанням). Торгові дії (Task 8): `openPosition`/`closePosition` підписуються **лише** session `Keypair` локально, без жодного MWA-промпту — `Trade`/`Position`-екрани (§5.5) читають сесію, збережену онбордингом, ніколи не генерують нову (нова сесія без `set_session` дала б `Unauthorized`).

**Членство в permission ≠ право на дію (check 9, 19.09.2026).** Три різні перевірки, які легко сплутати: (1) видача auth-token (`getAuthToken`) — лише підпис, членство не перевіряється, токен отримує будь-хто; (2) **читання** permissioned-акаунта — гейтиться членством, не-member бачить `null`; (3) **сабміт і виконання tx** — не гейтиться нічим, крім логіки самої інструкції. У check 9 session key не був членом (читання давало `null`), але його tx успішно змінила лічильник. Наслідок для нас: session key має бути **і** в `members` (щоб клієнт читав `Position`/`UserAccount`), **і** перевірений у програмі через `UserAccount.session_key` + `session_expiry` + `actions_left` — одного членства мало, воно нічого не забороняє.

### 5.5 Екрани й стани

**UI polish тижня 4 (затверджено 21.09.2026, жорстко 2–3 дні — не за рахунок Seeker/відео):**

| Робимо | Як | Ціна |
|---|---|---|
| Графік ціни | live: тики mark від crank (~1/с) → sparkline/свічки за сесію; історія: Pyth Hermes public API для SOL/USD → свічки 1m/5m/1h; RN-бібліотека (`react-native-wagmi-charts` або `victory-native`) | ~1 день |
| Portfolio-шапка | Total Equity (`free_margin` + `margin` + uPnL за mark), Available (`free_margin`), Unrealized P&L, Margin Ratio (equity/notional vs MMR) — усе з уже читаних `UserAccount`/`Position`/`Market` | ~½ дня |
| Слайдер плеча | margin = notional / leverage замість вільного поля Margin (усуває `InvalidInput 6002` при плечі < 1x, спостережено на демо 21.09) | години |
| **Privacy на видноті** | бейдж на позиції «🔒 Приватна — бачите лише ви (owner, session, crank); на Solscan — нічого»; перемикач **«Очима публіки»** — той самий екран як стороннього: порожньо / `DELeGG…`-оболонка (in-app версія curl-доказу §2.3) | ~½ дня |
| Темна тема, market-header з 24h change | 24h change — з тієї ж Pyth-історії | ~½ дня |
| History / Receipt / countdown розкриття | тиждень 3 (план `2026-09-22-week3-…`) | — |

**Не буде — за дизайном, не «ще не встигли» (в README як v1+ з поясненням):** стакан (контрагент — пул, ціна — оракульний mark; книги фізично нема, як у GMX/Jupiter Perps); limit/open orders/TWAP/hidden (відкладених ордерів немає — `open_position` виконується миттєво за mark зі slippage-захистом; ордер-менеджер потребує crank-виконання — v1+); список ринків/Spot/Options (один SOL-PERP, §1.2); funding countdown (funding не в MVP); TP/SL (умовне закриття в кранку — програмна зміна).

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
| 1 | ~~eSPL у TEE не працює або депозит L1 → `credit_deposit` не зв'язується~~ **ЗАКРИТО (week 1, 20.09.2026, §8 Q1):** `credit_deposit` сам виконує CPI SPL-transfer user eATA → pool eATA в тій самій ER-tx, що й `free_margin += amount` — окремого «зв'язку» L1↔ER не потрібно, план Б (escrow-vault) не знадобився | блокер кастоді (знято) | `tests/er/q1-deposit.ts`, CU 18 090, `week1-results.md` Task 13 Q1 | — |
| 2 | ER не читає неделеговані L1-акаунти | архітектурний | усе, що читає ER-інструкція, — делеговане | тиждень 0 |
| 3 | ~~Scheduler у TEE нестабільний~~ **ЧАСТКОВО ЗАКРИТО (week 2, 21.09.2026):** ER-планувальник Magic Actions реально тіка́є самостійно на `dexxer_core` (виміряно — `Market.mark_slot` монотонно росте без зовнішнього процесу, `week2-results.md` Task 6 fix round 3), підписант — `crank_signer_pda(admin)`, пишеться `set_scheduler_signer` перед `schedule_crank`. `crank-fallback` лишається — не через нестабільність scheduler-а, а як другий незалежний шлях (crank як permission-член, §3.5); Railway-деплой fallback-скрипта — **не зроблено**, поза мандатом тижня 2 | ліквідації | `crank-fallback` як permission-член (реалізовано); Railway — тиждень 3+ | тиждень 2 → 3 |
| 4 | Tx з приватними акаунтами видно не-member'ам | ламає демо | **АКТИВОВАНО (check 6, 19.09.2026).** Метадані (факт, слот, час, успіх, fee, CU) не гейтяться; список підписів по program id відкритий усім. Мітигація: (а) однакова форма tx для всіх дій — ззовні `open`, `close`, `add_margin` нерозрізнювані; (б) cover traffic — `crank_tick` кожну ~1 с є природним chaff'ом, і торгова tx за самими метаданими нерозрізнювана від тіку кранка; (в) чесно описати канал у README і в §2.3. **Спільний sponsor-payer сам по собі не допомагає** — витік іде від списку підписів program id, а не від payer'а. **(week 2, 21.09.2026)** мітигація (а) «uniform tx shape» **ще не зроблена** — `open_position`/`increase_position`/`decrease_position`/`close_position`/`add_margin` лишаються структурно різними інструкціями (різний набір акаунтів/аргументів у самій, гейтованій, частині tx; лише *метадані* — час, факт, fee, CU — вже нерозрізнювані з crank-тіком за (б)); cover traffic (б) підтверджено на практиці: `crank_tick` реально виконується ~1/с (Task 6) | тиждень 0 → постійно |
| 5 | Delegation Actions не дають один MWA-підпис | UX | два підписи | тиждень 1 |
| 6 | ~~`dcap-qvl` WASM не працює в Hermes~~ **ЗАКРИТО (check 11, 19.09.2026):** `verifyTeeRpcIntegrity` виконується на Hermes за ~3.2 с без шимів | довіра | allowlist MRTD/RTMR лишається v1 | — |
| 7 | ~~MWA не підписує tx з ER-blockhash~~ **ЗАКРИТО (check 8, 19.09.2026):** MWA-підпис tx з ER-blockhash прийнято TEE; blockhash→підпис 1.6–4.6 с | `set_session` | `set_session` через MWA на ER — ок; трейди — session key. L1-транзакції з MWA слати через `signAndSendTransaction` (blockhash протухає за round-trip) | — |
| 8 | Смерть devnet-tee під час демо | демо | записане відео + `mb-stack` резерв | тиждень 4 |
| 9 | Соло, 4 тижні | усе | порядок жертв | постійно |
| 10 | Colosseum забороняє код до 28.09 | тиждень 0 | перевірити 19.09; тиждень 0 = spikes | 19.09 |
| 11 | **(week 1, 20.09.2026)** conf на devnet-фіді порожній (`conf == 0` на кожному читанні, check 4) — демо йде з `Market.max_conf_bps = 0`, що вимикає перевірку confidence повністю (`oracle::check_open_quality`) | відкриття без реального сигналу довіри до ціни | продукт: вимагати `conf > 0` і ненульовий `max_conf_bps`; на MVP-devnet прийнято свідомо, бо фід сам ніколи не заповнює conf | тиждень 2+ |
| 12 | ~~`scripts/crank-fallback` шукає кандидатів через gPA — перестає працювати для приватних акаунтів~~ **ЗАКРИТО (week 2, 21.09.2026):** crank — permission-член кожної позиції (`[owner, session, crank]`, §2.1); M2 підтвердив gPA з crank-токеном повертає приватні `Position`; `crank-fallback/index.ts` переведено на `DEXXER_NET=devnet`, gPA з crank-токеном, живе `Market.feed`. Реалізовано клієнтський фільтр застарілих/недекодовних `UserAccount` (§3.5) | fallback-crank сліпне на приватних позиціях → немає ліквідацій без scheduler-а (знято) | crank — permission-член; gPA з crank-токеном | — |
| 13 | **(week 2, 21.09.2026)** `withdraw`'s commit-intent для `UserAccount` жодного разу не долетів до L1 в межах спостереження — три ідентичності, два CPI-payer-конфіги: звичайний `owner` (30+ хв, і досі до-withdraw значення), потім `FeeEscrow`+vault (свіжа ідентичність, ще ~3.5 хв, третє незалежне підтвердження); SPL-нога щоразу коректна. **(оновлено 21.09.2026, з доків MagicBlock)** гіпотеза «навмисно, не баг» тепер **підтверджена механізмом**: доки PER (`onchain-privacy`, `local-development`) кажуть, що приватність — це **фільтрація запитів у TEE/QFS, не шифрування** (*«blocks any wallet not in the member list … rather than encrypting the underlying account data»*); на L1 QFS немає, тож коміт байтів приватного акаунта зробив би їх публічними й знищив би приватність — тому TEE його й не пропускає (скіл: *«publishing a permissioned account is a confidentiality change»*). Прямого рядка «приватні акаунти не комітяться» в доках нема → лишається одне уточнювальне питання до MagicBlock (нижче), але напрям однозначний | `free_margin`/`locked_margin` на L1 лишаються застарілими після виводу; TrustLess-exit-гарантія (§1.1) **не може** спиратися на коміт сирого `UserAccount` — його на L1 не буде за задумом | **рішення (week 2, 21.09.2026):** сирий приватний акаунт **ніколи не йде на L1**; trustless-exit і розкриття будують на окремому **публічному** commitment/root-акаунті (§2.1, нове правило) — він публічний за задумом, тому комітиться нормально (як `Pool`). Питання до MagicBlock звужене: «підтвердіть, що permissioned-акаунти навмисно не комітяться на L1 verbatim, і рекомендований патерн L1-settlement — окремий публічний commitment-акаунт» | тиждень 3 (дизайн від публічного root, не полагодження коміту `UserAccount`). **(week 3, 22.09.2026, Task 8, M-A):** підтверджено ще й на суміжному прикладі — `undelegate_user` (§2.4.3) на реальному `dexxer_core` теж впала на `ExternalAccountDataModified` (Anchor'ів автоматичний `exit()` переписував скрабнутий акаунт уже після зміни власника — рулінг 10, Task 8c), фікс — явний `exit()` до CPI; раунд 2 — PASS (сиг `3422soh…`). Trustless-exit лишається дизайном на публічному `BalancesRoot`, не латкою коміту `UserAccount` |
| 14 | **(week 2, 21.09.2026)** Спільний `FeeEscrow` фінансує і `commit_aggregate` (admin/fee-payer-гейт), і `withdraw` (owner-гейт) — будь-який власник із ненульовим `free_margin` міг раніше викликати `withdraw(1)` повторно й вичерпувати/грифити ескроу, потенційно зупиняючи спек-критичний 5-хв коміт `Pool` | зупинка публічного агрегату | **мітигована, не усунена:** `MIN_WITHDRAW = 1_000_000`, per-account cooldown `WITHDRAW_COOLDOWN_SLOTS = 300` на `withdraw` — уповільнює, не унеможливлює sybil-грифінг багатьма акаунтами | тиждень 2 (мітигація), тиждень 3+ (повне рішення) |
| 15 | **(week 2, 21.09.2026)** Devnet `UserAccount`-акаунти зі старим layout (до `last_withdraw_slot`, 110 B замість 118 B) лишені відкритими з попередніх тестових прогонів — `try_deserialize` їх відхиляє, `crank_tick` без клієнтського фільтра (§3.5) зривався на першому такому кандидаті | тестові позиції на спільному devnet-ринку сліпі для кранка без міграції/фільтра | клієнтський фільтр у `crank-fallback` (реалізовано); програмна міграція — не зроблена, одноразові тестові ідентичності визнано прийнятним сміттям | тиждень 3, якщо продовжувати той самий devnet `Config` |
| 16 | **(week 2, 21.09.2026)** `set_params` (`mmr_bps`/`imr_bps`) діє на весь `Market`, не на одну позицію — зміна параметрів для тестової ліквідації (Task 6, перевірка (c)) заодно ліквідувала непричетну позицію, лишену попереднім тестовим прогоном | побічні ліквідації чужих/тестових позицій на спільному devnet-ринку | обмежити тестові `set_params`-зміни ізольованим ринком/ідентичністю; продукт — окремий тестовий `Market` на майбутнє | тиждень 3 (тест-дизайн) |
| 17 | ~~**(week 2, 21.09.2026)** Повний мобільний цикл Open→Close (Task 8) не підтверджено на реальному пристрої/емуляторі~~ **ЗАКРИТО (verified live, 21.09.2026, вечір):** повний цикл пройдено на емуляторі `local_phone` з fakewallet проти реального devnet-tee — онбординг до `SessionSet` (включно з `credit_deposit`/`init_permissions`/`set_session`, які досі були pending-human), **Open** Long 1 SOL (session-ключем, БЕЗ промпту гаманця, sig `xyNZRdf16WD7Nn4w41KCAPpzrEyVbf7QhiN2F7eg9FYZsmUiDbGB8v…`), Position live (Entry $117.90 / Mark / Liq $103.80 / uPnL / Free margin $979.93), **Close** (session-ключем, без промпту, sig `2HQvNejHFky8kyMV9ztNcok8nfaxEZpsS2mQHti1zbDrcbDZnd8XaBw…`). Owner `4xkT8WmjSHpDEACcqY1Yq43yQxgoZHi6S3a6om3wXvKB`, Position PDA `GJWb9fNkgKGs7LPEYDVc1pFtkzJdxNdtgUefZbTSj1zS`. Приватність підтверджено наживо: base L1 → owner `DELeGG…` (делегована оболонка, полів нема); TEE без токена → `value: null`. **Два блокери, знайдені й усунені по дорозі:** (a) fakewallet's `SendTransactionsUseCase` відхиляє multi-ix `delegateSpl` (code -2 "payloads invalid for signing") — обійдено: L1-кроки тепер MWA `signTransactions` (sign-only) + сабміт застосунком (`useOnboarding.ts`); (b) eSPL re-cycle `InvalidAccountOwner` на повторному ключі — fakewallet-ключ ротується через `adb shell pm clear com.solana.mobilewalletadapter.fakewallet`; свіжий ключ проходить `delegateSpl` чисто | — (закрито) | харнес-нотатки: емулятор піднімати з `-dns-server 8.8.8.8,8.8.4.4` проти DNS-блипів `rpc.magicblock.app`; для чистого прогону — `pm clear` fakewallet + `com.dexxer.app` (ротує ключ, чистить кеш авторизації) | закрито 21.09 |
| 18 | ~~**(week 2, 21.09.2026)** Планувальник запускається з **кінцевим** `iterations`~~ **ВИМІРЯНО, РОЗВʼЯЗНЕ (week 3, 22.09.2026, Task 1 M-D):** `iterations = i64::MAX` **приймається й реально тіка́є** (81 тік за ~65 с на devnet-tee, спайк 05) — некостильне рішення існує й підтверджене, не гадка. `0`/`-1` **FAIL** (`invalid instruction data`, симуляція, без підпису); self-reschedule (запланована `crank_tick` сама викликає `schedule_crank`) **FAIL** при реєстрації (`missing required signature`); персистентність через рестарт валідатора — **не виміряно** (нема вікна рестарту в сесії цього тижня) | планувальник тихо зупиняється, якщо хтось не перезапустить `schedule_crank` з `i64::MAX` | `i64::MAX` — чистий, некостильний фікс; **ніхто ще не перезапустив продакшн-планувальник із цим значенням на devnet** (виміряно на окремому спайку, не на `dexxer_core`'s реальному розкладі) — `crank-fallback` лишається завжди-онлайн шляхом, доки хтось це не зробить. Персистентність через рестарт — відкрите | тиждень 4 (застосувати `i64::MAX` на реальному розкладі; виміряти рестарт) |
| 19 | **(week 3 design, 21.09.2026)** `BalancesRoot` формує crank: програма рахує листки з реальних байтів `UserAccount` (підробити баланс неможливо), але crank **може пропустити** юзера з `remaining_accounts` → того юзера нема в квитанції | юзер не може довести борг; торгівлі не шкодить | юзер бачить відсутність свого листка у власному Receipt-екрані одразу (Task 9, `ReceiptSection`); апгрейд C (root у програмі) усуває довіру до crank-а щодо root-у. **Виміряно на практиці (Task 8):** 8 із 12 devnet `UserAccount` (старий layout weeks 1–2) реально пропущені `set_balances_root`-циклом — ризик не гіпотетичний, мітигація (клієнтський фільтр у crank, Task 8b) уже покриває саме цей випадок | тиждень 3 (визнано, спостережено), пост-MVP (усунення) |
| 20 | **(week 3 design, 21.09.2026)** `mark_committed` — crank-асертований: ER не читає L1 (ризик #2), тому факт «`Commitment` записано» програма не перевіряє сама, а вірить crank-у | зловмисний crank може перевести `Position → Empty` без реального commitment на L1 → угода без 13F-сліду | crank уже довірений як ліквідатор і member усіх акаунтів — нової сторони довіри нема; L1-`Commitment` публічний, тож пропуск видно будь-кому постфактум. **Виміряно (Task 8, M-B):** на devnet crank коректно чекав появи `Commitment` перед викликом, `mark_committed` знімає ліміт «одна позиція за прогін» — happy path підтверджено, зловмисний сценарій навмисно не тестувався | тиждень 3 (визнано) |
| 21 | **(week 3 design, 21.09.2026)** `BalancesRoot` — cap 64 юзери (плаский список); N приховано паддингом, «чий баланс змінився» — прив'язкою до `root_slot`; **L1-claim відсутній**: Global Vault `2BX6ZNoX…` належить програмі eSPL `SPLxh1LV…`, не нам — вихід без TEE залежить від eSPL/MagicBlock | при смерті TEE кошти виводить лише MagicBlock; root = доказ боргу для них | узгоджено з моделлю довіри §0.4 («не від оператора»); апгрейди §2.4.5: merkle при N>64, власний vault = суверенний exit (пост-MVP редизайн). **Виміряно (Task 8, M-E):** два послідовних коміт-цикли на devnet-tee — усі 64/64 листки змінились між ними, прив'язка до `root_slot` підтверджена наживо, не лише дизайном | пост-MVP |
| 23 | **(week 3, 22.09.2026, Task 8, рулінг 8, спостереження)** `commit_aggregate`, підписаний **лише** `Config.fee_payer` (НЕ member `EphemeralPermission` жодної `Position`/`DisclosureQueue` — члени лише `[owner, session, crank]`), успішно включив приватний `Position` у `remaining_accounts` і виконав tx на devnet-tee (perm `is_private: true`, member-список підтверджено, сиг у `task-8-report.md`) | **TEE-permission-шар, схоже, гейтить лише читання через RPC (`getAccountInfo`/gPA), а не включення акаунта в tx недо-членом** — якщо зловмисна не-member-програма вміє скопіювати байти приватного акаунта в публічний у межах тієї самої tx, це потенційний канал витоку повз permission. Наша програма сама лише пише прапорець (`commitment_written`), нічого не копіює назовні — прямого витоку не знайдено, це відкрите питання до MagicBlock, не підтверджений злом | не мітигується — відкрите питання, записане тут навмисно як спостереження + питання, не як підтверджений витік | тиждень 3 (спостережено), питання до MagicBlock — тиждень 4 |
| 24 | **(week 3, 22.09.2026, Task 11, контролер-верифіковано в коді)** `Pool` і `MarketRisk` **НЕ permissioned в ER** (`CreateEphemeralPermissionCpi` викликається лише в `init_permissions` для `UserAccount`/`Position`/`DisclosureQueue`, `instructions/user.rs`; `delegate_pool`/`delegate_market` не створюють permission — код прямо це документує: *«Neither carries user-scoped fields, so no ER permission account is created for them here»*) — будь-хто з ER RPC-доступом читає `Pool` (`capital_total`, `protocol_liquidity`, `locked_total`, `fees_accrued`, `insurance`, `bad_debt_total`) і `MarketRisk` (`oi_long`/`oi_short`, `open_positions`) на кожному ER-блоці | попер-блочні дельти `Pool`/`MarketRisk` видають бік (`oi_long`/`oi_short`) і розмір (`locked_total`/OI-дельта) окремих дій у реальному часі — обходить 5-хв batch-мітигацію L1 (§2.1), яка стосується лише коміту, не живого ER-читання | **не мітигується цього тижня, записано для тижня 4:** (a) permission `MarketRisk`+`Pool` (`[crank, admin]`, пізніше LP-читачі) — робить ER-копію приватною, публічний 5-хв коміт лишається єдиним публічним знімком; (b) розділити на приватний робочий агрегат + публічний знімок, що оновлюється за розкладом коміту. **(a) конфліктує з тим, що `Pool` комітиться як є** (permissioned-акаунт не можна комітити сирим, ризик #13) → **(b) — узгоджений напрям**: `Pool` лишається публічно-комітованим, але несе лише те, що можна розкривати щоблоку, живі лічильники переїжджають у permissioned робочий акаунт **Далі (обговорення 22.09.2026):** публічний знімок як `root + ZK-доказ забезпеченості + огрублений ratio` замість сирих агрегатів — знімає точні дельти навіть зі знімка (§2.4.5, рядок «ZK-доказ забезпеченості»); (b) — передумова для цього | тиждень 4 (дизайн + рішення) |
| 25 | **(week 3, 22.09.2026, фінальне ревʼю гілки, I-1)** сіль commitment-у передбачувана: `ClosedRecord.salt = keccak(owner ‖ UserAccount.nonce ‖ closed_slot)` (`instructions/trade.rs`, `finalize_close`) — усі три входи відновлювані зовні (`owner` з L1-PDA `[b"user", owner]`, `nonce` — малий лічильник, `closed_slot` — обмежений вікном спостереження) | публічний `Commitment.hash` можна перебрати проти публічного ряду mark-цін ДО `reveal_after_slot` — саме те, від чого має захищати затримка розкриття (продуктова заявка «30 днів») | **не мітигується цього тижня** (на devnet затримка — хвилини, реальних грошей нема). Тиждень 4: сіль з TEE-рандому або клієнтська per-close сіль (передається в `close_position`, зберігається в `ClosedRecord`), формула `commitment_hash` не змінюється | тиждень 4 |
| 26 | **(week 3, 22.09.2026, рулінг 7 + фінальне ревʼю, I-2)** дроп Magic Action на L1 (одна невдала BaseAction знімає всі actions bundle-у) — незворотний для запису: (а) `write_commitment` не долетів → `commitment_written = true` в ER без L1-`Commitment`; `mark_committed` (гейт crank-а на існування `Commitment`) не спрацьовує ніколи → `Position` застигає `Closed`, блокує `open_position` і `undelegate_user` цього трейдера; (б) `write_disclosure` не долетів → запис уже витягнуто з `DisclosureQueue` (pop у момент емісії, рулінг 7) → `Disclosure` не з'явиться ніколи | втрата розкриття або застиглий трейдер після одного дропу bundle-у (на devnet раунди 1–2 дропів не спостерігали) | **прийняте обмеження MVP**: програма не має шляху повторної емісії. Тиждень 4: admin/crank-інструкція re-emit (скинути `commitment_written` при відсутності `Commitment` на L1 за crank-асертом, як #20) і/або pop після підтвердження замість pop-при-емісії | тиждень 4 |
| 22 | **(week 2, 21.09.2026, UX-борг з живого демо)** Мобільний онбординг вимагає **4 MWA-промпти** (`faucet_init`, `init_user`, `delegateSpl`, `delegate_user` — кожен окрема L1-tx) проти цілі §1.1 «один підпис, fallback два»; застосунок дозволяє стартувати з **0 SOL** → непрозорий `confirm timeout` (спостережено 21.09: юзер натиснув Continue до фандингу, tx у мережу не потрапила); таймаут підтвердження 15 с (100×150 мс) короткий для навантаженого devnet; свіжий ключ для повторного демо потребує `pm clear` обох застосунків (нема in-app «Disconnect & forget»); `fund session` — окремий видимий крок | демо-фрикція і плутанина на Seeker: зайві тапи, помилки без пояснення, неможливість почати заново з UI | (a) **батчити L1-кроки в ≤2 tx** (ліміт 1232 Б; `delegateSpl` сам ~590 Б → реально 2 промпти = spec'овий fallback), session top-up — у ту ж tx, що `delegate_user`; (b) **pre-flight**: перевірка SOL ≥ рента 3 PDA (≈0.0133) + комісії ≈ 0.05 SOL до кроку 1, екран «поповніть гаманець» з адресою/копіюванням, робочий in-app airdrop (Account-таб зламаний — pre-existing); (c) довший/конфігурований `confirmOnConn` для L1 + показ підпису й підказки «повторити»; (d) in-app «Disconnect & forget» (чистить MWA-кеш авторизації + `expo-secure-store`); (e) статус-текст кроків для юзера, не лише лог; (f) **Trade/Position не перечитують session key після онбордингу** (`useTradeSession.ts:47` — одноразовий `useEffect`, без `useFocusEffect`/події): якщо таб змонтувався до `set_session`, показує «not set — finish onboarding first» до рестарту застосунку (спостережено 21.09 на другому демо-прогоні); фікс — `useFocusEffect` або подія завершення онбордингу | тиждень 4 (polish перед Seeker/відео) |

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

**Тиждень 3 · 12.10–18.10 — 13F, полірування.** `ClosedRecord` → `DisclosureQueue` → `write_commitment` → `reveal`; History; локальні push; TEE-атестація або fallback; crank-fallback; CI. П'ятниця: повний цикл + три кадри демо. **(week 3 scope, затверджено 21.09.2026, §2.4):** 13F-ядро на коміті `Pool` + `mark_committed`/`reveal`; `BalancesRoot` (квитанція, без L1-claim); `undelegate_user`; History-таб + Receipt-секція; CI; виміри M-A…M-E першими. **Вирізано** (spec'овий порядок жертв): локальні push, TEE-атестація в застосунку. Фактичний старт — 22.09 (≈3 тижні попереду календаря).

**(week 3 факт, 21–22.09.2026)** Виконано за два дні, не тиждень: SDD-план `2026-09-22-week3-disclosure-root-exit.md`, задачі 0–10 + фікс-раунди (8b/8c), branch `week3-disclosure-root-exit`, base `53ae985`. 21.09 — Tasks 0–6 (стан/помилки/`exit_salt`, `write_commitment`/`write_disclosure`, `commit_aggregate`-дії, `mark_committed`, `BalancesRoot`, `undelegate_user`); STOP по команді юзера. 22.09 — Task 7 (crank-цикли, golden vectors), Task 8 (редеплой + devnet M-B/M-E/M-A, два раунди — рулінги 9/10 знайдено й виправлено між ними), Task 9 (History/Receipt, код-only), Task 10 (CI), Task 11 (ця документація). LiteSVM 39 → 65, unit 46 → 51. **Перенесено в тиждень 4** (не встигли/свідомо відкладено): локальні push, TEE-атестація в застосунку, increase/decrease UI, Railway для crank-fallback, `MarketRisk.buckets`, uniform tx shape (ризик #4), merkle-root (N>64), власний vault (§2.4.5), Task 9 живий прогін на емуляторі + скріншоти, перший реальний прогін CI на PR, `i64::MAX`-перепланування на продакшн-розкладі devnet, очищення legacy `UserAccount`, питання #23 до MagicBlock, ризик #24 (Pool/MarketRisk permission у ER).

**Тиждень 4 · 19–25.10 — Seeker, відео, подача.** Реальний Seeker; відео 2–3 хв; README; подачі. Пост №3. **(затверджено 21.09.2026)** + UI polish 2–3 дні за §5.5 (графік mark, portfolio-шапка, слайдер плеча, privacy-бейдж/«очима публіки», темна тема) + UX-борг онбордингу (§7.1 #22: ≤2 MWA-промпти, pre-flight SOL, «Disconnect & forget», re-read session key). Порядок жертв усередині тижня 4: темна тема → 24h change → графік історії → **ніколи**: Seeker-тест, відео, privacy-бейдж.

**Резерв · 26.10–02.11.**

### 7.4 Успіх

Реальний Seeker: депозит → приватний лонг → Solscan мовчить → чужий гаманець отримує відмову → crank ліквідує тестову позицію за MMR → закриття → commitment на L1 → reveal, хеш збігається. Не встигли 13F або push — чесний розділ README. Не встигли Seeker — провал.

---

## 8. Відкриті питання (закриваються тижнем 0, не документом)

1. ~~Механізм зв'язку депозиту на L1 з `credit_deposit` в ER~~ **ЗАКРИТО тижнем 1 (20.09.2026), деталі — `docs/superpowers/plans/week1-results.md` Task 13 Q1.** Відповідь: жодного окремого «зв'язку» немає. `credit_deposit` — owner-signed ER-інструкція, що сама робить CPI SPL-transfer user eATA → pool eATA і в тій самій транзакції `free_margin += amount`; ніякого крана, callback'а чи `l1_signature` не потрібно. CU 18 090 на mb-stack (`tests/er/q1-deposit.ts`). Ідемпотентність — конструктивна: подвійний `credit_deposit` тим самим переказом фізично неможливий, бо джерельні кошти вже витрачені першим переказом (SPL `insufficient funds` на другій спробі); `DuplicateDeposit` як окрема помилка прибрано з §4.3.
2. ~~Чи можна створити `EphemeralPermission` на трьох PDA в одній Delegation Actions-транзакції~~ **ЗАКРИТО тижнем 1 (20.09.2026), деталі — `week1-results.md` Task 13 Q2.** Відповідь: так. `init_permissions` (ER, owner) — одна tx, три `CreateEphemeralPermissionCpi` (`UserAccount`, `Position`, `DisclosureQueue`), кожен PDA сам платить за свій permission-акаунт. CU 57 615. Тиждень 1: публічний permission (`is_private: false, members: []`) — приватна 3-членна версія `[owner, session, crank]` лишається тижню 2. Ідемпотентність другого виклику — за `perm.owner == PERMISSION_PROGRAM_ID`, не за лампортами: свіжий `EphemeralPermission` на цій версії mb-stack має **0 лампортів** (рента йде у спільний `ephemeral_vault`, не на сам акаунт) — `perm.lamports() > 0` як ознака «вже створено» не працює.
3. ~~Розмір `Position` + `DisclosureQueue` та рента при онбордингу~~ **ЗАКРИТО тижнем 1 (20.09.2026), деталі — `week1-results.md` Task 2 (з правкою від 20.09) і §4.1 вище.** Виміряні розміри (з 8-байтним дискримінатором Anchor): `UserAccount` 110 B, `Position` **265 B** (257 B у першому вимірі Task 2 + 8 B за нове поле `Position.oi_notional`, додане пізніше в тижні 1 — див. правку в `week1-results.md`), `DisclosureQueue` 1156 B, `Market` 128 B. L1-рента (`Rent::default()`, формула `(space + 128) × 6960`) за три user-PDA (`UserAccount` + `Position` + `DisclosureQueue`) разом — **13 328 400 лампортів (≈0.0133 SOL)** (було 13 272 720 до додавання `oi_notional`). Префандинг трьох ER-permission-акаунтів на онбординг (`EphemeralPermission::size_of(3)` через `ephemeral_accounts::rent`) — 7264 лампорта кожен, 3 × 7264 = 21 792 лампорта сумарно; це прогноз під **майбутню приватну 3-членну** версію (тиждень 2) — фактична вартість поточної, публічної, 0-членної версії тижня 1 виявилась меншою, **4096 лампортів** на permission (виміряно на mb-stack, Task 13 Q2), тож префанд із запасом покриває week-1-версію і свідомо лишається розрахованим під week-2-версію, а не зменшується.
4. Чи потрібен `MarketRisk.buckets` на MVP-обсязі — лишити структуру, заповнювати лінійно. **Примітка (week 1, 20.09.2026):** код пішов іншим шляхом — `buckets` не реалізовано взагалі; кандидати на ліквідацію передаються явно парами `[Position, UserAccount]` у `remaining_accounts` `crank_tick` (§2.1, §3.5, §4.1, §4.2). Питання №4 лишається відкритим у первісному сенсі (чи знадобляться бакети для масштабу за межами MVP), але поточна відповідь тижня 1 — ні, явних кандидатів достатньо.
5. Formatting `Disclosure` для explorer — чи достатньо `getProgramAccounts` по discriminator без індексера при десятках записів.
6. ~~Чи `getProgramAccounts` повертає приватні акаунти члену-crank (без окремого реєстру `MarketRisk.traders`)~~ **ЗАКРИТО тижнем 2 (21.09.2026), M2 — `week2-results.md` Task 1.** Відповідь: так. gPA з crank-токеном + memcmp за дискримінатором повертає приватні `Position`; `stranger`-токен і без токена — `null`/`[]`. `MarketRisk.traders` не додається (§2.1, §3.5, §4.1).
7. **(week 2, 21.09.2026, нове)** Скільки реально коштує коміт `Pool` через `FeeEscrow` на добу за межами безкоштовних плейсхолдер-nonce (nonce ≥ 25, за `fees-and-commit-economics.md` — «live fee» ~100 000 лампортів/акаунт). Виміряно лише nonce 11–22 (0 списання, узгоджено з правилом «nonce < 25 = 0»); реальна ціна після nonce 25 **не виміряна в цій сесії** — потребує довшого прогону (25+ комітів на одному `Pool`) без перезаходу на новий `Config`. Відкрите для тижня 3.
8. ~~**(week 2, 21.09.2026, нове)** Чому `withdraw`'s commit-intent для `UserAccount` не долітає до L1~~ **ЗАКРИТО механізмом (21.09.2026, вечір):** доки MagicBlock (`onchain-privacy`, `local-development`) — приватність у PER це фільтр читання в TEE/QFS, не шифрування; на L1 фільтра нема, тож коміт сирого permissioned-акаунта знищив би приватність — TEE його не пропускає **за задумом**. Наслідок — правило §2.1 (сирий приватний акаунт ніколи не йде на L1) і дизайн §2.4 (усе L1-bound — через публічні `Pool`/`BalancesRoot`/`Commitment`/`Disclosure`). Лишилось одне підтверджувальне питання до MagicBlock (ризик №13).
9. ~~**(week 3, 21.09.2026, вимір M-A)** Чи долітає `commit_and_undelegate` акаунта, permission якого щойно закрито `CloseEphemeralPermissionCpi`~~ **ЗАКРИТО (22.09.2026, Task 1 + Task 8).** Так, за умови явного `exit()` перед CPI. На одноакаунтному спайку — PASS з першої спроби (Task 1). На реальному `dexxer_core` (3 акаунти) — раунд 1 FAIL (`ExternalAccountDataModified`, корінь — Anchor'ів автоматичний пост-хендлерний `exit()` переписував скрабнутий акаунт уже після зміни власника всередині `commit_and_undelegate`, рулінг 10, Task 8c); фікс — явний `exit()` одразу після скрабу, до CPI; раунд 2 — **PASS**, сиг `3422soh…`, owner-flip на base за 4.4 с. Нове правило для коду: **будь-яка інструкція, що мутує акаунт і потім undelegate'ить його, мусить викликати `exit()` явно перед CPI.**
10. ~~**(week 3, 21.09.2026, вимір M-B)** Чи Magic Action, додана `add_post_commit_actions` до коміту публічного `Pool`, реально виконується на L1~~ **ЗАКРИТО PASS (22.09.2026, Task 8).** `Commitment`/`Disclosure` реально створюються на base (latency 1.1–1.4 с / 3.0 с відповідно від ER-сигу), хеш збігається, `mark_committed` знімає ліміт «одна позиція за прогін» — друга позиція тим самим гаманцем відкрита одразу.
11. ~~**(week 3, 21.09.2026, вимір M-C)** Скільки Magic Actions вміщує один bundle `commit_aggregate`~~ **ЗАКРИТО (22.09.2026, Task 1 fix round 1).** **28 PASS / 29 FAIL** (`0xa0000002`) на свіжому акаунті — перший сирий вимір (24/25) виявився зіткненням із Path-A 10-комітною квотою (`0xa0000000`=`COMMIT_LIMIT_ERR`), не тим самим лімітом. `MAX_ACTIONS_PER_COMMIT` лишено `4` (великий запас; реальна дія `write_commitment`/`write_disclosure` дорожча за вимірювану дію, повторний вимір на реальній формі не проведено — поза бюджетом Task 8).
12. ~~**(week 3, 21.09.2026, вимір M-D, тех-борг №18)** Планувальник: `iterations`~~ **ЗАКРИТО, розвʼязне (22.09.2026, Task 1).** `i64::MAX` **PASS**, реально тіка́є (81 тік/65 с); `0`/`-1` **FAIL** (`invalid instruction data`); self-reschedule **FAIL** при реєстрації (`missing required signature`); персистентність через рестарт валідатора — **не виміряно** (нема вікна рестарту в сесії). Некостильний фікс існує (`i64::MAX`), але ще не застосований на реальному продакшн-розкладі devnet — `crank-fallback` лишається завжди-онлайн шляхом до цього (тиждень 4, §7.1 #18).
13. ~~**(week 3, 21.09.2026, вимір M-E, розширює п.7)** Реальна вартість fee-vault-комітів після nonce 25 для **двох** акаунтів на коміт~~ **ЗАКРИТО (22.09.2026, Task 8).** **100 000 лампортів/акаунт-коміт після того, як акаунтів власний commit-nonce ≥ 25** — раунд 1 платив лише `Pool` (100k/коміт, свіжий `BalancesRoot`), раунд 2 платив обидва (200k/коміт, обидва акаунти вже за порогом); арифметика точно збігається з виміряною дельтою ескроу (`12 × 200 000 = 2 400 000`). Два послідовних цикли також підтвердили: усі 64/64 листки `BalancesRoot` змінюються кожного коміту.

---

*Живе разом із `dexxer-architecture.md` (обґрунтування, витік-модель, конкурентна рамка) і `solana-perp-privacy-landscape.md` (ринок). `dexxer-plan.md` §2–3 застарілі й замінюються §1 і §7.3 цього документа.*
