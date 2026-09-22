# Тиждень 3 — результати

13F-розкриття, `BalancesRoot`, вихід (`undelegate_user`). Гілка `week3-disclosure-root-exit`,
HEAD на старті `1351b75`. Документ веде той самий формат, що й `week2-results.md`: виміряний
підсумок для контролера й спеки, не заміна власних task-звітів
(`.superpowers/sdd/2026-09-22-week3-disclosure-root-exit/task-N-report.md`).

Нижче — Task 1: виміри M-A, M-C, M-D на спайках (`spikes/01-private-counter-tee`,
`spikes/06-magic-action`, `spikes/05-crank-tee`), реальні транзакції на Solana devnet
(`https://rpc.magicblock.app/devnet`) і TEE-ролапі (`https://devnet-tee.magicblock.app`).
Запуск: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`, потім з `spikes/`:
`npx tsx 01-private-counter-tee/w3-ma.ts`, `npx tsx 06-magic-action/w3-mc.ts` (+ `w3-mc-cap.ts` для
розширеного пошуку межі — обидва історичні, сплутані з per-акаунтною квотою, див. §M-C; `w3-mc-fresh.ts
<fresh-payer-keypair.json>` — справжнє вимірювання на свіжому акаунті, потребує окремого тимчасового
деплою, див. fix round 1), `npx tsx 05-crank-tee/w3-md.ts`; або оркестратор
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
5.950356913 SOL — запас ≈0.098 SOL, продовжено.

`solana program extend … 101640` — успіх, payer 5.950356913 → 5.434020713 SOL. Перша спроба
`anchor deploy --provider.cluster devnet` **впала на `429 Too Many Requests`** —
`--provider.cluster devnet` резолвиться на дефолтний `api.devnet.solana.com`, не на
`rpc.magicblock.app/devnet` (в `Anchor.toml` нема кастомного URL для `devnet`); лишила завислий
буфер `Amq9zwWWjETqXS5K42ax7xj6jSMXWPkrnug1Mv6pykxr` (5.2844446 SOL) — закрито
(`solana program close … --bypass-warning`), повернуто, payer → 5.433905713 SOL. Друга спроба —
fallback-шлях із брифу: `solana program deploy … --url https://rpc.magicblock.app/devnet --use-rpc`
— **успіх з першої спроби**, sig
`66DEy5nb9TTEoSKnGhXxDBhz79SYVuvkt3VE9mdA3U6AAuLvVZpq6ukY19jiZcAQ1FSQCnqdFeK4pM8WEe43D9nU`, payer →
5.428750713 SOL. Жодних завислих буферів після. **Чиста вартість редеплою: 0.521606200 SOL**
(0.516336 extend + ~0.0053 net deploy). `devnet-bootstrap.ts` (ідемпотентно) створив і делегував
`BalancesRoot` уперше цієї гілки (`init_balances_root`
`2ZaZ136g6r7Esh2Eq8AXKAL8UDC7dcVXVcTTTxML5WszhmfQ3sE9zwTSE4aaUP4mqoJmiLudNNUHynPVet1wknQk`,
`delegate_balances_root`
`44Syeax6Tne27zNDdVrxtUTj69yPXJ3MB4XpLhNqbaxu61e6ibS6xaFAqrPVtNkAQtyYTfXeaYp24fGhoxtkTYwJ`).

### Рішення після рулінгу 8

Виміряно на throwaway-трейдері (окремий, не 06-скрипту) реальним `commit_aggregate` з
`remaining_accounts=[Closed Position]`: **(i)** підписаний лише `fee_payer` (не permission-член
позиції — члени `[owner, session, crank]`) — **PASS**, sig
`3yNb9tg2qxzkTbLwNpcf6jV9HKipzEapQsRHU5htpkVV1Cp2LLjzKz14R93BmBiWE3uMaq5cDATjPhErUUUShz1M`,
підтверджено незалежно (перечитано `Position.closed.commitmentWritten==true`, `Commitment` PDA
реально існує на base, 58 байт). **(ii)** та сама tx з `crank` як зайвим підписантом транзакції
(не інструкції) — **REJECTED**, `unknown signer` (структурна відмова Solana, не TEE-фільтр
приватності). **Жоден із двох сценаріїв брифу не спрацював** — (i) вже проходить, тож ні
`extraSigners`, ні новий `set_fee_payer`-admin-ix не знадобились. **Жодних змін у Rust.**
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

