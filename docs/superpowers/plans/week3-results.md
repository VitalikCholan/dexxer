# Тиждень 3 — результати

13F-розкриття, `BalancesRoot`, вихід (`undelegate_user`). Гілка `week3-disclosure-root-exit`,
база `53ae985` (week 2 фінал). Документ веде той самий формат, що й `week2-results.md`: виміряний
підсумок для контролера й спеки, не заміна власних task-звітів
(`.superpowers/sdd/2026-09-22-week3-disclosure-root-exit/task-N-report.md`). Задачі 0 і 2–10 нижче —
короткі виміряні підсумки (комміти, гаунтлет, ключові знахідки); Задача 1 (виміри M-A/M-C/M-D на
спайках) і Задача 8 (редеплой + devnet M-B/M-E/M-A, два раунди) — з повними таблицями, бо саме вони
несуть цифри, на які спирається решта тижня.

Нижче — Task 0 (стан/seeds/помилки), потім Task 1: виміри M-A, M-C, M-D на спайках (`spikes/01-private-counter-tee`,
`spikes/06-magic-action`, `spikes/05-crank-tee`), реальні транзакції на Solana devnet
(`https://rpc.magicblock.app/devnet`) і TEE-ролапі (`https://devnet-tee.magicblock.app`).
Запуск: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`, потім з `spikes/`:
`npx tsx 01-private-counter-tee/w3-ma.ts`, `npx tsx 06-magic-action/w3-mc.ts` (+ `w3-mc-cap.ts` для
розширеного пошуку межі — обидва історичні, сплутані з per-акаунтною квотою, див. §M-C; `w3-mc-fresh.ts
<fresh-payer-keypair.json>` — справжнє вимірювання на свіжому акаунті, потребує окремого тимчасового
деплою, див. fix round 1), `npx tsx 05-crank-tee/w3-md.ts`; або оркестратор
`tests/er/devnet/w3-measure.ts` (`npm run devnet:w3measure` у `tests/er/`, M-A + M-C; M-D — лише
з `RUN_MD=1`, бо спайк 05 треба задеплоїти заново — див. §M-D нижче).

## Task 0: Стан, seeds, помилки, `exit_salt` в `init_user`

Комміт `1351b75`. `state/mod.rs`: `COMMIT_SEED`/`DISCLOSURE_SEED`/`BALANCES_ROOT_SEED`/`ROOT_LEAVES=64`/
`ROOT_BATCH=16`/`MAX_ACTIONS_PER_COMMIT=4`/`ACTION_ESCROW_INDEX=255`. `UserAccount.exit_salt: [u8;32]`.
Новий `state/balances_root.rs` (`BalancesRoot`, `leaf()`/`pad()` — keccak256, без нової залежності).
`DisclosureCommitment` перейменовано/переформовано в `Commitment { version, hash, slot, nonce, bump }`;
`Disclosure` отримав `version`/`bump`; новий `DisclosureArgs` + `commitment_hash(args, salt)`. 9 нових
кодів помилок `6031`–`6039`, строго в кінець. `init_user(exit_salt: [u8;32])` — усі клієнтські виклики
знайдено й оновлено (`tests/litesvm/src/ixs.rs`, `tests/er/lib/trader.ts`,
`tests/er/devnet/{01-onboard-private,05-crank-liquidation}.ts`, `app/src/features/onboard/useOnboarding.ts`
+ новий `app/src/lib/session.ts::getOrCreateExitSalt`).

**Реальна регресія, знайдена й виправлена поза брифом:** додавання 32 байтів до `UserAccount` зіштовхнуло
`Trade::try_accounts`'s SBF-стек-фрейм на 8 байтів понад ліміт 4096 (8 із 9 `crank.rs`-тестів падали
`ProgramFailedToComplete`) — виправлено бокс'уванням `user_account` у `instructions/trade.rs`'s `Trade`
(той самий патерн, що вже застосований до `Position`).

Гаунтлет: `cargo test -p dexxer_core` **49/49** (46+3 нових); `anchor build` чисто (крім латентного
попередження на `BalancesRoot::try_deserialize_unchecked`, +24 B понад ліміт — жодна інструкція його ще
не використовує, прапорцем передано в Task 5, де й підтвердилось — див. рулінг 5); LiteSVM **39/39**;
`program_autofixer` чисто на всіх 8 змінених файлах; `tsc --noEmit` чисто в `tests/er`/`scripts`/`app`
(після ресинку IDL); `cargo fmt`/`clippy` чисто. Повний звіт — `task-0-report.md`.

## Task 1: Виміри M-A, M-C, M-D на спайках (devnet)

### M-A — `commit_and_undelegate` після `CloseEphemeralPermissionCpi`

**Статус: PASS, з першої спроби.**

Спайк 01 (`spikes/01-private-counter-tee`, id `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`,
незмінений — редеплой на місці). Нова інструкція `exit(ctx)` (owner-signed): `CloseEphemeralPermissionCpi`
для `counter` (той самий `invoke_signed`-патерн, що й `set_privacy`/`close_permission`), потім
`MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit_and_undelegate(&[counter]).build_and_invoke()`
в тій самій ER-транзакції — `payer` тут звичайний гаманець (`user`), не програмний PDA, дзеркалить
вже наявну `undelegate`-інструкцію спайку (`MagicIntentBundleBuilder`'s `payer` не може бути PDA у
прямо викликаній інструкції — акаунт оголошений `Signer<'info>` на верхньому рівні).

**Редеплой:** `anchor build` (370 560 байт, було 364 616 на девнеті) → перша спроба
`solana program deploy` впала (`ExtendProgram requires a minimum of 10240 additional bytes... but
only 5944 were requested`) → `solana program extend ... 10240` (payer 4.293945697 → 4.241921497 SOL,
**−0.052024200 SOL**) → повторний `solana program deploy` — успіх, sig
`3JJwSaT6agrJN4HrL2qRiC6Y76XWhaAgwGnQF39f6qhhsUd1piMZJqNJi8ndoCh3jkVMCi99pUvBBbc7tcg71tJ9`
(payer → 4.240071497 SOL, **−0.001850000 SOL** додатково). Разом на спайк 01: **−0.053874200 SOL**.

