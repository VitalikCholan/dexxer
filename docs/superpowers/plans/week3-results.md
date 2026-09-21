# Тиждень 3 — результати

13F-розкриття, `BalancesRoot`, вихід (`undelegate_user`). Гілка `week3-disclosure-root-exit`,
HEAD на старті `1351b75`. Документ веде той самий формат, що й `week2-results.md`: виміряний
підсумок для контролера й спеки, не заміна власних task-звітів
(`.superpowers/sdd/2026-09-22-week3-disclosure-root-exit/task-N-report.md`).

Нижче — Task 1: виміри M-A, M-C, M-D на спайках (`spikes/01-private-counter-tee`,
`spikes/06-magic-action`, `spikes/05-crank-tee`), реальні транзакції на Solana devnet
(`https://rpc.magicblock.app/devnet`) і TEE-ролапі (`https://devnet-tee.magicblock.app`).
Запуск: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`, потім з `spikes/`:
`npx tsx 01-private-counter-tee/w3-ma.ts`, `npx tsx 06-magic-action/w3-mc.ts` (+ `w3-mc-cap.ts`
для розширеного пошуку межі), `npx tsx 05-crank-tee/w3-md.ts`; або оркестратор
`tests/er/devnet/w3-measure.ts` (`npm run devnet:w3measure` у `tests/er/`, M-A + M-C; M-D — лише
з `RUN_MD=1`, бо спайк 05 треба задеплоїти заново — див. §M-D нижче).

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

**Статус: виміряно, реальна межа (24 PASS / 25 FAIL) вища за дефолтне `MAX_ACTIONS_PER_COMMIT = 4`.**

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

**Межа звужена до одного значення:** n=24 PASS, n=25 FAIL (обидва — окремо перевірені прогони, не
екстрапольовані). `0xa0000000`/`0xa0000002` — коди помилок делегаційної/magic-програми на CPI
самого коміту (не `DexxerError`-коди спайку); повний трейс логів недоступний (`getLogs()` кидає
`missing or invalid signature`, бо підпис ніколи не породжено — симуляція впала до відправки).

**Важливе застереження для перенесення в `dexxer_core`:** межа 24 виміряна для дії з **2 акаунтами
даних** (`leaderboard`, `counter`) + пара `escrow_auth`/`escrow` + `source_program` = 5 акаунтів на
дію, ~200 000 CU заявлених на дію. `write_commitment` (Task 2 плану) має 3 акаунти даних
(`commitment`, `config`, `system_program`) + та сама escrow-пара = 5; `write_disclosure` — 4 +
escrow-пара = 6. Більші дії, ймовірно, впираються в межу CU/розміру раніше — 24 тут не переноситься
напряму як «завжди безпечне» число для `dexxer_core`'s дій, лише як верхня межа механізму самого по
собі за такої форми дії.

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

**(b) `MAX_ACTIONS_PER_COMMIT` — виміряна межа механізму 24 (PASS) / 25 (FAIL) для дії з 5
акаунтами (~200 000 CU/дію), але рекомендація для `dexxer_core` — лишити дефолт `4` (Task 0),
не піднімати до виміряного максимуму.** Причини: (i) виміряна межа специфічна для форми дії
спайку 06 (2 акаунти даних); `write_commitment`/`write_disclosure` мають більше акаунтів на дію
(5–6) і, ймовірно, впираються в межу раніше — не виміряно напряму на цій формі; (ii) навіть за
низького n=1..12 усе PASS з першої спроби без жодної деградації — запас між `4` і виміряними
`24` величезний, тож `4` — консервативний, безпечний вибір без емпіричного тиску його піднімати;
(iii) `MAX_ACTIONS_PER_COMMIT` контролює й латентність розкриття при масових закриттях (§2.4.4 п.11)
— менше акцій на коміт означає частіші, дрібніші commit-цикли, а не ризик відмови bundle. Task 8
може повторно виміряти на реальній формі `write_commitment`/`write_disclosure`, якщо продуктивність
`4` виявиться вузьким місцем.

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

### Баланс `payer` (весь Task 1)

| момент | баланс (SOL) |
|---|---|
| на старті задачі | 4.293945697 |
| після `extend`+`deploy` спайку 01 (M-A) | 4.240071497 |
| після `extend`+`deploy` спайку 06 (M-C) | 4.186327297 |
| після фандингу `user` +0.05 SOL (для розширеного M-C прогону) | 4.136322297 |
| після деплою спайку 05 (M-D) | 2.459689617 |
| після `solana program close` спайку 05 (+1.674149560 SOL) | **4.133834177** |
| **підсумкова дельта за Task 1** | **−0.160111520 SOL** |

`user` (`JAMfwKsWBpug6UpsjwRc71w7rRbzZgAn7tTisvzFHe3D`): 0.076227216 SOL на старті → 0.073367416 SOL
у кінці (плюс отримані від payer 0.05 SOL посередині) — фактичні витрати `user`-а за весь Task 1
(комісії + escrow топ-ап 0.05 SOL): **0.052860 SOL**.

### Файли

- Modify: `spikes/01-private-counter-tee/programs/private-counter/src/lib.rs` (+ `exit`,
  `ExitCounter`), `spikes/06-magic-action/programs/magic-actions/src/lib.rs` (+
  `commit_with_n_actions`), `spikes/05-crank-tee/Anchor.toml` (новий `[programs.devnet]` id,
  `anchor keys sync`), `spikes/05-crank-tee/programs/crank-counter/src/lib.rs` (+
  `schedule_tick_and_reschedule`, `tick_and_reschedule`, `ScheduleIncrementArgs: Clone`),
  `tests/er/package.json` (`devnet:w3measure`).
- Create: `spikes/01-private-counter-tee/w3-ma.ts`, `spikes/06-magic-action/w3-mc.ts` +
  `w3-mc-cap.ts` (розширений пошук межі, n=16..64), `spikes/05-crank-tee/w3-md.ts`,
  `tests/er/devnet/w3-measure.ts` (оркестратор — шелить у спайкові скрипти; M-D лише з `RUN_MD=1`,
  бо потребує нового деплою спайку 05 — той, що вимірювався тут, уже закритий).
- `target/deploy/*-keypair.json` (нові program keypairs для спайків 01/05/06) — НЕ комітяться
  (gitignored, як і решта `target/`).

`anchor build` чисто на всіх трьох змінених спайках. `export PATH=...` → `cd tests/er && npx tsc
--noEmit` — чисто (0 помилок), включно з новим `devnet/w3-measure.ts`.