### Знахідка: застарілий layout `UserAccount` ламає повний скан `set_balances_root`

На девнеті 12 `UserAccount` через `getProgramAccounts`; **8 із них — застарілого layout** (110/118
байт до `exit_salt`/`last_withdraw_slot`, тижні 1-2, той самий program id, без міграції). Перший
прогін 07 впав на `InvalidLeafAccount` (0x6035) на весь батч — Rust-десеріалізація коротшого
акаунта не падає чисто, дає сміттєвий `owner`, PDA не збігається. `07` тепер клієнтськи
пре-фільтрує (декодує + звіряє PDA перед включенням у батч, spec risk #19 дозволяє крanky пропускати
юзера) — 8 із 12 пропущено з логом. Реальна міграція — поза скоупом Task 8 (`init_if_needed`
заборонено, міграційної інструкції нема).

### M-B: `06-commitment-reveal.ts` — PASS

Трейдер `FzNNLyJTRzzXXofdQJDxLsKJkaaUcKEZswaXBdqdU5eN` (run `1790053950057`). Перша спроба
close (nonce=1) колізувала (описано вище) — дренована. Друга спроба (nonce=2) — **PASS**: commit
sig `1a6kE9Cu7q7TzUciMepcFgkcSSPySvHk8VXu72kX3ok2i4nAgobzvpzuiiPFWrQQamCRN4GRYtJ57CKXXSQy2Vu`, хеш
збігся, `mark_committed` звільнив позицію (`DisclosureQueue.len==1`), друга позиція відкрита й
закрита (`2QMRQMUSzXy69Yw1WCNC6NcSxHHixL94se6TfUKT9jFb5iYGmbXK9mmbh5ShGtjxj718WzPZBEB9abWPGKEPZsVg` /
`4XK4i1xfTyoDaRRPnxbYY3V7Q6aUAtAenRNkMRhoo7y8Lukv4kdhU7St1GdVZCE4SPiubmu4zvJteg4CgCqiqohw`), reveal
через `commit_aggregate(dq)`
(`pEcCaaVZ7CyU9HdJsS685a5RARVCtNrongwx2UMMk1vQkqnrJLhRzU7j2idP2raxGcRHWyMsWY1JCYCxEk6RE3P`) дав
`Disclosure[2]` з усіма полями == `ClosedRecord`, `owner==default`, хеш перевірено. Таймінги: ER→base
для `Commitment` — **1.1 с**; для `Disclosure` — **3.0 с**. Усі п'ять PASS-рядків брифу підтверджено.
M-C не перевимірювався на реальній формі (дорого); спостережено 1 дію на бандл (write_commitment) і
1 дію (write_disclosure) — ніколи разом у цій задачі; `MAX_ACTIONS_PER_COMMIT` лишається **4**.

### M-E: `07-balances-root.ts` — PASS

Два цикли поспіль: цикл 1 — `filled=4` (з 4 акаунтів сучасного layout), `leaf(owner, free_margin,
exit_salt, root_slot)` знайдено для відомого трейдера (06) на індексі 3, поза паддінгом жодного
збігу. Цикл 2 (одразу після) — **64/64 листків змінились**. **12× `commit_aggregate` (Pool +
BalancesRoot разом)**: escrow ER-баланс `200169040 → 198969040` лампортів, **рівно −100 000 щоразу,
12/12** — це вже перша реальна вимір **платного** тіру (тиждень 2 бачив лише безкоштовний, nonce
<25; ескроу сьогодні давно перетнув поріг 25 через усе тестування задачі). 100 000
лампортів/коміт збігається з `fees-and-commit-economics.md`; чи це за коміт-транзакцію чи за
акаунт — не розрізнено цим вимірюванням (обидва коміти завжди несли Pool+BalancesRoot разом).

