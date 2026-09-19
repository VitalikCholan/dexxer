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
