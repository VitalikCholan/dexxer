# Тиждень 1 — результати

## Task 0: гілка, тулчейн-гейт, LiteSVM-крейт, інвентар mb-stack

### Тулчейн-гейт

- `anchor-cli 1.0.2`, `solana-cli 3.1.9` (jsonrpc), CLI-бінарник `solana 3.1.10`, `cargo 1.89.0` — відповідають правилу.
- **Знахідка**: у `target/deploy/` на цій машині немає keypair-файлу, що відповідає `declare_id!("Htuaqktaa4MkdBS3nbFcoRZuVdLHowZknpW35EokXXxT")` (файл гітігнорений, ніде в репо не знайдено). `anchor build` без прапорця завжди генерує новий випадковий keypair і падає на звірці з `declare_id`. Це не залежить від змін цієї задачі — відтворюється навіть при видаленому keypair-файлі. Робочий обхід: `anchor build --ignore-keys` (скомпільований `.so` містить program ID із `declare_id!` у вихідному коді, а не з keypair-файлу — для LiteSVM і деплою через Delegation це не впливає; впливає лише на `anchor deploy`/`anchor keys sync` до появи справжнього keypair-файлу для цього ID).
- **Знахідка (nightly для litesvm)**: `litesvm =0.16.0` з пінами з брифу не компілюється на pinned stable `1.89.0` — транзитивний `solana-syscalls 4.2.2` (тягнеться через `solana-builtins`/`solana-bpf-loader-program`, обов'язкова, не вимкнена фіча `agave-unstable-api`) використовує unstable `MaybeUninit::write_copy_of_slice` (`#![feature(maybe_uninit_write_slice)]`) без власного `#![feature(...)]`-гейту — апстрім-баг у крейті, опублікованому 28.08.2026; полагоджений у `solana-syscalls 4.3.0` (опубліковано 18.09.2026), але жодна опублікована версія `litesvm` (перевірено `0.16.0`, `0.15.2`, `0.14.0`) ще не підняла пін до `>=4.3.0` — всі резолвляться рівно в `4.2.2`. `litesvm 0.13.1` (і старіше) конфліктує напряму з `ephemeral-rollups-sdk =0.16.2` (через `solana-instruction`), тому недоступний для цього воркспейсу незалежно від бага.
  - Спроба `RUSTC_BOOTSTRAP=1` на pinned stable не допомагає: сам крейт не декларує `#![feature(...)]`, тому компілятор відмовляє навіть у bootstrap-режимі.
  - **Робоче рішення**: встановлено датований nightly `rustup toolchain install nightly-2026-09-18` (не чіпаючи кореневий `rust-toolchain.toml`, який лишається `1.89.0` — використовується для збірки самої програми). LiteSVM-тести запускати командою `cargo +nightly-2026-09-18 test -p dexxer_litesvm --test smoke` (а не голим `cargo test`). Записано також у `docs/superpowers/plans/2026-09-19-week1-core.md` → Global Constraints, оскільки стосується всіх наступних задач тижня 1, що писатимуть LiteSVM-тести.

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
$ anchor build --ignore-keys 2>&1 | tail -3
    Finished `release` profile [optimized] target(s) in 0.12s
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.12s
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