### M-A: `08-undelegate.ts` — НЕ ДОЛЕТІВ (зафіксовано чесно, без сліпого патчу)

Закриття другої позиції з 06 (nonce=3, свіжий, хеш збігся), дренаж черги, `withdraw(all=999587254)`
— усе PASS. Передумови `undelegate_user` підтверджено: `Position.state==Empty`,
`DisclosureQueue.len==0`, `free_margin==locked_margin==0`. Сам `undelegate_user` **падав двічі
поспіль з однаковою помилкою**: `{"InstructionError":[0,"ExternalAccountDataModified"]}` (sig 1
`3SsSoNncVmLtZcttwTodkt8yexdxTUFnT4ELSGV4dAaCcFbUs4khumFuT7WGf95e8mtJHiJjWH5jsFLauirHjY6X`, sig 2 —
ідемпотентний рестарт скрипту, той самий результат —
`44RWU8R8v8TsNJ1cH43HxUngNomhVS4KwxpXx8HY3E3nR8cktfH4AFwZiwgBpKS6rmVbBwkh4AxwqPMwGWDd6CKZ`). Base
підтверджено після обох: `UserAccount`/`Position`/`DisclosureQueue` усі **лишились** власності
`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (Delegation Program), не `dexxer_core`. На відміну
від спайкового M-A (тиждень 3, Task 1 — один акаунт, PASS з першої спроби), `undelegate_user`
робить **три** `CloseEphemeralPermissionCpi` (user_account/position/dq) і лише потім **один**
`commit_and_undelegate` над усіма трьома разом — комбінація, яку LiteSVM взагалі не може виконати
(Magic Program там не задеплоєний) і яку спайк перевіряв лише на одному акаунті. **Це перше реальне
виконання трьохакаунтної комбінації на будь-якій мережі.** Гіпотеза (не підтверджена читанням
вихідного коду Delegation/Permission Program) зафіксована в `task-8-report.md`; **не пропатчено
наосліп** — рекомендовано окрему задачу з розслідування.

### Гаунтлет і баланси

`npx tsc --noEmit` чисто в `tests/er`, `scripts`, `app`. Rust не змінювався — autofixer/LiteSVM/
`cargo test`/fmt/clippy/IDL поза скоупом цієї задачі. Фінальні баланси: `payer` 5.228740713 SOL,
`devnet-admin` 0.35488156 SOL, `devnet-fee-payer` 0.25 SOL, `devnet-crank` 0.1 SOL, трейдер 06/08
(`FzNNLyJTRzzXXofdQJDxLsKJkaaUcKEZswaXBdqdU5eN`) 0.027072888 SOL. Витрачено payer'ом за задачу
**≈0.7216 SOL** (5.950356913 → 5.228740713): редеплой 0.521606200 SOL + ~0.2 SOL допоміжних
топ-апів `devnet-admin` (двічі +0.1 SOL, бо ruling-8-пробник і повторні прогони 06/07 з'їли поріг
`requireFunded` 0.3 SOL).

### Файли

- Create: `tests/er/devnet/06-commitment-reveal.ts`, `07-balances-root.ts`, `08-undelegate.ts`.
- Modify: `tests/er/package.json` (`devnet:disclosure|root|undelegate`),
  `tests/er/devnet/03-commit-cycle.ts` (застарілий doc-коментар "лише Pool комітиться" →
  "Pool і BalancesRoot"), цей файл (§Task 8).
- Жодних змін у `programs/` — M-C не перевимірювався на реальній формі, рулінг 8 не зажадав Rust-шляху.

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
