# Тиждень 1 — результати

## Task 0: гілка, тулчейн-гейт, LiteSVM-крейт, інвентар mb-stack

### Тулчейн-гейт

- `anchor-cli 1.0.2`, `solana-cli 3.1.9` (jsonrpc), CLI-бінарник `solana 3.1.10`, `cargo 1.89.0` — відповідають правилу.
- **Знахідка (виправлено)**: у `target/deploy/` на цій машині не було keypair-файлу, що відповідав би первісному `declare_id!("Htuaqktaa4MkdBS3nbFcoRZuVdLHowZknpW35EokXXxT")` — ніде в репо (програмний ID ніколи не деплоївся: тиждень 0 деплоїв лише spike-програми). Виправлено `anchor keys sync` — деталі й новий program id у розділі «Program id» нижче. Звичайний `anchor build` (без прапорців) тепер працює.
- **Знахідка (nightly для litesvm)**: `litesvm =0.16.0` з пінами з брифу не компілюється на pinned stable `1.89.0` — транзитивний `solana-syscalls 4.2.2` (тягнеться через `solana-builtins`/`solana-bpf-loader-program`, обов'язкова, не вимкнена фіча `agave-unstable-api`) використовує unstable `MaybeUninit::write_copy_of_slice` (`#![feature(maybe_uninit_write_slice)]`) без власного `#![feature(...)]`-гейту — апстрім-баг у крейті, опублікованому 28.08.2026; полагоджений у `solana-syscalls 4.3.0` (опубліковано 18.09.2026), але жодна опублікована версія `litesvm` (перевірено `0.16.0`, `0.15.2`, `0.14.0`) ще не підняла пін до `>=4.3.0` — всі резолвляться рівно в `4.2.2`. `litesvm 0.13.1` (і старіше) конфліктує напряму з `ephemeral-rollups-sdk =0.16.2` (через `solana-instruction`), тому недоступний для цього воркспейсу незалежно від бага.
  - Спроба `RUSTC_BOOTSTRAP=1` на pinned stable не допомагає: сам крейт не декларує `#![feature(...)]`, тому компілятор відмовляє навіть у bootstrap-режимі.
  - Перевірено, чи `cargo update -p solana-syscalls --precise 4.3.0` дає резолвитись без зміни версії `litesvm` (caret `^4.2.1` дозволяє `4.3.0` формально) — **не резолвиться**: `litesvm 0.16.0` сам напряму пінить `solana-hash = "~4.5.0"` (тільда, патч-апдейти в межах 4.5.x), а `solana-syscalls 4.3.0` вимагає `solana-hash ^4.6.0` — два прямі requirements ОДНОГО крейту (`litesvm 0.16.0`) стають взаємно нерозв'язними; `--precise` тут не допомагає, бо конфлікт не в глибині графа, а в самому маніфесті `litesvm`. Немає жодної опублікованої версії `litesvm` новішої за `0.16.0`, яка підняла б цей пін.
  - **Робоче рішення (лишається)**: встановлено датований nightly `rustup toolchain install nightly-2026-09-18` (не чіпаючи кореневий `rust-toolchain.toml`, який лишається `1.89.0` — використовується для збірки самої програми). LiteSVM-тести запускати командою `cargo +nightly-2026-09-18 test -p dexxer_litesvm --test smoke` (а не голим `cargo test`). Записано також у `docs/superpowers/plans/2026-09-19-week1-core.md` → Global Constraints, оскільки стосується всіх наступних задач тижня 1, що писатимуть LiteSVM-тести.

### Program id

`anchor keys sync` виконано: `declare_id!` у `programs/dexxer_core/src/lib.rs` і `[programs.localnet] dexxer_core` у `Anchor.toml` переписані на pubkey наявного локального `target/deploy/dexxer_core-keypair.json` — **`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`** (замінив первісний `Htuaqktaa4MkdBS3nbFcoRZuVdLHowZknpW35EokXXxT`, для якого keypair ніколи не існував). Keypair-файл: `target/deploy/dexxer_core-keypair.json`, гітігнорений (`target/`) — **треба зберегти саме на цій машині** до week 2, коли буде вирішено питання постійного зберігання program-keypair (наприклад окреме безпечне сховище або комітований `keys/` каталог поза `target/`). Звичайний `anchor build` (без `--ignore-keys`) тепер проходить без помилок.

### Точні піни `tests/litesvm`, що зібралися (nightly-2026-09-18, `rustc 1.100.0-nightly 330d31712 2026-09-17`)

З `Cargo.toml` (як у брифі, без змін):
```
litesvm = "=0.16.0"
anchor-lang = "=1.0.2"
solana-pubkey = "4"
solana-keypair = "3"
solana-signer = "3"
solana-instruction = "3"
solana-message = "4"
solana-transaction = "4"
solana-account = "4"
solana-clock = "3"
solana-system-interface = "3"
```

Резолвлені прямі залежності (`cargo tree -p dexxer_litesvm --depth 1`):
```
anchor-lang v1.0.2
litesvm v0.16.0
solana-account v4.3.2
solana-clock v3.1.1
solana-instruction v3.4.1
solana-keypair v3.1.2
solana-message v4.4.1
solana-pubkey v4.2.1
solana-signer v3.0.1
solana-system-interface v3.2.0
solana-transaction v4.1.6
```

Транзитивно в графі одночасно присутні `solana-pubkey 2.4.0`/`3.0.0` (через `anchor-lang 1.0.2` → `solana-program 3.0`) і `4.2.1` (наш прямий пін) — три різні типи `Pubkey`, як і попереджав бриф; конвертація байтами через `pk`/`apk` у `lib.rs` підтверджена робочою smoke-тестом.

### Верифікація

```
$ anchor build 2>&1 | tail -3   # після anchor keys sync — без --ignore-keys
    Finished `release` profile [optimized] target(s) in 0.12s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.13s
     Running unittests src/lib.rs (.../target/debug/deps/dexxer_core-30a6190c17446746)
# exit 0, target/deploy/dexxer_core.so створено

$ cargo +nightly-2026-09-18 test -p dexxer_litesvm --test smoke 2>&1 | tail -6
running 1 test
test program_loads_and_token_helpers_work ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

`cd tests/er && npm install` — успішно (Node 24.18.0 через nvm), `package-lock.json` і `node_modules/` створені.

### mb-stack 0.13.7: інвентар

Команда запуску (фонова, лог у `.superpowers/sdd/2026-09-19-week1-core/mb-stack.log`, pid у сусідньому `.pid`):
```
npx --yes --package=@magicblock-labs/ephemeral-validator@0.13.7 mb-stack
```
Стартувало успішно з першої спроби (fallback на `@0.14.10` не знадобився). Лог:
```
✔ mb-test-validator (base L1) ready: rpc http://127.0.0.1:8899, ws ws://127.0.0.1:8900
✔ ephemeral-validator ready: rpc http://127.0.0.1:7799, ws ws://127.0.0.1:7800
✔ query-filtering-service ready: rpc http://127.0.0.1:6699, ws ws://127.0.0.1:6700
MagicBlock stack is ready.
```

Identity ER-валідатора (`getIdentity` на `http://127.0.0.1:7799`) — **`mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`** — це значення потрібне як `validator` для делегації (`EphemeralPermission`/`DelegateArgs`). Identity базового L1 test-validator (`http://127.0.0.1:8899`) — `BhwJhiar5U4h7iFvWjQzJmZALvYcACNgKipUzbQckKDW` (лог самого mb-stack рядка з текстом "identity"/"validator" не друкує — значення отримано напряму через JSON-RPC `getIdentity`, а не грепом логу).

| Програма | ID | Є локально на L1 (8899) | Є локально на ER (7799) | Дамп із devnet | Команда перезапуску |
|---|---|---|---|---|---|
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | так (upgradeable-loader pointer, 36 байт) | так (`LoaderV4`, executable, 459 464 байти) | не потрібен | вбудовано в mb-stack 0.13.7 за замовчуванням |
| Magic Program | `Magic11111111111111111111111111111111111111` | ні (на L1 не потрібна — нативна для ER) | так (`NativeLoader`, вбудована у бінарник валідатора) | не потрібен | вбудовано в mb-stack 0.13.7 за замовчуванням |
| Permission / ACL Program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` | так (upgradeable-loader pointer, 36 байт) | так (`LoaderV4`, executable, 215 976 байт) | не потрібен | вбудовано в mb-stack 0.13.7 за замовчуванням |
| eSPL Token Program | `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2` | так (upgradeable-loader pointer, 36 байт) | так (`LoaderV4`, executable, 924 888 байт) | не потрібен | вбудовано в mb-stack 0.13.7 за замовчуванням |

Усі чотири програми вже присутні і на L1 (`mb-test-validator`), і на ER (`ephemeral-validator`) одразу після старту без прапорців `--bpf-program`/додаткових дампів — `mb-stack 0.13.7` постачає їх у комплекті. Task 13 (eSPL) fallback на `devnet-tee-as.magicblock.app` **не знадобився**: eSPL стартує локально з коробки.

Валідатор лишено працювати у фоні (pid у `.superpowers/sdd/2026-09-19-week1-core/mb-stack.pid`) для наступних задач тижня 1; перезапуск — між задачами за потреби.

**Побічна знахідка (виправлено окремим комітом)**: mb-stack пише свій локальний стан, включно з `validator-keypair.json`, у `magicblock-test-storage/` у корені репозиторію. Додано в `.gitignore`.

## Task 2: стани, помилки, розміри (Q3)

### Структури й помилки

Усі акаунти програми (`Config`, `Market`+`MarketParams`, `MarketRisk`, `Pool`, `UserAccount`, `Position`+`ClosedRecord`, `DisclosureQueue`, `DisclosureCommitment`, `Disclosure`) додано в `programs/dexxer_core/src/state/{config,market,market_risk,pool,user,position,disclosure}.rs` з `#[derive(InitSpace)]` — точно за брифом, без додаткових/пропущених полів. `math::Side` перенесено в `state/position.rs` (додано `AnchorSerialize, AnchorDeserialize, InitSpace`) і ре-експортовано з `math.rs` через `pub use crate::state::Side;` — усі 22 тести `math` лишились незмінними й зеленими. `DexxerError` розширено з трьох наявних варіантів (`MathOverflow, DivisionByZero, InvalidInput`) до повного списку §4.3 (мінус `DuplicateDeposit`, плюс `PoolInsolvent`, `InvalidCandidate`, `InvalidOracleAccount`, `AmountZero`) — порядок варіантів зафіксовано, коди `6000..` тепер стабільні для майбутніх LiteSVM-тестів.

`Cargo.toml`: додано `anchor-spl = { version = "=1.0.2", features = ["token", "associated_token"] }`. Обидві фічі підтверджено в опублікованому маніфесті `anchor-spl 1.0.2` (фічі `token` і `associated_token` існують дослівно, як у брифі) — резолвиться і компілюється без правок. `idl-build` розширено до `["anchor-lang/idl-build", "anchor-spl/idl-build"]`.

### Розміри й L1-рента (відповідь на spec §8 Q3)

Тест `state::size_tests::print_sizes_for_spec_q3` (`cargo test -p dexxer_core --lib size_tests -- --nocapture`) друкує:

```
UserAccount 110 B, Position 257 B, DisclosureQueue 1156 B; L1 rent total 13272720 lamports; ER permission prefund 7264 lamports x3
```

Розбивка по акаунтах (розмір з 8-байтним дискримінатором Anchor; L1-рента за формулою `Rent::default()`: 3480 лампорт/байт-рік × 2 роки = `(space + 128) × 6960`):

| Акаунт | Розмір, B | L1-рента, lamports | L1-рента, SOL |
|---|---|---|---|
| `UserAccount` | 110 | 1 656 480 | 0.00165648 |
| `Position` | 257 | 2 679 600 | 0.0026796 |
| `DisclosureQueue` | 1156 | 8 936 640 | 0.00893664 |
| **Разом** | | **13 272 720** | **0.01327272** |

`Position` (257 B) і `DisclosureQueue` (1156 B) вкладаються у ліміти брифу (< 400 B і < 1300 B відповідно); `Market` (з дискримінатором) — 128 B, теж під лімітом (< 300 B).

ER-акаунти в PER оплачуються за іншою формулою (`ephemeral_accounts::rent`: 32 лампорт/байт, не 3480/байт-рік) — суттєво дешевше L1: `Position` в ER коштувала б `(257 + 60) × 32 = 10 144` лампорт замість 2 679 600 на L1.

Окремо — префандинг permission-акаунта Access Control Program (`EphemeralPermission::size_of(3)` для трьох членів `[owner, session, crank]`, через `ephemeral_accounts::rent`): **7264 lamports** (0.000007264 SOL) за один permission-акаунт. У брифі позначено «x3», бо кожен делегований PDA позиції потребує власного permission-акаунта — на депозит під делегацію потрібно тримати попереднє фінансування трьох таких акаунтів: 3 × 7264 = **21 792 lamports** (0.000021792 SOL) сумарно (інтерпретація: по одному permission на кожен із трьох делегованих PDA — підтвердити в Task 11/13).

**Висновок для Q3**: L1-рента за весь ланцюжок акаунтів користувача (`UserAccount` + `Position` + `DisclosureQueue`) — ≈0.0133 SOL, і ще ≈0.0000218 SOL на префандинг трьох ER permission-акаунтів під делегацію. Разом онбординг одного користувача (акаунти під Delegation Program на L1, без токенних eATA) коштує ≈0.0133 SOL рента + мізерний ER-префандинг — на порядки менше за очікування з відкритого питання спеки.

## Task 13: mb-stack Q1 (депозит → облік) і Q2 (три permission в одній tx)

Перший наскрізний прогін реальної програми на локальному mb-stack:
`@magicblock-labs/ephemeral-validator@0.13.7` (той самий стек, що піднятий
для тижня 1; жодного даунгрейду/апгрейду версії не знадобилось — фолбек на
`0.14.10` не використовувався). Обидві програми задеплоєні на локальний L1
(`http://127.0.0.1:8899`) командою `anchor deploy --provider.cluster
http://127.0.0.1:8899` (деплой — апгрейд наявної адреси
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`). Звичайний `anchor build`
працює без прапорців; `anchor keys list` збігається з `declare_id!` для
обох програм.

Program ids: `dexxer_core = G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`,
`mock_oracle = 68xBWNR1uKorC7keLWvsT1pCmKC4RnwvRF4LoV3CCprh`. ER validator
identity (звірено через `getIdentity` на `http://127.0.0.1:7799`):
`mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`.

### Три реальні баги, знайдені лише на живому eSPL/Permission (LiteSVM їх не мав чим ловити)

1. **`delegate_pool` → `InitializeEphemeralAta`**: ручна CPI-обгортка
   позначала `payer` як `is_signer: false` замість `true` — eSPL-програма
   падала на власному CPI в System Program з `PrivilegeEscalation`
   (`"…'s signer privilege escalated"`, `Cross-program invocation with
   unauthorized signer or writable account`). Виправлено на `true` (звірено
   з TS SDK `initEphemeralAtaIx`, де `payer: isSigner true`).
2. **`delegate_pool` → `DepositSplTokens`**: жорстко закодований
   `amount: 0`. mb-stack приймає таку транзакцію без помилки, але тоді
   ER-видимий ephemeral-баланс `pool_ata` дорівнює 0 незалежно від того,
   скільки токенів було посіяно на L1 раніше (`seed_pool` перед делегуванням
   не «переноситься» в ER автоматично — видимий в ER баланс визначається
   сумою, задепонованою саме в момент делегування). Виправлено: депонується
   актуальний баланс `pool_ata.amount` на момент делегування.
3. **`InitUser` → поле `market`**: було `Account<'info, Market>` (з
   owner-перевіркою). Після того як `delegate_market` вже відбувся
   (`market` тепер належить Delegation Program на L1), будь-яка спроба
   десеріалізувати його як `Account<Market>` валиться з
   `AccountOwnedByWrongProgram`, а користувачі мусять мати змогу
   онбордитись і ПІСЛЯ делегування маркету (делегування — одноразова
   адмінська дія; онбординг — постійний процес). Виправлено на
   `UncheckedAccount` із seeds на константу `SOL_SYMBOL` (як уже було
   зроблено в `DelegateUser`) — у тілі інструкції з маркету читається лише
   `.key()`.
4. **`init_permissions`, idempotency-перевірка**: `perm.lamports() > 0` ніколи
   не спрацьовує як «вже створено» — на цій версії mb-stack
   `EphemeralPermission`-акаунт створюється з **0 лампортів** (рента йде в
   спільний `ephemeral_vault`, не на сам акаунт; перевірено прямим
   `getAccountInfo` вже створеного permission-акаунта: `lamports: 0`,
   `owner: ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, `space: 68`).
   Другий виклик тому завжди намагався заново створити CPI і падав з
   `invalid account data for instruction` від Magic-програми. Виправлено на
   `perm.owner == PERMISSION_PROGRAM_ID`.

Усі чотири виправлення пройшли `program_autofixer` (Solana MCP) чисто
(`issues: [], require_another_tool_call_after_fixing: false`) і
`cargo +nightly-2026-09-18 test -p dexxer_litesvm` без регресій (30/30
проходять) — LiteSVM не мав жодного з цих акаунтів під реальний eSPL/Access
Control Program, тому жоден з чотирьох багів там не міг спливти раніше.

Окрема знахідка на рівні клієнта (не програми): `@coral-xyz/anchor@0.32.1`'s
`AnchorProvider.sendAndConfirm` конструює `web3.SendTransactionError` за
старою (до 1.98) позиційною сигнатурою `(message, logs)`, а встановлений
`@solana/web3.js@^1.98` перевизначив цей конструктор на один об'єкт
`{action, signature, transactionMessage, logs}` — тому будь-яка транзакція,
що потрапила в блок, але впала з помилкою виконання, губить реальне
повідомлення/логи, і замість них видно лише `SendTransactionError: Unknown
action 'undefined'`. Робочий обхід: діставати справжню помилку через
`connection.getSignaturesForAddress(signer)` + `getTransaction(sig).meta.logMessages`
на потрібному підписанті замість довіри об'єкту помилки з `.rpc()`. Записано
в `tests/er/README.md`, щоб не витрачати час на це again.

### Q1: депозит → облік (`tests/er/q1-deposit.ts`)

Сценарій (чистий прогін на щойно піднятому mb-stack, `npm run q1`):
`bootstrap()` → `init_config`/`init_market`/`init_pool` → mock-оракул
(`init_feed`, `set_price(150.00, conf 5e6)`, `delegate_feed`) →
`delegate_market` → адмінський `faucet_init(10 000 dUSDC)` → `seed_pool(10 000
dUSDC)` **на L1, до делегування пулу** (адмінський ATA → `pool_ata`, звичайний
SPL-transfer; тому не треба адмінської eATA в ER) → `delegateSpl(admin, mint,
0, {validator, initVaultIfMissing: true})` (створює спільний global vault) →
`delegate_pool` (ініціалізує + депонує повний баланс `pool_ata` в eATA пулу +
делегує) → юзер: airdrop, `faucet_init(1 000 dUSDC)`, `init_user`,
`delegateSpl(user, mint, 1 000 dUSDC)`, `delegate_user` → **ER**:
`credit_deposit(1 000 dUSDC)`, підписано юзером, ER-blockhash з
`http://127.0.0.1:7799`.

Підписи (`npm run q1`, фінальний чистий прогін):

| Крок | Підпис |
|---|---|
| `init_config` | `2LBkj6WBNqM8Tq2vfNnu8PTD8yfQMos1SMkN8LcoDrHdaKZ6sZYGXF2vmJKrJiU4tQYSi9VCZYMvFi28FLRrXHa` |
| `init_market` | `2A86FKo73gx7God8AXA3pRnvdVwm2cjs1M76D8inXtGLKjarS7ygqfDJ5kXSpGydJ3LHmfmDdirZnNN3QqKPz4aQ` |
| `init_pool` | `3gaH62huCB7QT6WJ6Zazq3tdmMpmVunwWiUaytXaCpb7VTAFmq2Ee4Ajc4mN45cQZy5fv1XrJaoV1uUfVErcudWu` |
| `init_feed` | `vndRLrQh3roY2XstEEyLXPo5qHtiqZNB8yGj5qY4kbmhcz6uPi5R368wmXL42R2XCjGooyjHtwUVHzqyEf3E8ki` |
| `set_price` | `2r8uCAwZf9a13EAeTg6kaPnx3XcKDGPS9eiMaGYtp7kt8ykLCsLwX2J3bduDJPU2BhULHs1ymqvtUhwYq6LPtUST` |
| `delegate_feed` | `5hRQySFwR2NTHvncuHKMitbHhQ7KLVFXqF4CPEzuVoVJhEYw5JpFDKJRixgYBn6rKW6JjH6DSrtqvDxJzUD8RCGZ` |
| `delegate_market` | `4P8Y1wYCYQBz9uGimwVoQJzVm11MVW63HZZcPAwUeocsjN1ybWGTHQLzEDnBvMDvkRvAryn1Xgq3pPpBhCn26ZbX` |
| `faucet_init` (admin) | `3iCixPVviRsUfJMzH3XbkKwsCg1QuWAR9z6mmmC6TJkmw2pTom8dzhimq5xRP2C1RiCWZ1Cx4LsFomfguVVraXvF` |
| `seed_pool` (L1) | `u2k8dDHmk68SvXYLbtb4FHwbnsKUf5mQ5vCsbEw8Y6J89GnEPdMm1KTXnH3UG18ckEYyMCqirakbciBg9yk7Vku` |
| `delegateSpl(admin, 0)` (creates vault) | `2UVQdtQEP14HkfDYogJpxrNSC7SHAPNapRJY4YRAKAUPs6GUEyVgT5ptAF3HwVcaHoy1uF99X1fNetJgurCNz9ev` |
| `delegate_pool` | `3rMmrb21fspMjuLaFsVTKNQ3xTZTX6DbgthGwbxcKwb71r9ARS63R7UoEGDqkvrjmzW2aiNJXPLgqKH6jErUKUJ3` |
| `faucet_init` (user) | `4AAkGFetvhMegEKxvZWYKk8yaFMCpcJxZME96Lqk1gfZYWsYW5GtGdFSQQ1M4SYptDzsLswHKMiCDaF4vaKz9fkV` |
| `init_user` | `65Pp7uqPBpGmePpioiFXQ1jC7PkhKXH68DM5edrZoVFrUdjy1Yut9JKChtbh5Hna5hd3H2jKPsEzKCcvTqpRvc9h` |
| `delegateSpl(user, 1000e6)` | `4Fud5ptsthfCvzJsXfr7MCTLbGJr9B8Jr9moqgUgVi6yXu4vD4ADB8hr45X17ePPNT1Ms2Ujqyprvv7tAToG8F2A` |
| `delegate_user` | `2xnLv3BEP9KpiMkgcRnjQRGgRzheExAhfQKq458d4AJL7FLXQj8zCX3AYjg8vXnckQfzoihzk21DVxQmwGpat56u` |
| **`credit_deposit`** (ER, підписано юзером) | **`2jYKVvZSnoqv36TEMrYaTCFqaApHY2eUdQvxaigwGdF69kdTmjhFJzb4ycmqWaJYy9AMDwMQm8ssDjmSngKqUA17`** |

Баланси/стани (усі читання — через ER-конекшн, `getTokenAccountBalance`/
`program.account.*.fetch` на `http://127.0.0.1:7799`):

| Що | До депозиту | Після `credit_deposit(1000e6)` |
|---|---|---|
| `poolAta` (ER) | 10 000 000 000 (10 000 dUSDC) | 11 000 000 000 (11 000 dUSDC) |
| `Pool.capital_total` / `protocol_liquidity` | 10 000 000 000 / 10 000 000 000 | 11 000 000 000 / — |
| `UserAccount.free_margin` | 0 | 1 000 000 000 (1 000 dUSDC) |
| `userAta` (ER, ephemeral-баланс юзера) | 1 000 000 000 | 0 |

`credit_deposit` CU: **18 090** (`getTransaction(sig).meta.computeUnitsConsumed`
на ER).

Негативний тест: другий `credit_deposit(1)` тим самим юзером — відхилено
(ephemeral-ATA юзера вже порожня, стандартна помилка SPL Token
`insufficient funds`; сира помилка на клієнті замаскована відомим багом
Anchor/web3.js — див. вище). Це підтверджує «ідемпотентність за
конструкцією»: подвійний депозит того самого переказу неможливий, бо кошти,
які мали б бути задепоновані вдруге, вже витрачені першим переказом —
інструкція сама по собі без нонсу, але подвійна витрата унеможливлена рухом
реальних токенів.

**Q1 PASS.**

### Q2: три permission в одній ER-транзакції (`tests/er/q2-permissions.ts`)

Той самий юзер (після Q1): одна ER-транзакція з однією інструкцією
`init_permissions`, що трьома CPI в Permission Program (через Magic Program)
створює `EphemeralPermission` для `UserAccount`, `Position` і
`DisclosureQueue`.

| Виклик | Підпис | CU |
|---|---|---|
| 1-й (створює 3 permission) | `5yBwMWMbyvgV89uPKVqTSSYjq48fwKEyHy44qHs1YC8977FvDEGYT97pcbJo55DEVBffrXoPCR9xtBvrr1yYq7nL` | 57 615 |
| 2-й (idempotent, без CPI) | `zUYTjb6Qycurx1rdosHxtvA1QR4GvEVHy654LPXt9sSiniGXewLV8Zk7mxaoVv8GPH1rBxUkinw8VrYAd2MkYGq` | — |

Перевірено на ER: усі три permission-акаунти існують і належать
`PERMISSION_PROGRAM_ID` (`ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`).
Лампорти PDA-власників зменшились рівно один раз (перший виклик), другий
виклик лампортів не чіпає:

| PDA | До | Після 1-го виклику | Після 2-го виклику |
|---|---|---|---|
| `UserAccount` | 1 663 744 | 1 659 648 (−4096) | 1 659 648 (без змін) |
| `Position` | 2 742 544 | 2 738 448 (−4096) | 2 738 448 (без змін) |
| `DisclosureQueue` | 8 943 904 | 8 939 808 (−4096) | 8 939 808 (без змін) |

Кожен PDA сплатив рівно **4096 лампортів** за власний `EphemeralPermission`
(публічний, 0 членів — `EphemeralMembersArgs { is_private: false, members:
vec![] }`). Це менше за попередньо зафіксований у Task 2 прогноз (7264
лампортів, `EphemeralPermission::size_of(3)` — прогноз під майбутню
приватну версію з трьома членами `[owner, session, crank]`; 4096 —
фактична вартість поточної, публічної, порожньочленної версії тижня 1).
Префандинг на L1 (7264 × 3 = 21 792 лампортів на юзера, з Task 2) із запасом
покриває фактичні 4096 × 3 = 12 288 — головне питання Task 2 Q3 щодо
префандингу підтверджено коректним і навіть надлишковим.

**Q2 PASS**, включно з ідемпотентністю другого виклику.

### Стек і файли

- mb-stack: `@magicblock-labs/ephemeral-validator@0.13.7` (без фолбеку на
  `0.14.10` і без переходу на devnet-tee — усе відпрацювало на локальному
  стеку в межах ліміту 2 год).
- Через два з чотирьох знайдених багів (privilege escalation в
  `delegate_pool`, ідемпотентність `init_permissions`) стан локального
  валідатора доводилось скидати начисто (`test-ledger`/
  `magicblock-test-storage` персистентні між рестартами процесу — рестарт
  процесу САМ ПО СОБІ не дає чистого стану; потрібне саме видалення цих
  директорій) — `config`/`market`/`pool` є синглтонами на рівні програми
  (`seeds` без прив'язки до admin-ключа), тож без чистого рестарту неможливо
  було перевірити виправлення на новому пулі.
- Нові файли: `tests/er/lib/env.ts`, `tests/er/lib/program.ts`,
  `tests/er/lib/admin.ts`, `tests/er/q1-deposit.ts`,
  `tests/er/q2-permissions.ts`, `tests/er/README.md`, `tests/er/.env`.
- Змінені файли програми: `programs/dexxer_core/src/instructions/admin.rs`
  (`InitializeEphemeralAta` signer-фікс, динамічний deposit amount у
  `delegate_pool`), `programs/dexxer_core/src/instructions/user.rs`
  (`InitUser.market` → `UncheckedAccount`, idempotency-перевірка
  `init_permissions` → `perm.owner`).
- Закриття spec §8 Q1/Q2 — самі відповіді зафіксовано тут; формальне
  закриття питань у spec-документі — Task 15 (за брифом).