**Прогін** (`user` = `JAMfwKsWBpug6UpsjwRc71w7rRbzZgAn7tTisvzFHe3D`, лічильник уже приватний,
делегований і мав permission з тижня 2 — precondition звірено напряму: `base owner before:
DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, `permission exists before exit: true (101 bytes)`):

1. `increment` на ER → `count = 6`.
2. `exit()` на ER, sig `5YiW2z8RJuV3b66PwHjazno53ZmGH1bgA6SBPJrxiDikhjsyoG9QLL6pL69CKqpqdyptanitA32EpqsyyMtk2M3A`.
3. Поллінг base (крок 3 с, ліміт 120 с): **PASS на першій ітерації, 120 мс** — `counter.owner ==
   2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7` (програма, не `DELeGG…`), `count == 6` (збігається з
   ER-значенням).

Незалежно підтверджено прямим `solana account`-читанням після прогону:
```
Owner: 2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7
0000: ff b0 04 f5 bc fd 7c 19  06 00 00 00 00 00 00 00  ......|.........
```
(`06 00 00 00 00 00 00 00` LE = `count = 6`, байти після 8-байтного дискримінатора).

Варіант «без close-permission» (fallback на вже наявну `undelegate`) **не знадобився** — `exit()`
спрацював з першої спроби, жодного FAIL не було.

### M-C — ліміт actions в одному bundle `commit_aggregate`-подібного коміту

**Статус: виміряно на свіжому акаунті (fix round 1), реальна межа 28 PASS / 29 FAIL — вища за
дефолтне `MAX_ACTIONS_PER_COMMIT = 4`, рекомендація лишається `4` без змін.**

> **Fix round 1 (контроль-ревʼю):** початковий прогін нижче (n=24 PASS / n=25 FAIL, на вже
> використаному лічильнику спайку 06) виявився **сплутаним із per-акаунтним лімітом plain-комітів**,
> задокументованим у `week2-results.md` M3a — plain `Signer`-payer (той самий шлях, що й
> `commit_with_n_actions`'s `ctx.accounts.payer`) отримує рівно **10 успішних комітів на акаунт,
> потім перманентний `0xA0000000` (`COMMIT_LIMIT_ERR`)**, без скидання. `counter`-PDA спайку 06 уже
> мав ~5 комітів із діагностики 19.09 (check 7) до початку цієї задачі, і сама початкова серія
> (n=1,2,4,8,12,16,24-primary,24-retry) додала ще 8 — тобто до n=25 акаунт міг уже впертися в квоту
> **незалежно від розміру бандла**. Три різні коди помилок уздовж зростаючої серії
> (`0xa0000000` на 25–28, `0xa0000002` на 30–32, вичерпання CU на 48–64) також натякали на кілька
> різних лімітів, не одну стіну. Виміряні факти нижче (сигнатури, коди) лишаються точними — інтерпретація
> «n=24/25 — це межа бандла» **була помилковою** і замінена справжнім вимірюванням нижче на
> **свіжому, ніколи не комічуваному акаунті** (§«Fix round 1: свіжий акаунт»).

Спайк 06 (`spikes/06-magic-action`, id `6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR`, незмінений —
редеплой на місці). Нова інструкція `commit_with_n_actions(n: u8)`: `n` ідентичних `CallHandler`
для того самого `update_leaderboard`, зібраних у `add_post_commit_actions` (той самий контекст
`CommitAndUpdateLeaderboard`, що й наявна `commit_and_update_leaderboard`).

**Редеплой:** та сама послідовність, що й спайк 01 — `ExtendProgram` спершу впав
(`only 5984 were requested`), `solana program extend ... 10240` (payer 4.240071497 → 4.188047297 SOL,
**−0.052024200 SOL**), потім `solana program deploy` — sig
`3rkjUJzqf9ddirYSoZ3BD2sNmZ4G1Ap9EHiZVNzrQ9eMvfNhELRfhWt9CEMGaAamhuPi5Ykh2a3NXdqNKg8EeVVC` (payer →
4.186327297 SOL, **−0.001720000 SOL**). Разом на спайк 06: **−0.053744200 SOL**.

**Знахідка методики:** `update_leaderboard`'s власний ефект (`high_score = max(high_score,
counter.count)`) ідемпотентний — після першого успішного виклику подальші виклики того самого
`n`-набору нічого не змінюють у стані, тож «чи `leaderboard` зріс на `n`» непридатне як сигнал самé
по собі. Реальний сигнал, використаний у `w3-mc.ts`/`w3-mc-cap.ts`: кількість рядків
`Program log: Instruction: UpdateLeaderboard` у логах base-коміт-tx (плюс будь-яких пізніших
program-id tx у вікні ~5–20 с — committor документовано ретраїть невдалі `BaseAction`-и окремою tx,
підтверджено ще в check 7 цього спайку).

**Прогін 1 — брифові `n = 1, 2, 4, 8, 12`** (escrow топ-ап 0.05 SOL,
sig `3ptUGYpuCskuud1Ri7iY2yxUneouqeTyC6XDqRy9iQHvp7nG2cBw5G9xNf5E4ruxeFvCicYvWzM1RUKcab9sjGn8`,
escrow `750 240 → 50 750 240` лампортів):

| n | ER sig (скор.) | base підтверджено | primary log-count | retry | total | результат |
|---|---|---|---|---|---|---|
| 1 | `3V7vEGb…MpVB4hPVMPVf` | 6.12 с | 1 | — | 1/1 | PASS |
| 2 | `3qLnu48…yjfACwu` | 5.47 с | 2 | — | 2/2 | PASS |
| 4 | `5CK2XHY…9nQ8bsFxB` | 5.56 с | 4 | — | 4/4 | PASS |
| 8 | `2nVW8Nh…SRR89LkBj5fJGHfKE` | 5.08 с | 8 | — | 8/8 | PASS |
| 12 | `3NaK5ZH…MzP41DV876xZhM` | 4.91 с | 12 | — | 12/12 | PASS |

Усі п'ять — **повне виконання, з першої спроби**, жодного FAIL. Це вже не відповідає дефолтному
`MAX_ACTIONS_PER_COMMIT = 4` — 8 і 12 теж проходять.

**Прогін 2 — пошук реальної межі** (`w3-mc-cap.ts`, escrow не топався повторно — лишок з прогону 1
вистачило; `user` дофінансовано 0.05 SOL з payer, sig
`QC4fsY2rdNKo6GPmrQopLc9Z49s5f6JHMpAaMtwieu6oCPzNd3zyWT9aE6zLUqJViDKjJZmKwhuManG9RLhZ4nJ`, payer
4.186327297 → 4.136322297 SOL):

| n | результат | деталі |
|---|---|---|
| 16 | PASS | primary log-count 16/16, 5.74 с |
| 24 | PASS | primary 0, **retry-tx** (1 знайдено) з 24 записів `UpdateLeaderboard` — 24/24, ~15 с (перший спостережений випадок, коли весь бандл пішов окремою committor-ретрай-транзакцією, не в первинному commit-tx) |
| 25 | **FAIL** | `ER send FAILED`: `custom program error: 0xa0000000` (симуляція, підпис ніколи не породжено) |
| 26 | FAIL | те саме `0xa0000000` |
| 28 | FAIL | те саме `0xa0000000` |
| 30 | FAIL | `custom program error: 0xa0000002` |
| 32 | FAIL | те саме `0xa0000002` |
| 48 | FAIL | `Program failed to complete` (інша помилка — імовірно вичерпання CU всередині власної інструкції `commit_with_n_actions`, що будує вектор із 48 `CallHandler`, а не відмова боку валідатора) |
| 64 | FAIL | те саме `Program failed to complete` |

**(Прогін 1/2, збережено як історичний запис — межа тут сплутана з квотою, див. блок вище.)**
`0xa0000000`/`0xa0000002` — коди помилок делегаційної/magic-програми на CPI самого коміту (не
`DexxerError`-коди спайку); повний трейс логів недоступний (`getLogs()` кидає `missing or invalid
signature`, бо підпис ніколи не породжено — симуляція впала до відправки).

### Fix round 1: свіжий акаунт (справжня межа)

Новий, тимчасовий program id для чистого вимірювання: **`anchor build --ignore-keys`** (бо
`declare_id!` тимчасово вказано на свіжозгенерований keypair `spikes/keys/mc-fresh-program-keypair.json`
— `anchor keys sync` тут не використовувався навмисно, щоб не чіпати «канонічний» id спайку 06
(`6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR`) — після вимірювання `declare_id!`/`Anchor.toml`
повернуто до канонічного тексту вручну, `git diff` на обидва файли **порожній**) → `solana program
deploy` під новим id **`G3g3bNmbhQKxLUYrw41ZYW3S8336fkrAs3qQcCXU9HkJ`**, sig
`5b5BAXYWxo9BcRk8aJimiQHS7JFiZ6vcivJMhuAKphqFViRffpgext7TU6Vds7S7R47uHGtaWSo6yRtJtTgyfrs7`
(payer 4.133834177 → 2.280515097 SOL). Свіжий одноразовий payer
`AzXt5VN9ZKeG99VAtDTCSusGi4GsY5EvdVVTtnWi3zxH` (`spikes/keys/mc-fresh-payer.json`, gitignored),
профінансований 0.1 SOL з `payer` (sig
`3P7EuHL7TzMbTRzLxCR9JGLt3NRSvR9qNpCbsRVcN2LnLpoBUsWzSt95cL5Ni4gNZQrw9q6Gi9knXEsMRjMPTTDz`) —
`initialize`+`delegate`+escrow-топ-ап 0.05 SOL проти цього нового id: `counter`-PDA
(`JDoM1sMtvaV29VRYw1HezER5Evi2suSYv3jgyMxmWqNc`) **ніколи раніше не комітився** — лічильник
plain-комітів на нім починається з нуля.

Скрипт `spikes/06-magic-action/w3-mc-fresh.ts` (той самий метод підрахунку log-рядків
`UpdateLeaderboard`, приймає шлях до keypair свіжого payer-а аргументом):

| n | результат (commit №) | деталі |
|---|---|---|
| 8 | PASS (#1) | 8/8, sig `3BJFYBGf…` |
| 16 | PASS (#2) | 16/16, sig `3t6Uvyuy…` |
| 24 | PASS (#3) | 24/24, sig `2hD216qG…` |
| 25 | **PASS (#4)** | **25/25, sig `2v3QrLef…`** — на сплутаному акаунті це саме n впало; на свіжому — проходить повністю |
| 28 | PASS (#5) | 28/28, sig `3wu1zacj…` |
| 29 | **FAIL** | send: `custom program error: 0xa0000002` (симуляція, без сигнатури) |
| 30 | FAIL | те саме `0xa0000002` |
| 32 | FAIL | те саме `0xa0000002` |

5 успішних комітів на цьому акаунті (n=8,16,24,25,28) — далеко від 10-комітної квоти M3a, тож
`0xa0000002` тут **не може бути** `COMMIT_LIMIT_ERR` (`0xa0000000` — інший код, і той жодного разу не
зустрівся на свіжому акаунті). **Справжня межа для цієї форми дії: n=28 PASS, n=29 FAIL**, з тим
самим кодом `0xa0000002` на 29/30/32 — узгоджений, відтворюваний сигнал, не квота.

**Прибирання:** `solana program close G3g3bNmbhQKxLUYrw41ZYW3S8336fkrAs3qQcCXU9HkJ --bypass-warning`
— **1.750755960 SOL повернено** (payer 2.280515097 → 4.031266057 SOL). Залишок свіжого payer-а
(0.045763440 SOL) виметено назад на `payer` (`solana transfer payer.json ALL --from
mc-fresh-payer.json`, sig `5AMufTHzGHiTFqsY8Yu7PU1aHzvZDWN2Hf1aFYxe2JoQtNx61gR17SCbAuLTMXSxKoGWD3t7fMvaiFmdsrtx7CNz`)
— payer 4.031266057 → **4.077024497 SOL**. Обидва тимчасові keypair-файли видалено з диска (були
gitignored, ніколи не комітились).

**Важливе застереження для перенесення в `dexxer_core`:** межа 28 виміряна для дії з **2 акаунтами
даних** (`leaderboard`, `counter`) + пара `escrow_auth`/`escrow` + `source_program` = 5 акаунтів на
дію, ~200 000 CU заявлених на дію. `write_commitment` (Task 2 плану) має 3 акаунти даних
(`commitment`, `config`, `system_program`) + та сама escrow-пара = 5; `write_disclosure` — 4 +
escrow-пара = 6. Більші дії, ймовірно, впираються в межу CU/розміру раніше — 28 тут не переноситься
напряму як «завжди безпечне» число для `dexxer_core`'s дій, лише як верхня межа механізму самого по
собі за такої форми дії. **Task 8 має перевимірити на реальній формі `write_commitment`/
`write_disclosure`**, і зробити це або на свіжому, ніколи не комічуваному акаунті, або через
делегований `FeeEscrow`-payer (те, що `commit_aggregate` реально використовує — інший режим комісій,
за тижнем 2: нуль вартості нижче nonce 25), а не на вже вживаному plain-payer акаунті — інакше той
самий confound повториться.

### M-D — планувальник (тех-борг №18)

**Статус: (1) PASS, (2) обидва REJECTED, (3) не виміряно, (4) REJECTED (на реєстрації, не на тіку).**

Спайк 05 (`spikes/05-crank-tee`). Старий id тижня 2 (`EEkgWoy8krpaxtP8msJeN4rJux2KX68MCHjasosD8CGE`)
**закритий** — редеплой на той самий id неможливий. `target/deploy/crank_counter-keypair.json`
видалено, `anchor keys sync` згенерував новий: **`AsXtStXjZxwUd6UNVqJ9kQYJ9cYFdZbh2SeSWaZdX8bi`**
(`Anchor.toml`'s `[programs.devnet]` і `declare_id!` оновлені синком). Дві нові інструкції для (4):
`schedule_tick_and_reschedule(args)` (реєструє `tick_and_reschedule` як заплановану задачу) і
`tick_and_reschedule(ctx, args)` (сам тік — інкрементує `counter`, потім намагається
самостійно викликати `ScheduleCrankCpi` ще раз, `payer = ctx.accounts.payer: Signer<'info>`).

**Деплой:** `anchor build` (329 384 байти) → `solana program deploy ... --program-id
target/deploy/crank_counter-keypair.json` — успіх з першої спроби (без `extend`, бо це новий
акаунт, не апгрейд), sig `56MiYwhCr5xFe8BmLsb62DAbTSxzsz5Bgff7uYfKDhVdnTvopoZKdFxf8ViptT6XFLtbiZd9SHXmRqjEjhU7TDgn`.
Payer 4.136322297 → 2.459689617 SOL (**−1.676632680 SOL**, дещо вище брифової оцінки ~1.6 SOL).

**Порядок вимірювань навмисно (2)/(4) → (1) останнім:** (1) планує ефективно нескінченну задачу
(`iterations = i64::MAX`), яка тікає на спільному лічильнику доти, доки програму не закрито —
запускати її раніше «забруднило» б лічильник фоновим інкрементом для (2)/(4). Fresh програма +
fresh `counter` PDA (нуль резидуального стану з тижня 2, той PDA належав закритому id).

**(1) `iterations = i64::MAX`:**
`schedule(iterations=i64::MAX)` **прийнято**, sig
`31a5F92y5BShdy3ejarigtoDE6WkcAAvefm99tx3ZgPLdGCH1kRhehBe8Y8oLNQWRY4muTcegGMDSxdrJAMkPZ1i`.
13 семплів по 5 с (65 с разом): `count` 0 → 81, монотонно кожні 5 с (`+9, +6, +6, +6, +6, +6, +6, +6,
+6, +6, +6, +6, +6`) — **тікає стабільно понад 60 с**, темп ≈1.25 тіка/с (швидше за заявлений
1000 мс інтервал — узгоджується з тижня-2 M1's знахідкою ≈1.35 тіка/с; той самий висновок:
`execution_interval_millis` — нижня межа/підказка планувальнику, не гарантований точний період).
`i64::MAX` **не капиться** валідатором на прийомі.

**(2) `iterations = 0` і `iterations = -1`:**
Обидва **REJECTED**, і в обох випадках — на симуляції **самої зовнішньої `scheduleIncrement`-tx**
(жоден підпис ніколи не породжено, `getLogs()` кидає `missing or invalid signature`):
```
iterations=0:  transaction verification error: Error processing Instruction 0: invalid instruction data
iterations=-1: transaction verification error: Error processing Instruction 0: invalid instruction data
```
Той самий текст помилки для обох значень — це відмова всередині `ScheduleCrankCpi`'s CPI в
делегаційну/magic-програму (не `DexxerError`- чи Anchor-код спайку), не проблема Borsh-кодування
клієнтом (`i64` кодує `0` і `-1` без питань). Лічильник не зрушив у жодному з двох 8-секундних вікон
після спроби (`delta: 0` в обох). **Ні `0`, ні `-1` не приймаються як «нескінченність» чи «нуль
разів»** — валідатор відкидає обидва значення одразу.

**(3) Персистентність через рестарт:** **не виміряно** — сесія однопрохідна, вікна рестарту
devnet-tee в межах цієї задачі не було (перевірка `https://status.magicblock.app/api/services` не
запускалась окремо, бо `(1)` уже підтвердив живий, відповідний TEE увесь час вимірювання). Навіть
відкладена перевірка для **цього** id неможлива — спайк 05 закривається одразу по завершенні цієї ж
задачі (рефанд SOL), а закритий program id ніколи не редеплоїться. Для будь-якого майбутнього
вимірювання цього пункту знадобиться новий деплой, приурочений до відомого вікна рестарту.

**(4) Self-reschedule з-під власного `Signer`-payer:**
`schedule_tick_and_reschedule` (зовнішній виклик, що РЕЄСТРУЄ `tick_and_reschedule` як заплановану
задачу) **сам відхилений на реєстрації**, ще до першого тіку:
```
transaction verification error: Error processing Instruction 0: missing required signature for instruction
```
Тобто відмова сильніша за очікувану в брифі («очікування: відхилено, бо payer не може підписати» —
малось на увазі відмову ВСЕРЕДИНІ запланованого тіку). Насправді делегаційна/magic-програма
відхиляє **саму спробу зареєструвати** заплановану інструкцію, що вимагає `Signer`-акаунт
(`AccountMeta::new(payer, is_signer: true)` у записаному наборі акаунтів) — задача з таким
записом ніколи не потрапляє в чергу. Це узгоджується з коментарем у вже наявному `increment`
(навмисно безпідписний: «Scheduled instructions run top-level and do not inherit a Hydra PDA
signature») — тепер підтверджено емпірично, і не лише для *виконання* тіку, а вже для *реєстрації*
задачі, чий record вимагає підпис. `counter` не зрушив за 10-секундне вікно очікування
(`delta: 0`), жодної `TickAndReschedule`-tx на base-рівні не з'явилось (`0 base-layer program-id
txs since scheduling`).

**Закриття спайку 05:** `solana program close AsXtStXjZxwUd6UNVqJ9kQYJ9cYFdZbh2SeSWaZdX8bi
--bypass-warning` — **1.674149560 SOL повернено**. Payer 2.459689617 → 4.133834177 SOL. Задача (1)
(нескінченний тік) померла разом із програмою — жодного тіка більше не станеться, нічого
скасовувати окремо не було потрібно.

### Рішення після M-A/M-C/M-D

**(a) `undelegate_user`'s порядок — `CloseEphemeralPermissionCpi` ПЕРЕД `commit_and_undelegate`,
в одній атомарній ER-транзакції, працює з першої спроби.** M-A: sig
`5YiW2z8RJuV3b66PwHjazno53ZmGH1bgA6SBPJrxiDikhjsyoG9QLL6pL69CKqpqdyptanitA32EpqsyyMtk2M3A`,
підтверджено прямим читанням base-акаунта (owner = program id, `count` збігається з ER-значенням,
120 мс поллінгу). Немає потреби у fallback-варіанті «без close-permission», і немає потреби в
іншій послідовності чи підтримці з боку MagicBlock — дизайн §2.4.3 підтверджений як є.

**(b) `MAX_ACTIONS_PER_COMMIT` — виміряна межа механізму (fix round 1, свіжий акаунт) 28 (PASS) /
29 (FAIL) для дії з 5 акаунтами (~200 000 CU/дію), рекомендація для `dexxer_core` — лишити дефолт
`4` (Task 0), не піднімати до виміряного максимуму.** Перший прогін цього вимірювання (n=24 PASS /
25 FAIL) виявився сплутаним із week2 M3a's 10-комітною per-акаунтною квотою (`counter`-PDA спайку
06 уже мав ~13 plain-комітів до n=25) — повторено на свіжому, ніколи не комічуваному акаунті
(новий тимчасовий program id, закритий одразу по вимірюванню): **28 PASS, 29 FAIL, стабільно той
самий код `0xa0000002`** на 29/30/32, відмінний від `0xA0000000`=`COMMIT_LIMIT_ERR` — це вже не
квота, а реальна межа бандла (розмір tx і/або CU самого `commit_with_n_actions`). Причини лишити
`4`: (i) виміряна межа специфічна для форми дії спайку 06 (2 акаунти даних); `write_commitment`/
`write_disclosure` мають більше акаунтів на дію (5–6) і, ймовірно, впираються в межу раніше — не
виміряно напряму на цій формі; (ii) навіть за низького n=1..16 усе PASS з першої спроби без жодної
деградації — запас між `4` і виміряними `28` величезний, тож `4` — консервативний, безпечний вибір
без емпіричного тиску його піднімати; (iii) `MAX_ACTIONS_PER_COMMIT` контролює й латентність
розкриття при масових закриттях (§2.4.4 п.11) — менше акцій на коміт означає частіші, дрібніші
commit-цикли, а не ризик відмови bundle. **Task 8 повторно вимірює на реальній формі
`write_commitment`/`write_disclosure`** — обов'язково на свіжому акаунті або через делегований
`FeeEscrow`-payer (те, що `commit_aggregate` реально використовує, інший режим комісій), щоб не
повторити цей самий confound.

**(c) Планувальник (тех-борг №18) — некостильне рішення все ще не існує; факти для рішення:**
`iterations = i64::MAX` **приймається і тікає стабільно** (81 тік за 65 с, sig
`31a5F92y5BShdy3ejarigtoDE6WkcAAvefm99tx3ZgPLdGCH1kRhehBe8Y8oLNQWRY4muTcegGMDSxdrJAMkPZ1i`) — не
капиться валідатором на прийомі, тож «велике `iterations`» (замість `86_400`) — робочий,
незагіданий варіант для «завжди-онлайн»-подібної поведінки, з тим самим застереженням тижня 2:
планувальник **не вічний** (рано чи пізно `i64::MAX` теж вичерпається, хоч і не в межах будь-якого
реалістичного горизонту) і не переживає **закриття програми** (підтверджено: задача (1) померла
разом зі спайком 05 у цій-таки задачі). `iterations = 0` і `-1` **обидва відхилені** валідатором на
CPI-рівні (`invalid instruction data`, симуляція, жоден підпис не породжений) — жодна форма
«нуль-сентинел» чи «від'ємний-сентинел» для нескінченності не працює, лише велике додатне число.
**Self-reschedule відхилений на реєстрації** (`missing required signature for instruction`,
sig-less), не лише на виконанні — задача, чий записаний набір акаунтів вимагає `Signer`, у чергу
взагалі не потрапляє; це виключає self-reschedule як механізм і підтверджує вже наявний дизайн
`increment`'s (сигнатура-вільна інструкція) як єдино робочий шаблон для запланованого тіку.
Персистентність через рестарт **лишається невиміряною** (нема вікна рестарту в цій сесії).
**Висновок для Task 7/тех-боргу №18:** `iterations = i64::MAX` (не `86_400`) для планувальника,
self-reschedule-CPI не використовувати (підтверджено непрацездатним, не лише теоретично
ризикованим), `crank-fallback` лишається обов'язковим always-on шляхом (планувальник — best-effort
пришвидшувач, не заміна), і вимір персистентності через рестарт — досі відкритий пункт, потребує
окремого вікна.

### Баланс `payer` (весь Task 1, включно з fix round 1)

| момент | баланс (SOL) |
|---|---|
| на старті задачі | 4.293945697 |
| після `extend`+`deploy` спайку 01 (M-A) | 4.240071497 |
| після `extend`+`deploy` спайку 06 (M-C) | 4.186327297 |
| після фандингу `user` +0.05 SOL (для розширеного M-C прогону) | 4.136322297 |
| після деплою спайку 05 (M-D) | 2.459689617 |
| після `solana program close` спайку 05 (+1.674149560 SOL) | 4.133834177 |
| після фандингу свіжого payer-а +0.1 SOL (fix round 1) | 4.033834177* |
| після деплою тимчасового id спайку 06 (fix round 1) | 2.280515097 |
| після `solana program close` тимчасового id (+1.750755960 SOL) | 4.031266057 |
| після вимітання залишку свіжого payer-а назад (+0.045763440 SOL) | **4.077024497** |
| **підсумкова дельта за Task 1 разом із fix round 1** | **−0.216921200 SOL** |

*Рядок «після фандингу свіжого payer-а» — округлено до 4.033834177 (реальний баланс між цими двома
подіями не знімався окремо; наступний рядок — реально виміряний після деплою).

`user` (`JAMfwKsWBpug6UpsjwRc71w7rRbzZgAn7tTisvzFHe3D`): 0.076227216 SOL на старті → 0.073367416 SOL
у кінці основного прогону (плюс отримані від payer 0.05 SOL посередині) — фактичні витрати `user`-а
за основний прогін (комісії + escrow топ-ап 0.05 SOL): **0.052860 SOL**. Fix round 1 використав
окремого одноразового payer-а (`AzXt5VN9ZKeG99VAtDTCSusGi4GsY5EvdVVTtnWi3zxH`), профінансованого і
повністю виметеного назад — нуль залишкового впливу на `user`.

### Файли

- Modify: `spikes/01-private-counter-tee/programs/private-counter/src/lib.rs` (+ `exit`,
  `ExitCounter`), `spikes/06-magic-action/programs/magic-actions/src/lib.rs` (+
  `commit_with_n_actions`), `spikes/05-crank-tee/Anchor.toml` (новий `[programs.devnet]` id,
  `anchor keys sync`), `spikes/05-crank-tee/programs/crank-counter/src/lib.rs` (+
  `schedule_tick_and_reschedule`, `tick_and_reschedule`, `ScheduleIncrementArgs: Clone`),
  `tests/er/package.json` (`devnet:w3measure`).
- Create: `spikes/01-private-counter-tee/w3-ma.ts`, `spikes/06-magic-action/w3-mc.ts` +
  `w3-mc-cap.ts` (розширений пошук межі, n=16..64, історичний запис — сплутаний із квотою) +
  `w3-mc-fresh.ts` (fix round 1 — справжнє вимірювання на свіжому акаунті), `spikes/05-crank-tee/w3-md.ts`,
  `tests/er/devnet/w3-measure.ts` (оркестратор — шелить у спайкові скрипти; M-D лише з `RUN_MD=1`,
  бо потребує нового деплою спайку 05 — той, що вимірювався тут, уже закритий).
- `target/deploy/*-keypair.json` (нові program keypairs для спайків 01/05/06), fix round 1's
  тимчасовий `spikes/keys/mc-fresh-program-keypair.json`/`mc-fresh-payer.json` (обидва видалені з
  диска після вимірювання) — НЕ комітяться (gitignored, як і решта `target/`/`spikes/keys/`).
  `spikes/06-magic-action/Anchor.toml`/`declare_id!` тимчасово вказували на fix round 1's id, потім
  повернуті до канонічного `6Tm2qGHSsmYhaCtLmWf7TQ2VBi84s2bzuzrHKGFePoxR` — `git diff` на обидва
  файли порожній, у коміті лишається лише `commit_with_n_actions`.

`anchor build` чисто на всіх трьох змінених спайках (перевірено і після відкату id спайку 06 назад
до канонічного). `export PATH=...` → `cd tests/er && npx tsc --noEmit` — чисто (0 помилок), включно
з новим `devnet/w3-measure.ts`. `mcp__solana-mcp-server__program_autofixer` на всіх трьох
`lib.rs`-файлах (канонічний стан, framework `anchor`): **0 issues, 0 suggestions на кожному**.

## Task 2: `write_commitment`/`write_disclosure` — L1 `#[action]`-інструкції

Комміт `2360638` + fix round 1 `26c605d`. `instructions/disclosure.rs` (новий): `WriteCommitment`/
`WriteDisclosure`, змодельовані на перевіреному спайку `spikes/06-magic-action`'s `UpdateLeaderboard` —
`source_program` (`address = crate::ID`), `escrow_auth` (== `config.fee_payer`), `escrow` (`mut, signer`,
Magic escrow PDA) — усі три гейти на `InvalidActionSigner`. `write_commitment` пише `Commitment`;
`write_disclosure` звіряє `commitment_hash(&args, &salt) == commitment.hash` (`BadDisclosureHash`
інакше), пише `Disclosure { owner: Pubkey::default(), ... }`.

Оригінальні негативні тести асертували `PrivilegeEscalation` (CPI-рівневий збій `init`'s
`system_program::create_account`, не сам констрейнт `escrow`-підписанта) — ревʼю знайшло, що
пре-фандований target PDA обходить саме цей шлях (Anchor'ів `init` деградує до `allocate`+`assign`,
жодного `Transfer` CPI). Fix round 1 додав два тести на пре-фандований PDA, які прямо доводять
`InvalidActionSigner` (6024) як фінальний гейт. LiteSVM **41 → 43**. Повний звіт — `task-2-report.md`.

## Task 3: `commit_aggregate` емітує `write_commitment`/`write_disclosure`

Комміт `2085288` + fix round 1 `5e4ee42`. Нові чисті хелпери `pending_commitment(&Position)`/
`due_reveals(&mut DisclosureQueue, slot, max)`. `commit_aggregate` тепер ітерує
`ctx.remaining_accounts`: `Position` із `Closed && !commitment_written` → дія `write_commitment`;
`DisclosureQueue` із due-записами → дії `write_disclosure` (через `due_reveals`, спільний бюджет
`MAX_ACTIONS_PER_COMMIT` на обидва види). **Стек-фікс:** `#[inline(never)] fn
process_position_candidate`/`process_disclosure_queue_candidate` — бокс'ування полів `Accounts`-структури
(як у `trade.rs`) тут **не допомогло** (переповнення було у самій функції `commit_aggregate`, не в
Anchor-згенерованому `try_accounts`); винесення великих локальних змінних (`Position` до 400 B,
`DisclosureQueue` до 1300 B) в окремі фрейми — допомогло.

Fix round 1 (ревʼю: нуль покриття шляху `DisclosureQueue`/`due_reveals`) додав
`tests/litesvm/tests/commit_actions.rs` (4 тести: due-запис вискакує; ще-не-due лишається байт-у-байт;
частковий pop зберігає порядок; повторний коміт на вже записаній позиції — no-op). LiteSVM
**46 → 55** (з урахуванням Task 4's `mark_committed`-тестів, що приземлились паралельно — див. нижче).
Знахідка (рулінг 7): `TooManyActions` спрацьовує лише на `Position`-шляху; `DisclosureQueue`-шлях сам
кепить бюджет дій через параметр `room`, без помилки. Повний звіт — `task-3-report.md`.

## Task 4: `mark_committed`

Комміти `1c8390e` (рефактор — єдині білдери `write_commitment`/`write_disclosure` з параметром
`escrow_auth`, згортає Task 2's дубльовані `*_isolated_escrow`-хелпери) + `1f6bd90` (фіча).
`MarkCommitted`: `crank: Signer` (== `config.crank`), `position`/`dq` за seeds. Порядок (рулінг 7):
валідація (`Closed`→`NotClosed`, `commitment_written`→`CommitmentNotWritten`) → push у кільце
`DisclosureQueue` (`QueueFull` інакше) → `Position` скидається в `Empty`. 5 нових тестів: перенесення й
звільнення позиції, гейт `commitment_written`, лише crank, друга позиція тим самим гаманцем, повна
черга. LiteSVM **51/55** (реалізатора перервав rate-limit до звіту; контролер прогнав гаунтлет на
HEAD `1f6bd90` — 49 unit, autofixer/fmt/clippy чисто, `tsc` ×3 чисто). Повний звіт — `task-4-report.md`.

## Task 5: `BalancesRoot` — init/delegate (admin) + `set_balances_root` (crank)

Комміт `6a1a145`. **Рулінг 5, обовʼязкова проба:** спершу реалізовано брифовим Borsh-варіантом
(`#[account] #[derive(InitSpace)]`, `Account<'info, BalancesRoot>`) — `anchor build` одразу назвав дві
функції в stack-offset виводі (`InitBalancesRoot::try_accounts` +912 B, dispatch-хендлер +672 B), і
LiteSVM-проба (4 тести з `tests/litesvm/tests/root.rs`) **зафолилась**: `ProgramFailedToComplete`,
"Access violation in stack frame 3". Обидва тригери рулінгу 5 незалежно спрацювали → конверсія в
`#[account(zero_copy)] #[repr(C)]` була обовʼязковою, не опційною.

Фінальний лейаут (без padding holes для `bytemuck::Pod`): `root_slot:u64 | leaves:[[u8;32];64] |
version:u8 | filled:u8 | bump:u8 | _pad:[u8;5]` = 2064 B (`BalancesRoot::SIZE = 2072` з дискримінатором).
Доступ через `AccountLoader`, не `Account`. `bytemuck = "=1.25.2"` додано прямою залежністю
(`dexxer_core/Cargo.toml`) — потрібен macro-згенерованому `unsafe impl Pod/Zeroable` резолвитись за
іменем у власному крейті. `init_balances_root`/`delegate_balances_root` — той самий `AdminConfig`-патерн,
що `init_fee_escrow`/`delegate_fee_escrow`. `set_balances_root(begin, finalize, padding_seed)`: кожен
`remaining_accounts`-запис звіряється на власність програми, дискримінатор (`try_deserialize` фейлиться
на не-`UserAccount`) і PDA-деривацію — три незалежні способи відхилити підроблений/чужий акаунт.

TDD: RED — 4/4 зафолились на Borsh-варіанті ("Access violation in stack frame 3"); GREEN — 4/4 PASS на
zero_copy. Гаунтлет: `anchor build` чисто (жоден `dexxer_core`-стек-офсет), `cargo test -p dexxer_core`
49/49 (без нових — логіка вже покрита Task 0's тестами), LiteSVM **55 → 59** (+4, `root.rs`),
`program_autofixer` чисто на 5 змінених файлах, `tsc` ×3 чисто (IDL: 3 нові інструкції +
`balances_root`/`delegate_balances_root`). `delegate_balances_root` НЕ виконується на LiteSVM (немає
делегейшн-програми — той самий стан, що й `delegate_fee_escrow`/`delegate_market`/`delegate_pool`).
Повний звіт — `task-5-report.md`.

## Task 6: `undelegate_user`

Комміт `b57a9d7` + fix round 1 `1241a2c`. `UndelegateUser`: `owner` (mut signer), `user_account`/
`position`/`dq` (`has_one = owner`), три permission-PDA (повний seeds-констрейнт, як `SetSession`),
`ephemeral_vault`/`permission_program`, `Withdraw`'s fee-vault акаунти. `close_permission_if_present`
(`#[inline(never)]`) дзеркалить `set_session`'s `UpdateEphemeralPermissionCpi`-цикл, але
`CloseEphemeralPermissionCpi`. `undelegate_user`: гейти `HasOpenPosition`/`QueueNotEmpty`/`BalanceNotZero`
→ скраб `UserAccount`/`DisclosureQueue` → закриття трьох permission → `commit_and_undelegate` (лише коли
`magic_program.executable` — LiteSVM пропускає CPI, як і `withdraw`/`commit_aggregate`).

Fix round 1 (ревʼю, Important ×2): (1) `last_withdraw_slot` не скрабався — додано, RED/GREEN
підтверджено окремим тестом через реальний `withdraw()`; (2) відсутній тест на `Closed`-але-ще-не-
`mark_committed` позицію — додано `undelegate_rejected_with_closed_unmarked_position`. LiteSVM
**59 → 63 → 64** (гейти ×3 + скраб-асерти, потім +1 фікс-раунд). Повний звіт — `task-6-report.md`.

## Task 7: Crank-цикли розкриття/root на 5-хв коміті `Pool`; bootstrap `BalancesRoot`/action-escrow

Комміт `03823ca` + fix round 1 `fd52c70`. Golden vectors (рулінг 6) спершу в Rust
(`commitment_hash_golden_vector`, `leaf_and_pad_golden_vectors`), потім у TS
(`tests/er/lib/program.ts`'s `commitmentHash`/`leaf`/`pad` через `@noble/hashes/sha3`) —
`npm run selftest:hashes` асертує той самий hex. `tests/er/lib/admin.ts`: `initAndDelegateBalancesRoot`,
`topUpActionEscrow` (виявлено: `createTopUpEscrowInstruction` — 4-аргументна на встановленій версії
SDK, не 3, як у брифі — `payer` окремо від `escrowAuthority`). Новий `scripts/crank-fallback/disclosure.ts`:
`runRootCycle`/`runDisclosureCycle`; кандидат-евристика — до 4 `Position` спершу (кожна коштує рівно
одну дію), потім щонайбільше один `DisclosureQueue` якщо лишилось місце (програма сама кепить його
внесок через `room`).

Fix round 1 (Critical): `commit_aggregate` викликався лише за наявності кандидатів — ламало
фіксований-інтервал коміт `Pool`+`BalancesRoot` у тихий цикл. Виправлено — виклик щоцикл безумовно,
`remaining_accounts` просто порожній. Разом Important-фікс — застарілий `03-commit-cycle.ts` не мав
акаунта `balances_root`, доданий. Гаунтлет: `cargo test -p dexxer_core` **49 → 51** (два golden-vector
тести); `tsc` ×3 чисто; `selftest:hashes` 3/3; LiteSVM без змін (жодна нова LiteSVM-логіка). Повний
звіт — `task-7-report.md`.

## Task 8: Редеплой + devnet-скрипти 06/07/08 (M-B, M-E)

Повний звіт: `.superpowers/sdd/2026-09-22-week3-disclosure-root-exit/task-8-report.md`. Нижче —
виміряний підсумок. `dexxer_core` редеплоєно на devnet (program id незмінний,
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`), три нові devnet-скрипти
(`tests/er/devnet/06-commitment-reveal.ts`, `07-balances-root.ts`, `08-undelegate.ts`). Жодних змін
у Rust — рулінг 8 вирішився без них, M-C не перевимірювався на реальній формі дії (з бюджету
задачі, дозволено брифом).

### Редеплой

Preflight: новий бінарник **1 040 080 B** (точно за оцінкою брифу), extend на **101 640 B**
(рента 0.51698144 SOL) + буфер деплою (рента 5.28527264 SOL) = 5.80225408 SOL; payer мав
5.950356913 SOL — запас ≈0.098 SOL, продовжено. Усі підписи нижче — **base** (деплой/апгрейд
програми — завжди L1, ER тут не задіяний).

| крок | підпис (base) | байти / SOL | payer до → після |
|---|---|---|---|
| `solana program extend … 101640` | `37drNM3uj42Fh2u3pPYqzWcxdYS6RDJSutixvoaX8vpMNLtpb8AHMB2syemfb6tQW9wA1WRoPqm7QiFeRcRoX7yt` | +101 640 B (рента 0.516336200 SOL) | 5.950356913 → 5.434020713 |
| `anchor deploy --provider.cluster devnet` (спроба 1) | — (429 Too Many Requests, підпис не породжено) | буфер `Amq9zwWWjETqXS5K42ax7xj6jSMXWPkrnug1Mv6pykxr` завис (5.2844446 SOL) | 5.434020713 → 0.149466113 (тимчасово) |
| `solana program close Amq9zw… --bypass-warning` | (закрито окремо, підпис не зберігався — рефанд підтверджено балансом) | повернуто 5.2844446 SOL | 0.149466113 → 5.433905713 |
| `solana program deploy … --url https://rpc.magicblock.app/devnet --use-rpc` (fallback, спроба 2) | `66DEy5nb9TTEoSKnGhXxDBhz79SYVuvkt3VE9mdA3U6AAuLvVZpq6ukY19jiZcAQ1FSQCnqdFeK4pM8WEe43D9nU` | upgrade + внутрішній буфер закрито атомарно в тій самій tx | 5.433905713 → 5.428750713 |

`--provider.cluster devnet` резолвиться на дефолтний `api.devnet.solana.com`, не на
`rpc.magicblock.app/devnet` (в `Anchor.toml` нема кастомного URL для `devnet`) — звідси 429 на
спробі 1. Жодних завислих буферів після спроби 2 (`solana program show --buffers
--buffer-authority <payer> -u devnet` — порожньо). `solana program show` після:
`Data Length: 1048272 bytes`, `Balance: 5.3261006 SOL`. **Чиста вартість редеплою: 0.521606200
SOL** (0.516336200 extend + 0.005155000 net upgrade). `devnet-bootstrap.ts` (ідемпотентно, **base**)
створив і делегував `BalancesRoot` уперше цієї гілки:

| крок | підпис (base) |
|---|---|
| `init_balances_root` | `2ZaZ136g6r7Esh2Eq8AXKAL8UDC7dcVXVcTTTxML5WszhmfQ3sE9zwTSE4aaUP4mqoJmiLudNNUHynPVet1wknQk` |
| `delegate_balances_root` | `44Syeax6Tne27zNDdVrxtUTj69yPXJ3MB4XpLhNqbaxu61e6ibS6xaFAqrPVtNkAQtyYTfXeaYp24fGhoxtkTYwJ` |
| action-escrow top-up | `2sXgAmdidyWZ4Zy9t58q37UmPDYf1kEpYr6mDGWtr4GeABJsnQBqbTHbZmBydKECEunYWLJhNxpqsjgRLWvLaq1A` |

### Рішення після рулінгу 8

Виміряно на throwaway-трейдері (окремий, не 06-скрипту) реальним `commit_aggregate` з
`remaining_accounts=[Closed Position]`: **(i)** підписаний лише `fee_payer` (не permission-член
позиції — члени `[owner, session, crank]`) — **PASS**, sig **ER** (devnet-tee)
`3yNb9tg2qxzkTbLwNpcf6jV9HKipzEapQsRHU5htpkVV1Cp2LLjzKz14R93BmBiWE3uMaq5cDATjPhErUUUShz1M` —
`solana confirm` на **base** повертає `Not found` за задумом (ця tx ER-локальна, ніколи не йде на
L1 сама по собі; на L1 видно лише її наслідок — `write_commitment`-дію, окремим акаунтом
`Commitment`). Підтверджено незалежно (перечитано `Position.closed.commitmentWritten==true`,
`Commitment` PDA реально існує на **base**, 58 байт). **(ii)** та сама tx з `crank` як зайвим
підписантом транзакції (не інструкції) — **REJECTED**, `unknown signer` (структурна відмова
web3.js/Solana при локальному підписанні — жодного підпису взагалі не породжено, ні ER ні base;
не TEE-фільтр приватності). **Жоден із двох сценаріїв брифу не спрацював** — (i) вже проходить,
тож ні `extraSigners`, ні новий `set_fee_payer`-admin-ix не знадобились. **Жодних змін у Rust.**
Інтерпретація: TEE-фільтр приватності (week 2, leak-test) гейтить читання через RPC, не власне
виконання інструкції програмою — членство в permission це контроль видимості для читання, не
авторизація виконання.

### Знахідка: колізія nonce на глобальних PDA `Commitment`/`Disclosure`

`Commitment`/`Disclosure` PDA — `[SEED, nonce]` **без власника** в сідах, а `nonce` —
**по-юзерський** лічильник (`UserAccount.nonce`), що стартує з 0 і стає 1 на першому close **будь-
якого** трейдера. Ruling-8-трейдер зайняв `Commitment[1]` першим; 06-скрипту свіжий трейдер теж
почав з nonce=1 — `write_commitment` мовчки не зміг `init` (акаунт уже зайнятий), проте
`mark_committed` не перевіряє коректність L1-хешу (лише ER-side прапорець `commitment_written`,
виставлений оптимістично) — позиція звільнилась нормально з "зіпсованим" записом у черзі. Знахідка
зловлена саме асертом хешу в 06 (не проігнорована). Це наявна архітектурна прогалина тижнів 2-6
(nonce мав би бути глобально-унікальним або прив'язаним до owner) — **поза скоупом Task 8**;
обійдено клієнтським retry-циклом (комітити, перевіряти збіг хешу, якщо колізія — все одно
`mark_committed` + дренаж через `commit_aggregate(dq)` після настання reveal-слоту, потім
повторити зі свіжим nonce). Задокументовано, не пропатчено в Rust.

**Виправлено у §Task 8b (рулінг 9).**

### Знахідка: застарілий layout `UserAccount` ламає повний скан `set_balances_root`

На девнеті 12 `UserAccount` через `getProgramAccounts`; **8 із них — застарілого layout** (110/118
байт до `exit_salt`/`last_withdraw_slot`, тижні 1-2, той самий program id, без міграції). Перший
прогін 07 впав на `InvalidLeafAccount` (0x6035) на весь батч — Rust-десеріалізація коротшого
акаунта не падає чисто, дає сміттєвий `owner`, PDA не збігається. `07` тепер клієнтськи
пре-фільтрує (декодує + звіряє PDA перед включенням у батч, spec risk #19 дозволяє крanky пропускати
юзера) — 8 із 12 пропущено з логом. Реальна міграція — поза скоупом Task 8 (`init_if_needed`
заборонено, міграційної інструкції нема).

### M-B: `06-commitment-reveal.ts` — PASS

Трейдер `FzNNLyJTRzzXXofdQJDxLsKJkaaUcKEZswaXBdqdU5eN` (run `1790053950057`), position
`8XDTRckepCSXRUXdjnBJ8n2xxnqVWrxW9PvaPdJ7hsGt`, dq `BggTKA29JuNVdCExrBvPADfqFAmUeQdN8zVp6xXGCg9y`.
Онбординг (кроки 1-5) — **base** (звичайні L1-транзакції власником, ще до делегації); усе торгове/
committer-дії (кроки 6+) — **ER** (devnet-tee, TEE-автентифіковане з'єднання). `solana confirm` на
base для будь-якого ER-підпису нижче повертає `Not found` за задумом (та сама властивість, що й у
рулінгу 8 вище) — на base видно лише похідні публічні акаунти (`Commitment`/`Disclosure`), не самі
ER-транзакції.

| крок | шар | підпис | таймінг (ER-sig → base-видимість) |
|---|---|---|---|
| fund trader 0.05 SOL | base | `4hogQJCyNyk7ef42HKzuYnDW2gqfPRhX1CcrSFzYuqi6RFwvavJHwPcsXDhuuTRNK8NWDtJEEKR3zHSU7xWBMMRa` | — |
| faucet_init | base | `26UXvvEk7J5rdFLBPCMcnhvMJhQdeGzdKHfcmtsF9Nn33vhTwpvjMppASQLkwgAzoxHu2WRcgJbGVFXcBeqCkqf2` | — |
| init_user (exit_salt) | base | `27M2gAYSZU9G7QFwnYoXRVZb75FRrnDEc4d5658di8BmYQfRR9JomLe3A3aMDxmoSAjNWDQYB8HTSnDAGuFHV2Uh` | — |
| delegateSpl | base | `57c7AyUNeeeCkrqXFLigV9S3Y47p9rniCFdW8Fbxb5gd2LGjr2DV3jZ48fpzyM4miycRJ2aA1HLtueQEivsSVFzx` | — |
| delegate_user | base | `4N2QtegaL42Jjn3pM9dCzXxW2JqKE88CyHWBdbYSpuTrkkUa12n4ET9yVTSS5DGXD2cD9uewYx3Ryj2vj2GW9Lxq` | — |
| credit_deposit | **ER** | `4yuBLvZxG1eHKs21nW5ojufYdoaGkDjSS5MG2VW33nu75dBFyvRfehRca3DSxdnBEB74EnfPtA855bvn8DYhzDmX` | — |
| init_permissions (members=[owner,crank]) | **ER** | `MsTAobmRx33HowFMqAroUwDh5BmNktpxetSQxFChKW9bPi17v7asR2aK6gwjdqecCTuAwz4EtqvdbK8evZKp37d` | — |
| open #1, спроба 1 (nonce 1) | **ER** | `5czdjhkjz7DUPvC2L22KDuJzjTump7VruSqozQ2JF7CFpr1zPoetn7kA7nkUzLNJEGprcDMo2pUJ6W92XeVNLF5b` | — |
| close #1, спроба 1 (nonce 1) | **ER** | `64BeSLcV5cBvK2DfopsKRjwyTddxVBsBpg8vqKKDDZUN7ao3N2MQpoxbU6hKdXExrD6UQ29uo82bqvJwp4LRjR7Y` | — |
| commit_aggregate(position, nonce 1) | **ER** | `2e6LMNHfSXH2jL1XL2rtFNujajxBDAoY23ieUe2s2VRpzvGhXQkXNwZUyo42ChajTTPfpSPKuE2ycbAuXnyigJk1` | 1.2 с (Commitment[1] на base — **колізія**, чужий хеш) |
| mark_committed (nonce 1) | **ER** | не зафіксовано окремо в логу (лише стан-асерт `Position.state==Empty` після) | — |
| drain dq (nonce 1, bogus) | **ER** | `5dWLMCdYVd3WhWvfm24NrVbBgm2hbYyZPSZuHYLDygXQ4d2SgPru2mtUewdbrWLKEs43N16GeFCWpQNRWS21Y75N` | — |
| open #1, спроба 2 (nonce 2) | **ER** | `41p9yfJvtw1q8e6uAjkKHKEsCAJkrGvpLNXSm5jmxh4mUcRdcSmaegv1ZVHbPRYuposdtcuVBNNLuXH5LeszKfi9` | — |
| close #1, спроба 2 (nonce 2) | **ER** | `CgDB1a1U78vuuuGu1U2WaGLvtvBR9DBbhkKDMT6UTQ1YLcbvoXRZpRyAz8LtK1Xrgk8PxN3xyHGRnGbai9prjts` | — |
| commit_aggregate(position, nonce 2) | **ER** | `1a6kE9Cu7q7TzUciMepcFgkcSSPySvHk8VXu72kX3ok2i4nAgobzvpzuiiPFWrQQamCRN4GRYtJ57CKXXSQy2Vu` | **1.1 с** (Commitment[2] на base — хеш збігся) |
| mark_committed (nonce 2) | **ER** | `19S3DiSnHytYTukm4BTbk1HABCmxaNzYq7bQjnkvLBbogpbzjC6d3CeEWzyuHcAc7PxBTJdzynYoJXWzhi7F6H3` | — |
| open #2 (друга позиція) | **ER** | `2QMRQMUSzXy69Yw1WCNC6NcSxHHixL94se6TfUKT9jFb5iYGmbXK9mmbh5ShGtjxj718WzPZBEB9abWPGKEPZsVg` | — |
| close #2 | **ER** | `4XK4i1xfTyoDaRRPnxbYY3V7Q6aUAtAenRNkMRhoo7y8Lukv4kdhU7St1GdVZCE4SPiubmu4zvJteg4CgCqiqohw` | ніколи не комітилась (поза скоупом M-B) |
| commit_aggregate(dq, reveal nonce 2) | **ER** | `pEcCaaVZ7CyU9HdJsS685a5RARVCtNrongwx2UMMk1vQkqnrJLhRzU7j2idP2raxGcRHWyMsWY1JCYCxEk6RE3P` | **3.0 с** (Disclosure[2] на base) |

`Disclosure[2]` — усі поля == `ClosedRecord`, `owner==default`, хеш перевірено (перерахований
`commitmentHash` з полів `Disclosure` + збереженого `salt` == `Commitment[2].hash`). Усі п'ять
PASS-рядків брифу підтверджено: `M-B commitment landed`, `hash matches`, `second position opened`,
`disclosure landed`, `hash verified on-chain`. M-C не перевимірювався на реальній формі (дорого);
спостережено 1 дію на бандл (write_commitment) і 1 дію (write_disclosure) — ніколи разом у цій
задачі; `MAX_ACTIONS_PER_COMMIT` лишається **4**.

### M-E: `07-balances-root.ts` — PASS

`UserAccount`-скан (crank-токен, **ER**): 12 знайдено, 8 застарілого layout пропущено (див.
знахідку вище), 4 сучасного включено в батч. Обидва `set_balances_root`-батчі та обидва
`commit_aggregate`-коміти нижче — **ER**; `root_slot`/`filled`/листки читані з **base** (`decodeBalancesRoot`
на сирих байтах, `zero_copy`-акаунт).

| цикл | `set_balances_root` sig (ER) | `commit_aggregate` sig (ER) | `root_slot` (base) | `filled` | листків змінилось vs попередній цикл | FeeEscrow ER-баланс |
|---|---|---|---|---|---|---|
| #1 | `KXN3LuuZCCKpUat9DSwSDdhnp8VM76o89ogGDSEXm7iShJy6MhLASr6Hb61fjgpoSK1DYnDG633amdjrMnQf7Ae` | `3CTWukQARwU1Q1SRcZ89ug4Fv1BBPQ6DBXpZbh1bcstmRfyK4KoPqUQJJcZ71wUuwrKU3oL9CS1RbKdS87ppDPSJ` | 330038204 | 4 (≤4 реальних трейдерів, ≤64) | — (перший цикл) | не вимірювався окремо (див. 12× нижче) |
| #2 | `2mUAKrKTuxafYYH75x4NHweiWAmmaiSpYTZkXc72rkz2PNfDgkJF17q8cT9KZjGffiV8fW4uXStQNc3iZGpQURNR` | `5fgULfNE9x7MpNkmnuyeMLLJa3yGxdSnGQsSwbm4mit6yNNzFeApDERCTN9rqWV4FA7NuLr4xZK95wpEdoibMPeq` | 330039052 | 4 | **64/64** | — |

Відомий трейдер (з 06) `FzNNLyJTRzzXXofdQJDxLsKJkaaUcKEZswaXBdqdU5eN`: `free_margin=999587254`,
`leaf(owner, free_margin, exit_salt, root_slot)` знайдено на індексі 3 (< `filled=4`, у реальному
діапазоні); жоден паддінг-слот (індекс ≥ `filled`) не збігається з цим листком.

**12× `commit_aggregate` (Pool + BalancesRoot разом), увесь цикл ER**, `FeeEscrow` ER-баланс:

| # | sig (ER) | escrow до → після (лампорти) | дельта |
|---|---|---|---|
| 1 | `HPMVnUdwZcZDWsi8aD6TcM3ZHJx7hMhCpBig1w3ec1GNdXueKF7X4G5QpSxFWUhzXrNyvhxJpuUZnooZf1zUcye` | 200169040 → 200069040 | −100000 |
| 2 | `25SmWnAtwUhwvvt7iPA2mc3nh7tZ5Kv7HQCTditCxK3Q1MSmh79BPkVh9UpSSTRk4EpyW6VFucKh5x55xxdhy1cL` | 200069040 → 199969040 | −100000 |
| 3 | `2Z22yvX1xJwFLwnGuKqbBzWGAinP37oEtSsjWR9cwu2MubjDbHqa48f1Mqt5dKDQCawiAMato7mAbMQBF8WcCFFX` | 199969040 → 199869040 | −100000 |
| 4 | `66Wb7YAqfjvkwwjaPmxEfPvb7rpuHe8WMMqBHvTFmqBzMLU2z7f2bN5aRXY8G5q7AS7w2HgChrxhNNqdk5Jsu3Bb` | 199869040 → 199769040 | −100000 |
| 5 | `2n8aS77ttRBmoxZ5Jm6A2ZaQqvg9mtu7sE492JibxmXdK9VE28LcoZW58QUsWD7gfydAxWtFPyNanDPHfUu3eGbB` | 199769040 → 199669040 | −100000 |
| 6 | `2s7CFHQYqknJ2hhVtNzEpwPC4hFsPJisVNrLhYSbbB4qHNgrY9vS2fGdzXqDJVfh72EYXjFqimRREvMJ8DjQx6CE` | 199669040 → 199569040 | −100000 |
| 7 | `5MzZta872G1YbiJ9Jp697u1UqPbLJ65cfLAbrUDb68w4fv37yDYK4npi6ikSTPkQxj5Ax3xWmjMWcfrYuMwDfifr` | 199569040 → 199469040 | −100000 |
| 8 | `5dsVDZfu1sgnzdqZaDedz281xvSRMzfyJ1JHJW4MbaG6SmkZwiEHwiV1LW6HtaVwZeVn2samcCTMpAyopb6mVBwf` | 199469040 → 199369040 | −100000 |
| 9 | `3w1qrWJTNtzKMYP7Scj7jFjesfbY3bHEZ3rBfuiunhKm8BM9iKkJJSe3htQdmtiqzHjM1g2BSNoRF5K2RmPnxf3E` | 199369040 → 199269040 | −100000 |
| 10 | `5ZoKjqcA7GCJAhD5NYruk5SCg85PGSVDDCpGfcRyoAzxnM2WZp1AfHbCYofVp3UvHzqojYeGJAfHufPxuZ1mjTvC` | 199269040 → 199169040 | −100000 |
| 11 | `56wA6k9m8MBmfyx2wxGDBjkKPoj6YwBDVMWNt7euqKiP7qkPQZqukrLqosnVPKJdU7616kJp3u6PtTECfDHz9ubn` | 199169040 → 199069040 | −100000 |
| 12 | `5YUCQa81QjCw6uDhUmDNKCov84ae4AL4c4x7nHkS1mffBuLTr7t2mhe9CpmtVqEj6w11DBKxpFohu8fDSMQjjxYu` | 199069040 → 198969040 | −100000 |

**12/12 успішно, рівно −100 000 лампортів щоразу** — перша реальна вимір **платного** тіру
(тиждень 2 бачив лише безкоштовний, nonce <25; ескроу сьогодні давно перетнув поріг 25 через усе
тестування задачі). 100 000 лампортів/коміт збігається з `fees-and-commit-economics.md`; чи це за
коміт-транзакцію чи за акаунт — не розрізнено цим вимірюванням (обидва коміти завжди несли
Pool+BalancesRoot разом).

### M-A: `08-undelegate.ts` — НЕ ДОЛЕТІВ (зафіксовано чесно, без сліпого патчу)

Закриття другої позиції з 06 (nonce=3, свіжий, хеш збігся; **ER**), дренаж черги (**ER**),
`withdraw(all=999587254)` (**ER**) — усе PASS. Передумови `undelegate_user` підтверджено:
`Position.state==Empty`, `DisclosureQueue.len==0`, `free_margin==locked_margin==0`. Сам
`undelegate_user` (owner-TEE, **ER**) **падав двічі поспіль з однаковою помилкою**:
`{"InstructionError":[0,"ExternalAccountDataModified"]}` — sig 1 **ER** (devnet-tee)
`3SsSoNncVmLtZcttwTodkt8yexdxTUFnT4ELSGV4dAaCcFbUs4khumFuT7WGf95e8mtJHiJjWH5jsFLauirHjY6X`, sig 2 —
ідемпотентний рестарт скрипту, той самий результат, sig **ER**
`44RWU8R8v8TsNJ1cH43HxUngNomhVS4KwxpXx8HY3E3nR8cktfH4AFwZiwgBpKS6rmVbBwkh4AxwqPMwGWDd6CKZ`.
`solana confirm` на **base** для обох сигнатур повертає `Not found` за задумом (ці ER-транзакції
ніколи не намагались дійти до L1 — сам CPI `commit_and_undelegate` усередині них і впав). Base
підтверджено окремим прямим читанням після обох спроб: `UserAccount`/`Position`/`DisclosureQueue`
усі **лишились** власності `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (Delegation Program), не
`dexxer_core`. На відміну від спайкового M-A (тиждень 3, Task 1 — один акаунт, PASS з першої
спроби), `undelegate_user` робить **три** `CloseEphemeralPermissionCpi` (user_account/position/dq)
і лише потім **один** `commit_and_undelegate` над усіма трьома разом — комбінація, яку LiteSVM
взагалі не може виконати (Magic Program там не задеплоєний) і яку спайк перевіряв лише на одному
акаунті. **Це перше реальне виконання трьохакаунтної комбінації на будь-якій мережі.** Гіпотеза (не
підтверджена читанням вихідного коду Delegation/Permission Program на момент цього прогону)
зафіксована в `task-8-report.md`; **не пропатчено наосліп** — рекомендовано окрему задачу з
розслідування.

**Корінь і фікс: див. §Task 8c (рулінг 10); повторний прогін після редеплою — нижче/наступний
раунд.**

### Гаунтлет і баланси

`npx tsc --noEmit` чисто в `tests/er`, `scripts`, `app`. Rust не змінювався — autofixer/LiteSVM/
`cargo test`/fmt/clippy/IDL поза скоупом цієї задачі.

| ідентичність | до задачі (SOL) | після задачі (SOL) | дельта |
|---|---|---|---|
| `payer` (spikes/keys/payer.json) | 5.950356913 | 5.228740713 | **−0.721616200** |
| `devnet-admin` | 0.46889156 | 0.35488156 | −0.114010 (top-up'и з payer компенсували більше) |
| `devnet-fee-payer` | 0.25 | 0.25 | 0 (сам fee-payer лише авторизує ER-tx; комісії йдуть з `FeeEscrow`, не з його власного base-балансу) |
| `devnet-crank` | 0.1 | 0.1 | 0 (та сама причина — crank підписує лише ER-tx) |
| трейдер `FzNNLyJTRzzXXofdQJDxLsKJkaaUcKEZswaXBdqdU5eN` (06/08) | 0 (свіжий, ще не існував) | 0.027072888 | +0.027072888 (з 0.05 фандингу, решта — ER/base комісії) |

Витрачено payer'ом за задачу **≈0.7216 SOL** (5.950356913 → 5.228740713): редеплой 0.521606200
SOL + два top-up'и `devnet-admin` по +0.1 SOL (
`gSWTvg3hbaCVTgRSj7NXDKGeFybocPX72mtM5BHTSuewPAAG36kzSFVNeS7JCQUA8tC7varQ83751HJxuQcQvT6`,
`2JEn1BNMgmVz644kEsPCSDhrVMCsF14CSr9Q7MW4oibZZYR5ffwdZy4NLWar6kyGo8mu1V8zuHUcHUGgjx8vngmW`, обидва
**base**) — необхідні, бо ruling-8-пробник і повторні прогони 06/07 з'їли поріг `requireFunded`
0.3 SOL на `devnet-admin`.

### Раунд 2 (після 8b/8c)

Редеплой + повторний прогін 06/07/08 на HEAD `a428ecd` (включає 8b — хеш-сідовані `Commitment`/
`Disclosure` PDA — і 8c — явний `exit()` у `undelegate_user` до CPI, що змінює власника). Свіжі
трейдери в обох скриптах (нові `run id`), жодних правок коду цього раунду, крім
`tests/er/devnet/08-undelegate.ts`'s fallback-гілки (додано `getTransaction`
json+jsonParsed/`getSignatureStatuses` на випадок повторного FAIL — не знадобилось, `undelegate_user`
приземлився).

**Редеплой.** Новий бінарник **1 044 728 B** — **менший** за поточну ємність на базі (1 048 272 B),
тож **extend не знадобився**. IDL звірено: `cmp target/idl/dexxer_core.json
app/src/idl/dexxer_core.json` — байт-у-байт ідентичні. Усі підписи нижче — **base**.

| крок | підпис (base) | деталі | payer до → після |
|---|---|---|---|
| `solana program deploy … --url https://rpc.magicblock.app/devnet --use-rpc` (fallback, з першої спроби) | `473MWJ5KfQtJHMzUvPeFERGQDuhRqaGmDUYeS7HPPga4KuvuLXSetsd4tupt6JyvGPXCyDJfh5yihFsbmKJRqUTu` | upgrade, внутрішній буфер закрито атомарно | 6.228740713 → 6.223560713 |

Жодних завислих буферів (`solana program show --buffers --buffer-authority <payer> -u devnet` —
порожньо). `solana program show`: `Data Length: 1048272 bytes` (незмінно, extend не робився),
`Balance: 5.3261006 SOL`. **Чиста вартість: 0.005180000 SOL.**

**M-B round 2 (`06-commitment-reveal.ts`) — PASS, з першої спроби, без жодної колізії nonce.**
Трейдер `Dxssa29ZyNPzDcV6HGBWLstqMScFBCgtd37TkY3Yf9Ni` (run `1790056883639`). Онбординг — **base**;
торгові/committer-дії — **ER**.

| крок | шар | підпис |
|---|---|---|
| open #1 | **ER** | `5GQstyGameF3NLbV7LZiKPjnBziTJkzRCXdE5a86MFxfsnhehBrd9Lo8prSKi6b9qKzp3vbSf4JzswySmWMMATgU` |
| close #1 (nonce 1, hash-сідований) | **ER** | `5PZTfEEvCxo7frcCtK3FgfG1t1aZs1qxEzKGMVAh5UUk5Xcx5HYU6b8FsYiSVaRohTM4B78TtEMg7G8N9qH5rZf8` |
| commit_aggregate(position) | **ER** | `4W8jCtTA14u9wRkoo1E4G5V2xRJqVgJQuJKycsWPTTx8meRtNhCe1CFPchrNG3Zt1VERPU8SPi2DEPJ2EQFR9LtD` — Commitment[hash] на base за **1.4 с**, хеш збігся з першої спроби |
| open #2 (друга позиція) | **ER** | `5dftk8M1qkJUkEcZ38xa4wGZXfAMtk5DybcKY1KRTVDGCrd6QPoN1zoPy4hnoPoCHAygAKa6u3VsDT6UDnvPnRDh` |
| close #2 | **ER** | `2cqi169EW46eavRtgxqX4BgSyoMkYimJE8MGx2vDwswZGLXZCnyKLJGBsKc6MTbjJ1xkBvbBhSipGBt7Zz3V6Yjg` |
| commit_aggregate(dq, reveal) | **ER** | `5nXztCkj267WzNhcSaeXwiH5auyNK5CoroMgQUZTq1mp99KtPur6DQzN1wME9mygTCPmei1k4Eok8SchYkhmE6N` — Disclosure[hash] на base за **3.0 с** |

Усі п'ять PASS-рядків підтверджено: `M-B commitment landed`, `hash matches`, `second position
opened`, `disclosure landed`, `hash verified on-chain`. **Жодного retry-циклу — колізія nonce з
раунду 1 більше не відтворюється** (8b підтверджено на реальному прогоні, не лише за задумом коду).

**Реальні акаунти цього раунду (Task 11, контролерська друга ревʼю-нотатка, 22.09.2026):**
`Commitment` `2iznrHqkFnsyCr8XkKpt6tbpM4QBNxf3Mt1fEdnv6Wnc` (58 B); `Disclosure` — 140 B,
pubkey не зафіксовано у звіті (не знайдено в `task-8-report.md`'s фіксі раунду 2 ні в жодному
іншому task-8-звіті — не вгадується).

**M-E round 2 (`07-balances-root.ts`) — PASS.** Legacy-скіп лишено як inline-варіант у самому
`07-balances-root.ts` (decode + PDA-звірка), НЕ імпорт `runRootCycle` з
`scripts/crank-fallback/disclosure.ts` (та сама причина, що в раунді 1 — уникнути, щоб `tests/er`'s
`tsc --noEmit` тягнув граф сусіднього проєкту; обидва варіанти тепер фільтрують той самий набір,
crank-скрипт — за довжиною байтів через `coder.accounts.size`, `07` — спробою декоду + звіркою PDA).
`UserAccount`-скан: **13** знайдено (12 + новий трейдер round 2), **5** сучасного layout, **8**
застарілих пропущено (той самий набір, що й раунд 1 — жодного нового legacy-акаунта не додалось).
Цикл 1: `filled=5`, `root_slot=330306271`, відомий трейдер (той самий, що в M-B round 2) знайдений на
індексі 1. Цикл 2: `root_slot=330307170`, **64/64 листків змінились**. **12× `commit_aggregate`**:
escrow ER-баланс `198247040 → 195847040` лампортів, **рівно −200 000 щоразу, 12/12** — **вдвічі
дорожче за раунд 1** (там було −100 000/коміт). **Пояснено (Task 11, контролерська друга ревʼю-нотатка,
22.09.2026):** правило тижня 2 (`week2-results.md` M3a/`fees-and-commit-economics.md`) — **100 000
лампортів за кожен закомічений акаунт, щойно nonce-комітів того конкретного акаунта досягнув ≥25**.
Раунд 1 стартував зі свіжого `BalancesRoot` (нижче порогу 25) → того циклу платив лише `Pool`
(100k/коміт). До раунду 2 й `Pool`, і `BalancesRoot` уже перетнули поріг 25 (весь денний прогін тестів
на тому самому `Config`) → платять **обидва** акаунти щокоміт (100k + 100k = 200k/коміт), звідси
рівно подвоєння. Арифметика збігається: `12 × 200 000 = 2 400 000` лампортів = виміряна дельта
ескроу `198 247 040 → 195 847 040` (різниця 2 400 000, точний збіг).

**M-A round 2 (`08-undelegate.ts`) — PASS. `undelegate_user` приземлився.** Закриття лишкової
позиції #2 з 06 (nonce hash-сідований, збігся з першої спроби, **ER**
`2dD9AnrZg7JJ3MqChx7MiKoUZo94vGMtqX2UU5s8fkqdbY3wexKDshgdeAZvL1pxZLuBr2jg5wUXPs8pQkATPQNU`), дренаж
черги (**ER** `3PgmGnjdj7m4Dgg85w11D83NjT4VFen8vw9U45NnN9qCLLZrb2HbQQhxB35e6hPoNiWq3wSHamdeY6fDzBPiezz4`),
`withdraw(all=999734702)` (**ER** `5hzFowC1Eq8v8FL39bLTjbvUhAmzeaT7hDXFYQcN8iLHuGmbpr3guwsvhRH2GPnPxfV25nq7txR24FHTsa5LFKsE`)
— усе PASS. `undelegate_user` (owner-TEE, **ER**) сам:
sig **ER** `3422sohxAKSVmsBwiNU2bnP4cwCsh9uVeiDnE4v6dqArgvg2m9rcuwEwc8DincruURianTrv8tojNGbephdfJt92`
— **успіх, без жодної помилки** (порівняно з двома `ExternalAccountDataModified` у раунді 1). Base
owner-flip підтверджено полінгом за **4.4 с** (з ліміту 180 с). Скраб перевірено на **base**:
`session_key==default`, `exit_salt==0`, `last_withdraw_slot==0`, `DisclosureQueue.len==0`,
`Position.state==Empty`. Незалежно перевірено прямим `solana account`-читанням (не лише скриптом):

| акаунт | адреса | Owner (base) |
|---|---|---|
| Position | `FT4un2Gn4hM2axgERDFvGKKmPHxqwxNuYbs1gNk8pFNv` | `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` |
| DisclosureQueue | `3hqcpdMX1vSg2LN8bEAuNPFQ7dWQyhnFQXmufQbNzc1N` | `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` |
| UserAccount | `Gi4yXLTMzGuc2U5s2bapyou3MWVvCW7w7HM6rkesTzwM` | `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` |

Усі три — `dexxer_core`, не `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (Delegation Program).
**M-A confirmed on dexxer_core.** 8c's гіпотеза (Anchor's автоматичний post-handler `exit()`
переписував скрабнуті байти ПІСЛЯ того, як `commit_and_undelegate` уже змінив ефективного власника,
трапляючи `ExternalAccountDataModified`) підтверджена практично: явний ранній `exit()` для
`user_account`/`position`/`dq` до CPI повністю усунув помилку на реальному devnet-tee, з першої
спроби після фіксу.

**Гаунтлет раунду 2:** `npx tsc --noEmit` чисто в `tests/er`, `scripts`, `app`. Rust не змінювався
цього раунду (лише fallback-логування у `08-undelegate.ts`).

**Баланси після раунду 2:**

| ідентичність | після раунду 1 (SOL) | після раунду 2 (SOL) | дельта |
|---|---|---|---|
| `payer` | 5.228740713 | 6.123555713 | payer профінансовано користувачем ззовні до 6.228740713 перед раундом 2 (не моя дія); з цього старту раунд 2 витратив редеплой 0.005180000 SOL + один топ-ап `devnet-admin` +0.1 SOL → 6.123555713 |
| `devnet-admin` | 0.35488156 | 0.40487656 | +0.05 (нетто: +0.1 топ-ап від payer − ~0.05 власних витрат раунду, зокрема фандинг нового трейдера 0.05 SOL) |
| `devnet-fee-payer` | 0.25 | 0.25 | 0 |
| `devnet-crank` | 0.1 | 0.1 | 0 |
| трейдер `Dxssa29ZyNPzDcV6HGBWLstqMScFBCgtd37TkY3Yf9Ni` (06/08 round 2) | — (не існував) | 0.033108688 | +0.033108688 (з 0.05 фандингу) |

Топ-ап `devnet-admin` раунду 2: +0.1 SOL, sig **base**
`5H1pARUesMqsrDuCVZbTCNf2rvMo6aPeHXrrNRvjPKfcePXVkizV9Yrs9RzfvVzVZiq1FXCvLGcYQyFbntfL3FMF` (перед
07, поріг `requireFunded` 0.3 SOL опинився впритул).

### Файли

- Create: `tests/er/devnet/06-commitment-reveal.ts`, `07-balances-root.ts`, `08-undelegate.ts`.
- Modify: `tests/er/package.json` (`devnet:disclosure|root|undelegate`),
  `tests/er/devnet/03-commit-cycle.ts` (застарілий doc-коментар "лише Pool комітиться" →
  "Pool і BalancesRoot"), `tests/er/devnet/07-balances-root.ts` (fix round 1: doc-коментар
  "7 of 12" → "8 of 12", звірено з реальним логом прогону), цей файл (§Task 8).
- Раунд 2: Modify `tests/er/devnet/08-undelegate.ts` (fallback-гілка: `getTransaction`
  json+jsonParsed/`getSignatureStatuses` на випадок повторного FAIL — не знадобилось).
- Жодних змін у `programs/` цією задачею напряму — 8b/8c (рулінги 9/10) прийшли окремими комітами
  (`9eb22e8`, `c756c04`), уже review-схвалені; Task 8 round 2 лише редеплоїв і перевірив їх на
  реальному devnet.

Повний звіт (кожна команда, вивід, self-review, занепокоєння) —
`.superpowers/sdd/2026-09-22-week3-disclosure-root-exit/task-8-report.md`.

## Task 8 — M-A на dexxer_core: розслідування (рулінг 10)

Розслідування `{"InstructionError":[0,"ExternalAccountDataModified"]}` з `undelegate_user`
(devnet-tee, sig 1 `3SsSoNncVmLtZcttwTodkt8yexdxTUFnT4ELSGV4dAaCcFbUs4khumFuT7WGf95e8mtJHiJjWH5jsFLauirHjY6X`,
sig 2 `44RWU8R8v8TsNJ1cH43HxUngNomhVS4KwxpXx8HY3E3nR8cktfH4AFwZiwgBpKS6rmVbBwkh4AxwqPMwGWDd6CKZ`; обидва
атомарно відкотились — `UserAccount`/`Position`/`DisclosureQueue` лишились у власності Delegation
Program). За дисципліною `systematic-debugging`: root cause до фіксу, мінімальна правка.

### Root cause

`Account<'info, T>::exit()` (Anchor 1.0.2, `anchor-lang-1.0.2/src/accounts/account.rs:255-268`,
`exit_with_expected_owner`) серіалізує безумовно:

```rust
pub(crate) fn exit_with_expected_owner(
    &self,
    expected_owner: &Pubkey,
    program_id: &Pubkey,
) -> Result<()> {
    // Only persist if the owner is the current program and the account is not closed.
    if expected_owner == program_id && !crate::common::is_closed(self.info) {
        let mut data = self.info.try_borrow_mut_data()?;
        ...
        self.account.try_serialize(&mut writer)?;
    }
    Ok(())
}
```

`expected_owner` — це `T::owner()`, `program_id` — `&crate::ID`: для будь-якого акаунта `#[account]`
цієї програми обидва завжди дорівнюють `dexxer_core::ID` на етапі компіляції. Перевірка ніколи не
читає **живе** поле `owner` акаунта — вона тавтологічна. Anchor викликає `exit()` для кожного `mut`
акаунта автоматично одразу після повернення з тіла інструкції (`Accounts::exit`, згенеровано
`#[program]`-макросом) — це поза контролем коду інструкції.

`undelegate_user` (`programs/dexxer_core/src/instructions/user.rs`, до фіксу) скрабить
`user_account`/`dq` (тіло функції, коментар "Scrub") **у пам'яті**, потім тричі викликає
`close_permission_if_present` (кожен раз `CloseEphemeralPermissionCpi` на Permission Program —
жодних записів у дані `user_account`/`position`/`dq`, лише кредит lamports у payer, що не потребує
владності), і нарешті один `commit_and_undelegate` (`MagicIntentBundleBuilder`,
`ephemeral-rollups-sdk-0.16.2/src/ephem/mod.rs:220-271`, `build()`) — це CPI до Magic Program з
інструкцією `ScheduleIntentBundle`, що включає `user_account`/`position`/`dq` як writable акаунти. ER
відрізняється від L1 саме тим, що владність (owner) делегованих акаунтів на L1 — Delegation Program,
а на ER — сама програма (`.agents/skills/magicblock/references/delegation.md:390-396`, "Account Owner
Changes on Delegation"); механізм undelegate — ER-специфічне розширення виконання, не документоване
в клієнтському SDK-крейті (сирці Magic/Permission Program не завантажені локально — поза скоупом цієї
задачі, як і зазначено в брифі).

Спайк (`spikes/01-private-counter-tee/programs/private-counter/src/lib.rs`, `exit()`, рядки 257-283)
робить **той самий** порядок CPI (`CloseEphemeralPermissionCpi` → `commit_and_undelegate`) на **одному**
`Account<'info, Counter>` mut-акаунті й пройшов з першої спроби. Відмінність не в кількості акаунтів
самій по собі і не в типізації (`Account<>` — саме той тип, що документація `delegation.md:104-111`
показує для одноакаунтного `undelegate`) — відмінність у тому, що обробник `exit()` **жодного разу не
змінює** `counter`'s поля: автоматичний фінальний запис Anchor тоді серіалізує ті самі байти, що вже
лежать у даних акаунта (no-op за вмістом). `undelegate_user`, навпаки, **змінює** `user_account`/`dq`
(скраб) перед CPI, що (потенційно) переносить владність — тож фінальний автоматичний запис Anchor
серіалізує **інші** байти, ніж ті, що вже на акаунті, у момент, коли виконуюча програма вже не
власник → `ExternalAccountDataModified`. `position` у `undelegate_user` не змінюється жодним полем —
для нього фінальний запис завжди no-op, як і в спайку.

### Мінімальний фікс

`programs/dexxer_core/src/instructions/user.rs`, `undelegate_user`: одразу після скрабу, до трьох
`close_permission_if_present`, додано явний ранній флаш:

```rust
a.user_account.exit(&crate::ID)?;
a.position.exit(&crate::ID)?;
a.dq.exit(&crate::ID)?;
```

Це записує скрабовані байти в дані акаунта **поки програма — безсумнівний власник** (жодна CPI ще не
виконалась). Фінальний автоматичний виклик Anchor `exit()` (після повернення з `undelegate_user`)
тоді серіалізує **ідентичні** байти — вміст акаунта не змінюється відносно попереднього стану, тож
рантайм-перевірка (яка фіксує порушення лише за розбіжністю вмісту, не за самим фактом виклику
`try_borrow_mut_data`) не спрацьовує, незалежно від того, чи владність до того моменту вже перейшла.
`position` включено в ранній флаш для одноманітності з `user_account`/`dq` і як захист про запас —
сьогодні його запис завжди no-op, але явний ранній `exit()` лишається безпечним, якщо в майбутньому
хтось додасть мутацію `position` у цю функцію, не помітивши цей інваріант. Порядок
(скраб → ранній flush → close_permission ×3 → commit_and_undelegate), guard'и та приватність-коментарі
не змінені.

### Ліміт LiteSVM

LiteSVM не деплоює Magic Program (`magic_program.to_account_info().executable` — false), тож CPI
`commit_and_undelegate` у `undelegate_user` на LiteSVM **завжди пропускається** — LiteSVM не може ні
відтворити, ні спростувати саму гіпотезу про перенесення владності всередині ER-транзакції; 5/5
тестів `tests/litesvm/tests/undelegate.rs` (65 всього в `dexxer_litesvm`, паралельна задача рухає решту)
підтверджують лише що скраб і guard'и не зламані цим фіксом — не що фікс усуває помилку на TEE.

### Що має перевірити наступний прогін на devnet

- `undelegate_user` після повного циклу (закрита позиція, порожня чергу, нульовий баланс) успішно
  лендиться на L1 без `ExternalAccountDataModified` (обидва попередні сиг з рулінгу 10 — контрольна
  група для порівняння).
- Base-стан після успіху: `UserAccount`/`Position`/`DisclosureQueue` **знову** у власності
  `dexxer_core`, не Delegation Program.
- Байти `UserAccount`/`DisclosureQueue` на L1 — справді скрабовані (ті самі перевірки, що
  `undelegate_scrubs_after_full_withdraw` робить на LiteSVM: `session_key`/`session_expiry`/
  `actions_left`/`nonce`/`last_withdraw_slot`/`exit_salt` нульові, `dq.head`/`dq.len` нульові,
  `owner` збережено).
- Якщо помилка повториться попри фікс — це спростовує гіпотезу "автоматичний повторний запис
  Anchor"; наступний крок тоді — читання сирців Permission/Delegation Program (поза скоупом цієї
  задачі) для перевірки, чи саме `commit_and_undelegate` синхронно змінює `owner` всередині ER-tx,
  чи помилка походить з іншого місця (наприклад, самого `close_permission`-CPI на трьох акаунтах
  підряд, або взаємодії `fee_escrow`-як-делегованого-payer'а з `commit_and_undelegate` — цей шлях
  досі ніколи не тестувався: усі попередні перевірені виклики `fee_escrow`+`MagicIntentBundleBuilder`
  (`commit_aggregate`, `withdraw`) використовують лише `.commit(...)`, ніколи
  `.commit_and_undelegate(...)`).

Повний звіт (свідчення, перевірені гіпотези, гаунтлет) —
`.superpowers/sdd/2026-09-22-week3-disclosure-root-exit/task-8c-report.md`.

## Task 8b — хеш-сідовані `Commitment`/`Disclosure` (рулінг 9)

Task 8 (розділ вище, "Знахідка: колізія nonce на глобальних PDA") виявив: PDA `Commitment`/
`Disclosure` сідувалися лише `nonce.to_le_bytes()` (`[COMMIT_SEED, nonce]` / `[DISCLOSURE_SEED,
nonce]`), а `nonce` — це `UserAccount.nonce`, лічильник **на юзера**, що стартує з 0 і стає 1 на
першому `close` будь-якого трейдера. Перший `close` будь-яких двох різних трейдерів тому цілить у
**той самий** глобальний PDA `Commitment[1]`/`Disclosure[1]` — другий `write_commitment` падає на
`init` (акаунт уже зайнятий). Рулінг 9: сідувати обидва PDA хешем комітменту замість nonce —
`[COMMIT_SEED, hash]`, `[DISCLOSURE_SEED, hash]`, де `hash = commitment_hash(&args, &salt)` — унікальний
на кожен запис і privacy-нейтральний (на відміну від глобального лічильника на `Pool`, який видавав
би порядок закриттів між усіма трейдерами). Поле `nonce` лишається в `DisclosureArgs`/`ClosedRecord`
як було — це bookkeeping-поле, не seed.

### Дизайн seed-виразу

`WriteCommitment` уже мала `#[instruction(nonce: u64, hash: [u8; 32])]` (Task 2) — досить було
змінити `seeds = [COMMIT_SEED, &nonce.to_le_bytes()]` на `seeds = [COMMIT_SEED, &hash]` (готовий
аргумент інструкції, нуль додаткової роботи).

`WriteDisclosure` приймає `(args: DisclosureArgs, salt: [u8; 32])`, без окремого поля `hash` — хеш
довелося рахувати прямо у виразі seed: `seeds = [DISCLOSURE_SEED, &commitment_hash(&args, &salt)]`
(і так само для читання `commitment` — `seeds = [COMMIT_SEED, &commitment_hash(&args, &salt)]`,
`bump = commitment.bump`). Керована процедурним макросом Anchor 1.0.2 підстановка виразу-виклику
функції (не просто константи/аргумента) в `seeds =` **компілюється без змін** — `cargo check -p
dexxer_core` пройшов з першої спроби, жодного альтернативного явного `hash`-аргументу з `require!`
не знадобилося. Дублювання обчислення `commitment_hash` (у двох місцях виразу seeds) прийнятне —
keccak дешевий, і оптимізатор Anchor-макросу все одно генерує окремі виклики для кожного constraint.

Клієнтська сторона (`commit.rs::process_position_candidate`/`process_disclosure_queue_candidate`,
які самі будують `CallHandler`-акаунти для `write_commitment`/`write_disclosure`) вже мала `hash` у
руках (`pending_commitment`/`due_reveals` обидва повертають `(..., hash)` — жодних додаткових
обчислень, лише заміна `find_program_address(&[SEED, &nonce.to_le_bytes()], ...)` на
`find_program_address(&[SEED, &hash], ...)`.

### Тест на колізію (TDD)

Новий LiteSVM-тест `commitments_from_two_traders_do_not_collide`
(`tests/litesvm/tests/disclosure.rs`): два різні трейдери, кожен відкриває і закриває свою першу
позицію (`open_then_close` — обидва `ClosedRecord.nonce == 1`, підтверджено `assert_eq!` перед
основною перевіркою — так тест довів би, що сценарій колізії справді відтворений, а не випадково
уникнутий різними nonce). Обчислені `commitment_hash` для двох записів — різні (`assert_ne!`), тому й
похідні PDA `pdas::commitment(&hash1)`/`pdas::commitment(&hash2)` — різні адреси. Обидва позиції
комітяться в одному виклику `commit_aggregate(remaining=[pos1, pos2])` — обидва прапорці
`commitment_written` успішно виставляються, без падіння на `init`-колізії, яка була б неминучою до
цього фіксу (в тому самому `commit_aggregate`-виклику другий `write_commitment`-екшн націлився б у
вже зайнятий `Commitment[1]`). LiteSVM: 64 → **65** тестів.

### Крank пропускає застарілий layout (друга знахідка Task 8)

Task 8 також знайшов: 8 з 12 `UserAccount` на девнеті — з layout до `exit_salt`/`last_withdraw_slot`
(тижні 1-2), коротші за поточний, і ламають увесь батч `set_balances_root` (`InvalidLeafAccount`),
бо Rust-сторона не падає чисто на декодуванні застарілого/коротшого акаунта. Task 8 обійшов це лише
в одноразовому devnet-скрипті (`07-balances-root.ts`); Task 8b переносить той самий фільтр у
постійний crank-fallback (`scripts/crank-fallback/disclosure.ts`), який реально працюватиме проти
живого mixed-layout стану:

- `runRootCycle`: перед побудовою батчів `set_balances_root` фільтрує `UserAccount`-акаунти за точною
  довжиною байтів — `ctx.prog.coder.accounts.size("UserAccount")` (дискримінатор + `8 +
  UserAccount::INIT_SPACE`, з IDL-кодера, не хардкод) — і логує кожен пропуск (`skipped legacy:
  <pubkey> len=<n>`).
- `runDisclosureCycle`: `decodeOrSkip` обгортає декодування `Position`/`DisclosureQueue` (`try`/`catch`
  навколо `coder.accounts.decode`, яке на застарілому/коротшому буфері кидає `RangeError
  [ERR_OUT_OF_RANGE]` замість чистої помилки) — акаунт, що не декодується, пропускається з тим самим
  логом, не валить увесь цикл.
- `mark_committed`-гейт (той самий файл) тепер шукає `Commitment` за
  `pdas.commitment(commitmentHash(argsFromClosedRecord(record), record.salt))` замість
  `pdas.commitment(nonce)` — узгоджено з рулінгом 9.

### Клієнт: TS/App

- `tests/er/lib/program.ts`, `app/src/lib/pdas.ts`: `pdas.commitment`/`pdas.disclosure` тепер беруть
  `hash: Uint8Array | string` (32 байти або hex) замість `nonce: bigint | number`.
- `tests/er/devnet/06-commitment-reveal.ts`: прибрано nonce-колізійний retry-цикл (`MAX_NONCE_ATTEMPTS`,
  drain-бридж через `commit_aggregate(dq)` для "чужого" nonce) — з хеш-сідованими PDA колізія
  структурно неможлива, один цикл open/close/commit/reveal достатній.
- `tests/er/devnet/08-undelegate.ts`: той самий retry-цикл прибрано з кроку "закрити позицію #2
  перед undelegate" — один `commit_aggregate` + `mark_committed` тепер завжди влучає у власний PDA.
- App: `HistoryScreen.tsx` тепер зіставляє власну історію з публічними `Disclosure` на L1 за
  `commitmentHash(args, salt)`, а не за `nonce` — `Disclosure.nonce` теж лишається per-user полем, тож
  зіставлення лише за ним теоретично показало б рядок **чужого** трейдера, якщо їхні nonce
  збіглися. Хеш рахується з ще-непроявленого `ClosedRecord` (де є `salt`; у розкритому `Disclosure`
  його вже нема) і зберігається в `expo-secure-store` під `dexxer.hashes.<owner>` (перейменовано з
  `dexxer.nonces.<owner>`; старі nonce-записи не мігруються — прийнятно для devnet-кешу, що
  переповнюється з живої `DisclosureQueue`). Розкриті записи тепер читаються прямим точковим
  запитом `pdas.disclosure(hash)` через `getMultipleAccountsInfo`, а не повним
  `getProgramAccounts`-сканом з фільтром по nonce. `commitmentHash`/`assertCommitmentGolden`
  (`app/src/lib/program.ts`) — той самий golden vector, що й `tests/er/lib/hashes.selftest.ts` і
  Rust `commitment_hash_golden_vector`, перевіряється під `__DEV__` поряд із `assertLeafGolden`.
- `app/src/idl/dexxer_core.json` — перекопійовано байт-в-байт з `target/idl/dexxer_core.json` після
  `anchor build`: для `WriteDisclosure`'s `disclosure`/`commitment` акаунтів Anchor більше не може
  виразити `pda`-метадані в IDL (seed — виклик функції, не константа/аргумент), тому цей блок просто
  зникає з IDL для цих двох акаунтів — очікувано, не регресія.

### Гаунтлет

`program_autofixer` (0 issues на обох змінених `.rs`), `cargo fmt --all -- --check`, `cargo clippy -p
dexxer_core -- -D warnings`, `anchor build` (жодного stack-offset попередження на функції
`dexxer_core` — уся "syn"/"anchor_syn" пітьма в виводі передує цій зміні), `cargo test -p dexxer_core`
51/51, `cargo +nightly-2026-09-18 test -p dexxer_litesvm` 65/65 (64 + 1 новий), `npx tsc --noEmit` у
`tests/er`/`scripts`/`app` — чисто, `npm run selftest:hashes` 3/3, `cd app && npm run lint:check` —
чисто.

Файли: `programs/dexxer_core/src/instructions/{disclosure,commit}.rs`; `tests/litesvm/src/{pdas,ixs}.rs`,
`tests/litesvm/tests/disclosure.rs`; `tests/er/lib/program.ts`,
`tests/er/devnet/{06-commitment-reveal,08-undelegate}.ts`, `scripts/crank-fallback/disclosure.ts`;
`app/src/lib/{pdas,program}.ts`, `app/src/features/history/HistoryScreen.tsx`,
`app/src/idl/dexxer_core.json`; `docs/superpowers/specs/2026-09-18-dexxer-mvp-design.md` (§2.1, текст
seed).

## Task 9: Мобілка — History-таб, Receipt-секція, `live.ts`, повторний Open

Комміт `68f3a31`. **Код-only пас** — живого прогону на емуляторі ця задача не робила (заплановано
після редеплою Task 8; контролер ще не провів — див. «відкрите для тижня 4» нижче). `useLiveAccount`
винесено з `PositionScreen.tsx` у новий `app/src/lib/live.ts`. Декодери дописані в `app/src/lib/program.ts`:
`decodeDisclosureQueue`, `decodeDisclosure`, `decodeBalancesRoot` (ручний `repr(C)`/bytemuck-офсет,
Anchor'ів Borsh-кодер не вміє zero_copy), `readUserAccountExitSalt`, `leafHex`/`assertLeafGolden`
(golden vector, `__DEV__`-перевірка при завантаженні модуля). Усі офсети (`ClosedRecord`,
`DisclosureQueue`, `Disclosure`, `BalancesRoot`) перевірені побайтово проти реального коду Rust — **знайдено
й виправлено**: чернетковий порядок полів `ClosedRecord` у плані (де `salt` йшов останнім) не збігався
з реальним кодом (`salt` йде перед `nonce`/`reveal_after_slot`/`commitment_written`) — код переміг,
план виправлено в §4.1 вище.

`HistoryScreen` читає `DisclosureQueue` наживо (session TEE-зʼєднання) для ще нерозкритих записів;
розкриті — точковим запитом `Disclosure` за хешем (після Task 8b). `ReceiptSection` (Account-таб,
під `AccountUiTokenAccounts` — не окремий файл під `app/app/(tabs)/account/*`, як припускав брифовий
глоб: реальний контент цього табу живе в `app/components/account/account-feature.tsx`, задокументовано
як свідоме відхилення) рахує `leafHex(owner, free_margin, exit_salt, root.rootSlot)` і звіряє проти
всіх 64 листків `BalancesRoot`. Гейт повторного Open уже коректний без змін —
`TradeScreen.tsx`'s `hasOpenPosition = position?.state === 'Open'` природно відкривається знову після
`mark_committed` повертає `Position → Empty`.

Гаунтлет: `npx tsc --noEmit` чисто, `npx expo lint` — 0 problems. Golden-check (`leafHex` проти Rust-
і TS-еталону) підтверджено окремим `node -e`-скриптом поза RN-рантаймом. Повний звіт з таблицями
офсетів — `task-9-report.md`.

**Не зроблено в цій задачі (не забуто, свідомо відкладено):** живий прогін на емуляторі + скріншоти
для `docs/superpowers/plans/assets/` — **скріншоти — після живого прогону (контролер)**.

## Task 10: CI (GitHub Actions)

Комміт `176c6ef`. `.github/workflows/ci.yml`: два джоби — `program` (Rust: `cargo fmt --check`,
`cargo clippy -D warnings`, `anchor build`, `cargo test -p dexxer_core -p mock_oracle`,
`cargo +nightly-2026-09-18 test -p dexxer_litesvm`, `program_autofixer` не в CI — MCP-інструмент,
локальний гейт) і `typescript` (`tsc --noEmit` ×3 + `npm run selftest:hashes` + `expo lint`). Версії
звірені проти репозиторію напряму: Rust `1.89.0` (не `"1.89"` з брифу — точний збіг із
`rust-toolchain.toml`), Solana `3.1.9`, Anchor `1.0.2` (обидва — `Anchor.toml`'s `[toolchain]`), Node
`24.18.0`. Кешування: `actions/cache@v4` на `~/.cache/solana` + `~/.avm`/`~/.cargo/bin/{avm,anchor}`,
`Swatinem/rust-cache@v2`; `concurrency`-група скасовує застарілі прогони. `anchor build` без
попередньо задеплоєних `keys/programs/*` — програма сама генерує keypair у `target/deploy/`, звірка
з `declare_id!` відбувається лише на `anchor deploy`, не на `build`.

Локально перевірено все, що можна без запуску самого CI: `cargo fmt --check` чисто, `tsc` ×3 чисто,
`selftest:hashes` 3/3, `expo lint` чисто, YAML парситься (`ruby -ryaml`). **Не перевірено й чесно
позначено як ризик:** реальний час `anchor build`/`avm install` на холодному GitHub-раннері,
`clippy`/`cargo test`/LiteSVM — не прогнані в межах цієї задачі (паралельні задачі активно редагували
`programs/**`), надійність кешу для трьох `package-lock.json` під одним `setup-node`-кроком. **Перший
реальний прогін CI станеться на PR — не верифіковано в цьому раунді, контролер перевіряє на PR.**
Повний звіт — `task-10-report.md`.

## Тиждень 3 — LiteSVM траєкторія (39 → 65)

| Крок | Задача | LiteSVM | Коментар |
|---|---|---|---|
| старт (`53ae985`) | — | 39 | week 2 фінал |
| `1351b75` | Task 0 | 39 | без нових LiteSVM-тестів (лише unit 46→49) |
| `2360638` | Task 2 | 41 | +2, escrow-signer негативні тести |
| `26c605d` | Task 2 fix round 1 | 43 | +2, пре-фандований PDA доводить `InvalidActionSigner` |
| `2085288` | Task 3 | 46 | +3, `commit_aggregate` дії |
| `1f6bd90` | Task 4 | 51 | +5, `mark_committed` |
| `5e4ee42` | Task 3 fix round 1 | 55 | +4, `commit_actions.rs` (due_reveals-покриття) |
| `6a1a145` | Task 5 | 59 | +4, `root.rs` (zero_copy проба+GREEN) |
| `b57a9d7` | Task 6 | 63 | +4, `undelegate_user` гейти+скраб |
| `1241a2c` | Task 6 fix round 1 | 64 | +1, `last_withdraw_slot`-скраб + Closed-unmarked гейт |
| `9eb22e8` | Task 8b | 65 | +1, колізія nonce між трейдерами |
| `c756c04` | Task 8c | 65 | 0 нетто (LiteSVM не бачить справжнього M-A CPI — Magic Program не задеплоєна) |

Фінал — **65 тестів** (CLAUDE.md). Unit (`cargo test -p dexxer_core`): 46 → **51** (49 після Task 0
+ 2 golden vectors, Task 7).

## Тиждень 3 — консолідована таблиця вартості комітів (M-E)

| Раунд | Що коміталось | Lamports/коміт | Пояснення |
|---|---|---|---|
| Task 8, раунд 1 | `Pool` (свіжий, nonce < 25) + `BalancesRoot` (нижче порогу 25) | 100 000 | лише `Pool` уже перетнув nonce-поріг 25 на тому ескроу |
| Task 8, раунд 2 | `Pool` + `BalancesRoot` (обидва nonce ≥ 25) | 200 000 | обидва акаунти платять по 100k — `12 × 200 000 = 2 400 000` = виміряна дельта ескроу `198 247 040 → 195 847 040`, точний збіг |

Правило (`fees-and-commit-economics.md`, week2-results M3a): **100 000 лампортів за кожен закомічений
акаунт, щойно акаунтів власний commit-nonce досягнув 25**; nonce < 25 — безкоштовно (виміряно тижнем 2).

## Рулінги тижня 3 (зведення)

| # | Про що | Рішення |
|---|---|---|
| 1 | `Context`-лайфтайми для `remaining_accounts` | однолайфтаймова форма `crank_tick`, не 4-лайфтаймовий чернетковий текст плану |
| 2 | Гроші (payer-баланс на старті Task 0) | 4.29 SOL, не 4.59 — план скоригований наживо |
| 3 | Порядок задач | 0 → 1 → 2 … як заплановано |
| 4 | `pending_commitment`-умова | `state == Closed` еквівалентно брифовому подвійному запереченню |
| 5 | `BalancesRoot`-лейаут | Borsh пробиває SBF-стек → `zero_copy`/`repr(C)`, обовʼязкова проба перед рішенням |
| 6 | Golden vectors | один Rust-юніт-тест + TS `selftest:hashes`, той самий hex в обох мовах |
| 7 | Nonce reuse | write-once `Commitment`/`Disclosure` — навмисно; `TooManyActions` лише на `Position`-шляху |
| 8 | `fee_payer` як єдиний signer `commit_aggregate` | **PASS** на приватному `Position` (не member) — TEE-permission гейтить читання (RPC), не tx-інклюзію не-членом; нове спостереження → ризик #23 |
| 9 | Колізія nonce `Commitment`/`Disclosure` | сідувати хешем commitment-у, не per-user nonce |
| 10 | `ExternalAccountDataModified` на `undelegate_user` | Anchor'ів автоматичний `exit()` переписує скрабнутий акаунт після зміни власника → явний `exit()` до CPI |

## Тиждень 3 — відкрите для тижня 4

- **Task 9 живий прогін на емуляторі — ПРОВЕДЕНО 22.09** (`local_phone`, fakewallet, свіжий гаманець `45EjKM…`): onboarding → Open Long 1 SOL → Close → цикл crank-а (`commit_aggregate actions=4`, наступний цикл `root: filled=6`, `mark_committed owner=45EjKM… nonce=1`) → History показує запис, Trade знову дозволяє Open. Скріншоти: `assets/week3-01-onboarding-complete.png`, `assets/week3-02-history-after-mark-committed.png`. Знайдено й виправлено наживо: `runRootCycle` падав на `coder.accounts.size("UserAccount")` (camelCase, `a9dedf2`). Receipt ✓ і «розкрито ✓» — після наступних комітів, не зафіксовано скріншотом.
- **Перший реальний прогін CI (`.github/workflows/ci.yml`) на PR** — локально все, що можна, перевірено;
  холодний GitHub-раннер (час `anchor build`/`avm install`, кеш для 3 `package-lock.json`) — не виміряно.
- **Питання #23 до MagicBlock** — чи не-member програма може скопіювати байти приватного акаунта в
  публічний у тій самій tx, де `fee_payer` (не member) успішно включив приватний `Position` у
  `commit_aggregate`'s `remaining_accounts` і транзакція виконалась.
- **`i64::MAX`-переплановування на реальному продакшн-розкладі devnet** — виміряно PASS лише на
  окремому спайку (Task 1 M-D); реальний `dexxer_core`'s `schedule_crank` ще не перезапущений з цим
  значенням. Персистентність через рестарт валідатора лишається невиміряною.
- **Очищення legacy `UserAccount`** — 8 із 13 devnet-акаунтів (weeks 1–2, старий layout) досі сторонені
  крank-фільтром; програмної міграції немає, визнано прийнятним тестовим сміттям.
- **`decodeOrSkip` (crank) — catch-all, не специфічний до `RangeError`** — ловить будь-який виняток
  декодування, ширше за суворо потрібне (Task 8b's власна нотатка).
- **Мертвий `readAllDisclosures`-експорт в app** — лишився невикористаним після переходу History на
  точковий запит за хешем (Task 8b).
- **`ReceiptSection`'s постійний стан "Loading…"**, коли `UserAccount` відсутній — не оброблено (Task 9's
  власна нотатка).
- **Ризик #24 (Pool/MarketRisk не permissioned в ER)** — §7.1 нового ризику: живі лічильники `Pool`/
  `MarketRisk` читаються будь-ким з ER RPC-доступом кожен блок, обходячи 5-хв batch-мітигацію L1;
  дизайн-рішення (розділити на приватний робочий акаунт + публічний знімок) — тиждень 4.
- **Ризик #25 (фінальне ревʼю гілки, I-1) — передбачувана сіль commitment-у**: `ClosedRecord.salt =
  keccak(owner ‖ nonce ‖ closed_slot)`, усі входи відновлювані зовні → `Commitment.hash` можна перебрати
  проти публічних mark-цін до `reveal_after_slot`. Тиждень 4: TEE-рандом або клієнтська per-close сіль.
- **Ризик #26 (рулінг 7 + фінальне ревʼю, I-2) — незворотний дроп Magic Action**: невдалий bundle знімає всі
  actions; `commitment_written` без L1-`Commitment` застигає `Position` у `Closed`, а pop-при-емісії губить
  `Disclosure` назавжди. Прийняте обмеження MVP; тиждень 4 — re-emit-інструкція / pop після підтвердження.
- **Crank: retry `commit_aggregate` без кандидатів** (I-3) — зроблено після фінального ревʼю
  (`scripts/crank-fallback/disclosure.ts`): якщо виклик із `remaining_accounts` падає, той самий цикл
  повторює його з порожнім списком, щоб фіксований коміт `Pool`+`BalancesRoot` не залежав від одного
  «отруйного» акаунта. Не перевірено на devnet (лише `tsc`).
- **ZK-доказ забезпеченості (обговорення 22.09, записано в spec §2.4.5 + мітигація #24)** — пост-MVP: публічний знімок = `root + Groth16-proof + огрублений ratio` (alt_bn128 верифікація ≈170–500k CU раз на 5 хв, Poseidon-листки, Noir/Sunspot, прувер у TEE). Передумова — фікс #24 (приватний робочий агрегат). Не входить у тиждень 4 як код; входить як дизайн-рішення й пітч-теза.
- **History показує запис лише після `mark_committed`** (живий прогін 22.09): між Close і `mark_committed` (до 5 хв) `ClosedRecord` лежить у `Position.closed` (owner-TEE, читається миттєво), але History читає лише `DisclosureQueue` + L1 `Disclosure`. Тиждень 4 (#22/Task 9 follow-up, лише app): History додатково читає `Position` через `useLiveAccount`; `state == Closed` → рядок одразу зі статусом «закрито, commitment у наступному коміті (≤5 хв)» → «розкриється через N слотів» → «розкрито ✓». 5-хв каданс потрібен лише L1, не власнику.
- **Публічний індексер + crank на Railway (рішення 22.09)** — бекенд лише для публічних даних (L1 `Disclosure`/`Commitment`/`BalancesRoot`/`Pool`-снапшоти, ціни оракула → REST/WS для графіків і 13F-ленти, push). Приватний стан — лише клієнт через owner-TEE; замінити polling на `accountSubscribe`. Правило записано в CLAUDE.md.
- **ER/base-мітки сигнатур** — зроблено (Task 8 fix round 1: кожна сигнатура в §Task 8 позначена ER
  або base).
