# Тиждень 2 — результати

Приватність (permissioned `[owner, session, crank]` члени, реалізована §2.1/§4.1 спеки), devnet-tee
деплой `dexxer_core` (не спайк), `withdraw`, планувальник + `commit_aggregate` через делегований
`FeeEscrow`, crank на devnet як permission-член, мобільний скелет (TEE-з'єднання, session-стор,
онбординг, Trade/Position). Дев'ять задач (0–8), кожна із власним звітом у
`.superpowers/sdd/2026-09-20-week2-privacy-devnet/task-N-report.md`; цей документ — виміряний
підсумок для контролера й спеки, не заміна тих звітів. Статус мержу — **TBD**, гілка
`week2-privacy-devnet`.

Нижче: Task 1 (вимірювання, що визначили рішення (a)–(d) для решти тижня), Task 5 (devnet-tee
інтеграція + два раунди фіксів), Task 6 (crank на devnet + три fix-раунди), потім короткі підсумки
Tasks 2–4, 7–8 (дизайн/білд-задачі без власних вимірювальних розділів), і насамкінець — список
відкритого для тижня 3.

## Task 1: Вимірювання на devnet-tee (M1–M4)

Усі вимірювання — реальні транзакції на Solana devnet (`https://rpc.magicblock.app/devnet`) і TEE-ролапі
`https://devnet-tee.magicblock.app`, спайковими програмами тижня 0 (не `dexxer_core` — той не деплоївся, це
Task 5). Запуск: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`, потім у `tests/er/`:
`DEXXER_NET=devnet npx tsx devnet/00-measure.ts` (або `npm run devnet:measure`). Скрипт розбитий на 4 незалежні
функції `m1_schedulerSigner`/`m2_memberVisibility`/`m3_commitLimitsAndFeeVault`/`m4_undelegateWithdraw`, кожна
у своєму `try/catch` у `main()` — падіння однієї не зупиняє інші; `MEASURE_ONLY=m1,m2,...` дозволяє перезапускати
підмножину без повторення вже записаних вимірювань.

**Знахідка інфраструктури** (виправлено в `tests/er/devnet/00-measure.ts`, bootstrap-обгортка навколо
`run.ts`): `tests/er/.env` жорстко фіксує локальні адреси mb-stack (`BASE_RPC=http://127.0.0.1:8899` тощо) для
`q1`/`q2`, а `lib/env.ts`'s `cfg()` читає `process.env[key] ?? dotEnv[key] ?? profileDefault` — тобто `.env`
переважає над профілем `devnet` за замовчуванням. `00-measure.ts` виставляє `process.env.BASE_RPC` (і
`ER_RPC`/`ER_WS`/`PUBLIC_RPC`/`ROUTER_RPC`/`ER_VALIDATOR`) на значення профілю `devnet` *до* динамічного
`import("./run.js")` (статичні `import`-и підіймаються над кодом модуля, тому синхронний код перед ними не встиг
би спрацювати) — без зміни `lib/env.ts` чи `.env` (поза скоупом цієї задачі).

### M1 — хто підписує тік планувальника

**Статус: PASS.**

`spikes/05-crank-tee`: оригінальний program id (`Ctj6Hz5RG8cPDgmrDPKGjqKVNdHi7x7hmhKshy5wsNyA`) вже був
закритий (програма деплоїлась і закривалась ще на тижні 0/раніше цієї сесії) — `target/deploy/crank_counter-keypair.json`
видалено, `anchor keys sync` згенерував новий: **`EEkgWoy8krpaxtP8msJeN4rJux2KX68MCHjasosD8CGE`**. `anchor build`
+ `anchor deploy --provider.cluster https://rpc.magicblock.app/devnet --provider.wallet ../keys/payer.json`:
payer 6.183968857 → 4.585399337 SOL (**−1.598569520 SOL**, як і очікувалось ~1.6 SOL).

- `initialize` sig: `3cKtwSGkyvQ2Lickt7M8qWXBZP6evJXgruphNkhFN75cMYZeNTGq25n4p4MnWw8jiP7hCsnSqCeShFufrk4FKHqW`
- `delegate` sig: `2Q9Mu19CSk9qxsx1SRAWK87m1WJzVikbm8uwC93E3RUfMLnUSWoD4qogEDi6gLGTCpAhTiiGorwNQvRc4JRE2BTA`
- `scheduleIncrement` sig: `3psf84xJrfjK2t6GFWNAMBgVM2Vyct8bp6uWzbz6L79RH5HnezVcjZAzuJt5oeU4YwW5gGdEBbcUypnZatNxikDK`
  (`taskId=1789921996797`, `executionIntervalMillis=1000`, `iterations=3`)
- Лічильник `count`: `c0=2` (одразу після schedule — планувальник уже почав) → `3` за 15 с поллінгу (лише 1
  приріст зловлено в реальному часі опитуванням раз/с; за `getSignaturesForAddress` після поллінгу знайдено
  **3** нових підписи — всі 3 заплановані тіки таки відпрацювали, просто з лагом індексації відносно клієнтського
  опитування).

**Підписант тіка.** `getSignaturesForAddress(programId)` через **токен payer-а** (не PDA — тижня-0 знахідка
Check 6 підтвердилась знову: пошук за PDA повертає `[]` навіть власнику; за program id — працює):
3 кандидати, для кожного `getTransaction` + `header.numRequiredSignatures` + `accountKeys[0..numRequiredSignatures)`:

| tick sig (скорочено) | numRequiredSignatures | підписант |
|---|---|---|
| `3xzaYauC...D9Yf` | 1 | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| `NuzvVcbw...vyDd7R` | 1 | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| `2pY47rxW...g3jYmSr` | 1 | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |

`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` = `ER_VALIDATOR` (devnet-tee, з `tests/er/lib/env.ts`) —
**сама ідентичність TEE-валідатора**, підписант — не PDA. Обчислена `CRANK_SIGNER` PDA
(`["crank-executor"]` під `CRANK_PROGRAM_ID = Crank11111111111111111111111111111111111111`) =
`431bz9ziJVBCqea1gSxzmxvm1Bn1qJoZzSNHoweNc1f1` — **жоден тік не підписаний нею**.

**Рішення (a): `Config.scheduler_signer` = адреса TEE-валідатора (`ER_VALIDATOR`), не `CRANK_SIGNER` PDA.**
На devnet-tee це `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` — значення з `tests/er/lib/env.ts`'s `ER_VALIDATOR`
для профілю `devnet`, а не глобальна SDK-константа. `crank_tick`'s signer-constraint (CLAUDE.md: приймає
`Config.crank` або `CRANK_SIGNER`) має додатково приймати `Config.scheduler_signer == ER_VALIDATOR`, інакше
запланований тік ніколи не пройде перевірку підписанта.

Прибирання: `solana program close EEkgWoy8krpaxtP8msJeN4rJux2KX68MCHjasosD8CGE -u devnet --bypass-warning` —
**1.5961614 SOL повернено** payer-у.

### Task-context (додаткове вимірювання, продовжує M1)

Рядок 1 внутрішньої CPI-інструкції `ScheduleTask` (з `meta.innerInstructions` транзакції `scheduleIncrement`,
розкодовано через `accountKeys`/`programIdIndex`/`accounts`-індекси):

```
inner ScheduleTask accounts: [payer, payer (дубль), counterPDA]
                               ^index0  ^index1        ^index2
```

Клієнт спайку 05 (`spikes/05-crank-tee/programs/crank-counter/src/lib.rs`, незмінено — лише `anchor keys sync`)
передає `instruction_accounts: &[payer.to_account_info(), counter.to_account_info()]` у `ScheduleCrankCpi`, яка
сама попереду додає `payer` (index0) — тому index1 фактично **дублює payer**, а не окремий task-context PDA.
Перевірено на ER: `getAccountInfo(payer)` через токен payer-а — `owner = 11111111111111111111111111111 (SystemProgram)`,
`dataLen = 0` — це звичайний гаманець, **не** щось, що валідатор записав як task-context-стан.

Ticks усе одно відпрацювали (3/3 зрештою). Це підтверджує знахідку контролера з Task 4
(`programs/dexxer_core/src/instructions/crank.rs`, коміт `31f2a5f`): жодна з `ephemeral-rollups-sdk` 0.16.2 чи
`magicblock-magic-program-api` 0.10.1 не експортує PDA-деривацію для task-context, а сам SDK-хелпер
(`ScheduleCrankCpi`) не вимагає й не перевіряє його змістовно — **на практиці підходить будь-який акаунт на
позиції index1** (спайк передає дублікат payer-а й це не заважає плануванню/виконанню). Це не заперечує
`dexxer_core`'s `ScheduleCrank.task_context` (лишений як `UncheckedAccount`, per-doc-comment "0=payer,
1=task_context, 2..=accounts included in the task") — радше підтверджує, що поки що можна передавати
**будь-який валідний, узгоджений акаунт** (наприклад `config` чи `crank`) на цій позиції без ризику зламати
`schedule_crank`; справжня семантика `CancelCrankCpi`'s окремого `task_context`-поля (яке *приймає* власний
параметр, на відміну від `ScheduleCrankCpi`) лишається невиміряною — `cancel_crank` не викликався в цій сесії.

### M2 — видимість приватного акаунта для членів

**Статус: PASS** (після виправлення в спайку — див. нижче).

`spikes/01-private-counter-tee`, id `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7` (без зміни — `anchor keys
sync` не запускався, `solana program deploy --program-id ... --upgrade-authority ...` оновив байткод на місці).

**Зміни в програмі** (`programs/private-counter/src/lib.rs`):
- `set_privacy(ctx, is_private: bool, crank: Pubkey)` — додано параметр `crank`; якщо `!= Pubkey::default()`,
  members = `[owner, crank]` (замість лише `[owner]` у тижні 0).
- `initialize`: rent-фандинг рахунку `counter` змінено з `EphemeralPermission::size_of(1)` на `size_of(2)`
  (знахідка нижче).

**Три реальні знахідки по дорозі** (усі записані в коментарях коду й тут):
1. Перша спроба `setPrivacy(true, crank)` на вже-ініціалізованому лічильнику тижня 0 (`user`, sized для 1
   учасника) впала: `transaction verification error: Transaction results in an account (2) with insufficient
   funds for rent` — ріст із 1 до 2 членів ресайзить `EphemeralPermission` (101 → 134 байти), і його власний
   баланс має покривати **повний** rent-exempt мінімум нового розміру (`solana rent 134` → `0.00133096 SOL`
   на devnet), не лише дельту ресайзу.
2. Спроба профінансувати `permission` прямим `SystemProgram.transfer` (з `user`, реального гаманця з SOL) на
   ER — впала на симуляції: `"This account may not be used to pay transaction fees"` /
   `InvalidAccountForFee`, з логом `"Feepayer <user> was modified without being delegated"` — на цьому TEE ER
   не можна модифікувати баланс **не делегованого** fee-payer'а нічим, окрім стандартного списання комісії.
3. Спроба провести той самий transfer через власну CPI-інструкцію програми (`fund_permission`, тимчасово
   додана й пізніше видалена) з `authority` (=`user`) як джерелом — та сама помилка (2). Спроба з `counter`
   (делегований PDA) як джерелом через `SystemProgram::transfer` CPI — впала з `"Transfer: from must not carry
   data"`: системна інструкція `transfer` вимагає нульових даних у джерела, а `counter` — живий 48-байтний
   Anchor-акаунт.

**Виправлення (застосоване, мінімальне):** замість ресайзити недофінансований лічильник тижня 0, `initialize`
тепер одразу фінансує на `size_of(2)`; M2 використовує **свіжу** ідентичність (`spikes/keys/m2owner.json`,
gitignored, профінансована з `payer` на 0.01 SOL), чий `counter` `initialize`-иться заново проти оновленої
програми — без жодного ресайзу чи ручної маніпуляції лампортами. (`fund_permission`-інструкцію, введену під
час діагностики, видалено — вона більше не потрібна.)

**Результат — таблиця 3×3** (`owner`=`m2owner`, `crank`=свіжий ефемерний keypair, `stranger`=`spikes/keys/stranger.json`;
`getAccountInfo`/`getProgramAccounts` — прямий виклик; `getProgramAccounts` — з memcmp-фільтром за
8-байтним Anchor-дискримінатором акаунта `Counter`; `onAccountChange` — підписка всіх трьох одночасно, тригер
— один `increment` від owner, вікно ~60 с):

| identity | `getAccountInfo` | `getProgramAccounts` знаходить | `onAccountChange` спрацював |
|---|---|---|---|
| owner | true (48 B) | true (1/1 акаунт) | true |
| crank | true (48 B) | true (1/1 акаунт) | true |
| stranger | **false** (0 B) | **false** (0/0) | **false** |

Ключові підписи: `setPrivacy(true,[owner,crank])` —
`2tAkoJ17xkG53qPwq3DY1GrJnEFL4YRqv2zVNHBME1RVUnazbV5JTKJoqZiExFdUfSXYqTkn7fvuHa2couwXSHFL`; `initialize` —
`43F5w1g2Gfogeth2gA7jRSk9F4kcNqnNz77TkU7KkZeYd3VaaQRv4iHWyX2o5ke2Hv5XrboYVGixLy3XSXzEXf3a`; `delegate` —
`5bTF8vMZ2fKXV1dtpv2h9QCiShayFApshYQkPwFtch6weqzPrESsFCdne1zrnrGpkKYsoP1iT8T3J8yepCRVwLT8`; `init_permission` —
`3CE2XPRNSksrfM1ynA3FEmhtj3DjujfPVFtwiksb1i4QPtMnHRRR4RFhEkUAFnUgiCDK4FuTG9XE6FFsQgiPLiTm`. `counterPDA` =
`FTW3sqx4WeG48nr4gycVcxU7gxmf53qwEGjvCJFj617B`.

**Рішення (b): `getProgramAccounts` із токеном `crank`-члена ПРАЦЮЄ й повертає приватний акаунт.** Отже
джерело кандидатів ліквідації для `crank-fallback` — **gPA із crank-токеном**, `MarketRisk.traders`-реєстр
(план §147: «лише якщо M2 показав, що gPA не працює») **не потрібен**.

### M3 — ліміт plain-комітів і fee-vault

**Статус: M3a PASS, M3b PASS** (обидва підтверджені реальними транзакціями, у двох окремих прогонах —
див. нижче).

**M3a (той самий лічильник `user`, тижня-0 ідентичність, id `2DvXCXzp56aFw8JsHrMuiRwZWizZjxwaqzYo2ADKH2W7`):**
11 × `commit()` (без fee-vault). 10 успішних, 11-й впав з точним кодом з брифу:

```
transaction verification error: Error processing Instruction 0: custom program error: 0xa0000000
```

Підписи (перші/останній успішні): #1 `5BEjV8CxSjiw4CtJYFGQ1T9ds3SSSx7Dq7bLze2Jeky8zYwWCYHTUbCrgkxZFLLhvhTt6B1ogazWuTbfqkfpQVYF`
… #10 `2vgBwXTFd2mfG1W5uqscUDP9wANg6n9vraN25NDrpxAgWZQSJ3pvSC3icRpMEZ1m5smzHE3fUdmwTBE1t3yWrKv7`. Ліміт —
`10` успішних plain-комітів на акаунт, **постійний** (не per-часове вікно): повторний прогін тим самим
лічильником (інша сесія скрипту, хвилини по тому) впав одразу на #1 з тим самим `0xa0000000` — квота не
відновлюється часом, лише інша стратегія (fee-vault) розблоковує подальші коміти.

**M3b — fee-vault.** `magic_fee_vault` (validator-scoped, `magicFeeVaultPdaFromValidator(ER_VALIDATOR)`, TS
SDK 0.17.0 хелпер, seeds `["magic-fee-vault", validator]` під `DELEGATION_PROGRAM_ID`) =
**`EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b`** (базовий шар: власник `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`,
баланс 8 393 814 560 lamports (**8.39 SOL**), 8 байт даних).

Перша спроба провалилась (0xa0000000, як і plain-коміт): `payer` (реальний гаманець) як CPI-`payer`, навіть
після `lamportsDelegatedTransferIx(payer, payer, …)` — та інструкція делегує похідний **"lamports PDA"**
відносно `(payer, destination, salt)`, а не сам `payer.publicKey`; гаманець лишається недельогованим, тому та
сама заборона з M2 ("не можна модифікувати баланс недельогованого fee-payer'а поза стандартною комісією")
блокує й тут.

**Реальне виправлення:** `commit_with_vault` (спайкова інструкція) переписана так, щоб CPI-`payer` для
`MagicIntentBundleBuilder` був **`counter`** (програмний PDA, уже делегований — точно як у `set_privacy`), а
не зовнішній гаманець; підписує через `invoke_signed` з тими самими seeds, що й `set_privacy`/`close_permission`.
Зовнішній гаманець (`payer`) лишається підписантом *транзакції* (платить звичайну комісію — це дозволено, бо
не є "модифікацією поза комісією"). Перший виклик після цієї зміни — **успіх з першої спроби**.

Перший прогін 30 запланованих комітів через `commit_with_vault`: **14/30 успішних**, далі —
`Transaction results in an account (2) with insufficient funds for rent`. Підписи: #1
`2bgcGLU2QiU1xqfx7Dh3gxqhxgDyhWLWbiGiz3iEvXp4z9vWdaziKB9Yafz9T5cPSQTrrWjMtusa92jKMD4a6dri`, #2
`5V6XWEiy5bbjY5wF2ucx35wuYQZUZonJHCuUaDdXrFXS1ZbBJKL3Zv89YqW4Ye5WsyxxZs6i1nZF2Wc91Vh1am47`, #3
`3dxR2i7NwXV5k853zErx5bEXKVSckF1WtyBaTGZG6ds551t5yiRdbU69NqkKAJpEV99AKgNy5jea8cG7hKjQEfVZ`, #10
`3AcBefiVkenkoyWw1qZaK1fXJWq8KqxwEjfNH9QF5ADRPzmGYzrfmXe2rKjhBRtU7im8heNHYVfPv1DF9Y2yCip1`, #15 — перша
невдала.

**Виправлення round 1 (контроль): атрибуція "account 2" та реальні баланси.** Перший прогін читав баланс
`counter` через **токен `payer`-а** — а `payer` НЕ є членом приватного `user`-лічильника (той самий
privacy-режим, що й M2), тож `getBalance(counter)` через недозволений токен мовчки повертає `0`, а не реальне
число (та сама null-vs-hidden двозначність, що й `getAccountInfo` у M2). Записані тоді "counter ER balance
before/after: 0" — **артефакт читання чужим токеном, не реальний баланс**; попередня оцінка "~63 863
лампортів/коміт" з них — **відкликається**.

Виправлено (`tests/er/devnet/run.ts`): баланс `counter` тепер читається через **токен `user`-а** (реального
члена), а після зупинки циклу скрипт **пересимульовує** останню (невдалу) спробу `commit_with_vault` і виводить
`sim.value.err` разом зі скомпільованим `accountKeys`, щоб напряму зчитати, який індекс і яка адреса
провалились — а не покладатися на порядок акаунтів у IDL (legacy `Transaction.compileMessage()` **не зберігає**
порядок оголошення; для акаунтів однакового тиру (writable, не-signer) він сортує їх **алфавітно за base58**,
тому порядок у транзакції — не порядок у `#[derive(Accounts)]`).

Повторний (контрольний) прогін лише fee-vault-частини M3 (лічильник `user` уже вичерпаний з першого прогону,
тож усі 30 спроб зазнають невдачі одразу — це саме дало чисте `before`/`after` без жодного успішного коміту
між ними):

```
payer ER balance before: 6116666457   after: 6116666457   (delta: 0)
counter ER balance before (via member token): 894080   after: 894080   (delta: 0)
feeVault balance before: 8393814560   after: 8393814560   (delta: 0)
failing account: index 2 = GUrqtjuVRoRYxfeDWpwTNn5xb9vSSBWTZ7KpMfMUdzuJ  (= counterPDA)
```

**Підтверджено напряму: акаунт, що провалюється — `counter` (index 2 у реально скомпільованій, а не
IDL-задекларованій транзакції), не `magic_fee_vault`.** `magic_fee_vault` сам лишається незмінним і далеким
від вичерпання (8.39 SOL) в обох прогонах. `counter`'s баланс — рівно `894 080` лампортів **до і після**
контрольного прогону, що дорівнює точно rent-exempt мінімуму для його власного 48-байтного розміру
(`solana rent 48` → `0.00089408 SOL` = `894 080` лампортів, звірено) — тобто `counter` сидить точно на межі
власної rent-exemption, без жодного запасу.

**Що НЕ підтверджено (чесно позначено як невідоме):** `counter`'s баланс не змінився між "14 успішних" першого
прогону і "0 успішних" контрольного — тобто гіпотеза "fee-vault-коміт буквально списує лампорти з `counter`
за раз" **не узгоджується** з даними (якби списував, перший прогін мав би скінчити нижче `894 080`, а не
рівно на ньому). Найправдоподібніше пояснення — окрема, дискретна квота на fee-vault-коміти (аналогічна
10-коміт ліміту M3a), а не пряме вичерпання лампортів `counter`; повідомлення `InsufficientFundsForRent`,
імовірно, — побічний ефект внутрішнього realloc/scratch-простору, зав'язаного на `counter`, а не пряме
списання видимого балансу. Попередня оцінка "~63 863 лампортів/коміт" та її екстраполяція на "$/добу"
**відкликаються повністю** — недостатньо даних, щоб порахувати реальну вартість коміту. Точна економічна
модель (скільки коштує коміт після N-го, чи це взагалі лампорт-based механізм) лишається **повністю відкритим
питанням для Task 2**, яке варто перевимірювати безпосередньо на `dexxer_core`'s `Pool`/`Config.fee_payer`
(з чистого, щойно профінансованого акаунта, щоб відрізнити "квота за кількістю" від "вичерпання балансу").

### M4 — `undelegateIx` + `withdrawSpl` для eSPL

**Статус: PASS** (сегментований час — виправлення round 1, деталі нижче).

Mint спайку 02: `44FTm7zsYePyuBzLmQDjxk53eioxqzkdEW28FEPnSNBk` (6 decimals, mint authority = `payer`).

**Виправлення round 1 — таймер і повторний цикл.** Перший прогін мав дві проблеми: (1) таймер `t0` стартував
**після** підтвердження `undelegateIx` і всього поллінгу базового ATA, тож заявлені "546 мс" насправді міряли
лише останній крок (`withdrawSpl`), не заявлену послідовність undelegate→poll→withdraw; (2) власник
`spikes/keys/session.json` уже пройшов один повний цикл depositundelegatewithdraw раніше в цій сесії —
повторний цикл на тому ж (owner, mint) впав на `withdrawSpl`:
`require!(ephemeral_ata_info.owned_by(&crate::ID)) failed, token_vault.rs:102` (`InvalidAccountOwner`) —
ефемерна-ATA бухгалтерія eSPL, схоже, небезпечно перециклювати без повторного створення для того самого
власника. Виправлено: (a) таймер тепер розбитий на три сегменти (`undelegate`, `poll`, `withdraw`) з міткою
від старту `undelegateIx`-надсилання; (b) вимірювання відтепер завжди використовує **свіжу** persistent-
ідентичність (`spikes/keys/m4owner.json`, gitignored, профінансована 0.01 SOL з `payer`), яка ще не проходила
цикл для цього mint-у.

Чистий повторний прогін (`m4owner`, mint той самий):

1. `createAssociatedTokenAccountIdempotent` + `mintTo` 1000 базових одиниць на базовий ATA `m4owner`.
2. `delegateSpl(m4owner, mint, 10n, { validator: ER_VALIDATOR, payer, initVaultIfMissing: false, idempotent:
   false })` — sig `2oiwBytK2BLZxXJTj1zPzvXXp3bVUnDJR7rR5eMiZejn4XnBKpR9WoHm5dfwkUisEH9fTqgQuQ9CLJRZ957t6gbd`.
   Поллінг ER-балансу підтвердив `10n`.
3. `undelegateIx(m4owner, mint)` на ER — sig
   `5c82sv3sbd2GqhQMDAQpc5Kdx2svLDr59rUGLeKAqXaaVDpYoMYTbtS5RqnKMKNL7Hzs3M93P9UWXEk2vwLYd6uQ` — **надіслано →
   підтверджено: 2062 мс**.
4. Поллінг базового ATA до `owner == TOKEN_PROGRAM_ID` — підтверджено (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
   — **176 мс**.
5. `withdrawSpl(m4owner, mint, 10n, { idempotent: false })` на базовому шарі — sig
   `2xhZQYEP8xZccUU8oPg5iFJinFU8Q6bmfEkdnAUdr6B53nas4EKtjCgDbZXUNRBd2REdXmYkj9XqHYrfUMJDL25X` — **559 мс**.
   Фінальний базовий баланс: `1000` базових одиниць (весь депозит повернувся через commit-then-withdraw
   цикл).

**Реальний сегментований час (undelegate-надсилання → withdraw-підтвердження): undelegate=2062 мс,
poll=176 мс, withdraw=559 мс, total=2797 мс.** Раніше заявлені "546 мс" були лише третім сегментом
(`withdrawSpl`), не всією послідовністю — виправлено в усіх місцях, де це число фігурувало.

### Рішення після M1–M4

**(a) `Config.scheduler_signer` = `ER_VALIDATOR`** (devnet-tee: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`) —
**не** `CRANK_SIGNER`-константа. `crank_tick`'s signer-перевірка має явно приймати цю адресу.

**(b) Джерело кандидатів ліквідації — `getProgramAccounts` із crank-токеном.** M2 підтвердив: gPA з
memcmp-фільтром за дискримінатором акаунта повертає приватні акаунти, членом яких є crank. Реєстр
`MarketRisk.traders: [Pubkey; 32]` (план §147) **не додавати**.

**(c) `magic_fee_vault` (devnet-tee) = `EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b`.** Адреса й доступність
підтверджені (8.39 SOL, стабільно). Вартість 5-хвилинних комітів `Pool` на добу — **не визначена в цій сесії,
свідомо не оцінюється числом**. Підтверджено напряму (виправлення round 1, контрольний прогін з реальними
балансами через токен члена): (1) без fee-vault — 10 plain-комітів на акаунт, постійний ліміт; (2) з
fee-vault, коли CPI-payer — делегований PDA (`counter`, не звичайний гаманець), перший прогін дав 14/30
успішних, а контрольний повторний прогін (той самий вичерпаний `counter`) — 0/30, при цьому `counter`'s
власний баланс лишився рівно `894 080` лампортів (= його власний rent-exempt мінімум для 48 байт) **однаково
до і після обох прогонів** — тобто гіпотеза "коміт списує лампорти з `counter`" не узгоджується з
вимірюваннями; `magic_fee_vault` теж лишився незмінним в обох прогонах. Попередня оцінка "~63 863
лампорти/коміт" і похідна "~0.018 SOL/добу" **відкликані** — недостатньо даних для формули. Ймовірніше
пояснення — дискретна квота на fee-vault-коміти, а не лампорт-based вичерпання; **повністю відкрите питання
для Task 2**, перевимірювати на `Config.fee_payer`/`Pool` з чистого акаунта.

**(d) Послідовність withdraw для клієнта:** `undelegateIx(owner, mint)` на ER → поллінг базового ATA до
`owner == TOKEN_PROGRAM_ID` → `withdrawSpl(owner, mint, amount, { idempotent: false })` на базовому шарі.
**Реальний сегментований час** (виправлення round 1 — попередній прогін мав таймер, що стартував запізно і
міряв лише останній крок): `undelegateIx` надіслано→підтверджено **2062 мс**, поллінг базового ATA **176 мс**,
`withdrawSpl` **559 мс**, **сумарно (undelegate-надсилання → withdraw-підтвердження): 2797 мс**.

### Task-context (підсумок для Task 5/6)

Немає деривації, яку можна порахувати офчейн — жодна з наявних крейт-версій (`ephemeral-rollups-sdk` 0.16.2,
`magicblock-magic-program-api` 0.10.1) не публікує PDA-схему для task-context. Емпірично: `ScheduleTask`
приймає **будь-який узгоджений акаунт** на позиції index1 (спайк 05 передав дублікат payer-а — планування й
виконання відпрацювали без нарікань). Для `schedule_crank`/`cancel_crank` у `dexxer_core` (Task 4, коміт
`31f2a5f`) це означає: поточний підхід (передати якийсь конкретний, детермінований акаунт — наприклад `config`
чи `crank`) має шанс просто працювати для `ScheduleTask`, але **`CancelCrankCpi`'s окремий `task_context`-
параметр не тестувався** в цій сесії (жодного `cancel_crank`-виклику) — залишається відкритим для Task 6.

### Баланс `payer` (весь Task 1, включно з виправленнями round 1)

| момент | баланс (SOL) |
|---|---|
| на старті задачі | 6.183968857 |
| після деплою спайку 05 | 4.585399337 |
| … (проміжні M2/M3-виправлення, апгрейди спайку 01 — дешеві, без суттєвих змін) | ~4.52–4.58 |
| після `solana program close` спайку 05 (+1.5961614 SOL) | 6.116666457 |
| після виправлень round 1 (M3 контрольний прогін, M4 фандинг `m4owner` + 2 перезапуски) | 6.101378217 |
| **підсумкова дельта за весь Task 1 разом із round 1** | **−0.082591 SOL** |

Інші ідентичності (кінцеві баланси devnet): `user` 0.776232216 SOL, `stranger` 0.099985 SOL, `session`
0.004975 SOL, `m2owner` (для M2) 0.006793552 SOL, `m4owner` (для M4, round-1 виправлення) 0.009985 SOL.

### Файли

- Create: `tests/er/devnet/00-measure.ts` (bootstrap, форсує `devnet`-профіль перед `../lib/env.js`),
  `tests/er/devnet/run.ts` (M1–M4, кожна своя функція + `record()`).
- Modify: `tests/er/package.json` (`devnet:measure` скрипт), `spikes/05-crank-tee/Anchor.toml` +
  `programs/crank-counter/src/lib.rs` (`anchor keys sync` → новий id, програма закрита в кінці),
  `spikes/01-private-counter-tee/programs/private-counter/src/lib.rs` (`set_privacy` приймає `crank: Pubkey`,
  `initialize` фінансує `size_of(2)`, нова `commit_with_vault`/`CommitWithVault`).
- Нові gitignored ключі: `spikes/keys/m2owner.json` (свіжа ідентичність для M2), `spikes/keys/m4owner.json`
  (свіжа ідентичність для M4, round-1 виправлення — уникає повторного циклу на `session`), обидві профінансовані
  з `payer`.

`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` → `cd tests/er && npx tsc --noEmit` — чисто (0
помилок) на фінальній версії `run.ts`/`00-measure.ts`.

## Task 2: Приватні permission і члени

Реалізує §2.1/§4.1's приватну 3-членну `EphemeralPermission`, відкладену з тижня 1. Новий
`state/permissions.rs`: `OWNER_FLAGS`/`VIEWER_FLAGS`-константи, `build_members(owner, session,
crank) -> Vec<Member>` — owner завжди перший з `OWNER_FLAGS` (`AUTHORITY_FLAG | TX_LOGS_FLAG |
TX_BALANCES_FLAG | TX_MESSAGE_FLAG | ACCOUNT_SIGNATURES_FLAG`), session — лише якщо `!=
Pubkey::default()`, crank — завжди останній з `VIEWER_FLAGS`.

`init_permissions` тепер `is_private: true`, `members: build_members(...)`; гілкується на
`perm.owner == PERMISSION_PROGRAM_ID` — `UpdateEphemeralPermissionCpi` (перемикає тиждень-1
публічний permission на приватний) замість `CreateEphemeralPermissionCpi`. `set_session` після
запису `session_key`/`session_expiry`/`actions_left` перебудовує всі три permission через
`UpdateEphemeralPermissionCpi` (PDA сама підписує `invoke_signed` своїми seeds), пропускається
per-PDA, якщо permission ще не створено.

`Config` отримав чотири нові поля цього тижня одразу: `scheduler_signer`, `fee_payer`,
`magic_fee_vault: Pubkey`, `crank_task_id: i64` — записані, але не прочитані жодною інструкцією на
цьому кроці (наступні задачі їх споживають). `scheduler_signer` ініціалізується плоским
`CRANK_SIGNER`-плейсхолдером (Task 1/6 пізніше знайшли правильне значення — per-authority PDA,
записується окремо).

**Знахідка (не в брифі):** додавання `config`/`market`/повного набору permission-акаунтів до
`InitPermissions`/`SetSession` переповнило SBF stack frame (520/552 байт понад 4096, за
діагностикою `anchor build`'s stack-offset). Виправлено бокс'уванням `config`/`market`/`user_account`
в обох контекстах (та сама техніка, що вже застосована для `position`/`disclosure_queue`).

**Гаунтлет:** `cargo test -p dexxer_core` **46/46** (42+4 нових `permissions::tests::*`); `anchor
build` чисто; `cargo +nightly-2026-09-18 test -p dexxer_litesvm` **32/32**; `program_autofixer` — 0
issues на кожному зміненому файлі; `tsc --noEmit` чисто в `tests/er` і `scripts`.

**Свідомо не додано:** `MarketRisk.traders` (рулінг — реєстр потрібен лише якщо Task 1's M2 покаже,
що gPA не працює для приватних акаунтів; M2 пізніше підтвердив, що працює, §3.5).

Комміт: `4173667` — `feat(core): private permissions with owner/session/crank members; set_session
rebuilds members`. Повний звіт — `task-2-report.md`.

## Task 3: `withdraw` (ER-нога) + LiteSVM

Перша версія `withdraw` — дзеркало `credit_deposit` у зворотний бік: owner-only signer (не session —
гроші покидають систему), `require!(amount > 0)`, `require!(free_margin >= amount)`,
`free_margin -= amount`/`pool.capital_total -= amount` (`checked_sub`), SPL-transfer vault→owner
(підписано пулом), потім commit-intent лише для `user_account`, ворота на
`magic_program.to_account_info().executable` (на LiteSVM Magic-програма не задеплоєна — CPI
пропускається; на реальному ER — виконується).

`magic_context`/`magic_program` — `UncheckedAccount` з `address = ...`-констрейнтом, не
`Program<'info, MagicProgram>` (та обгортка провалила б валідацію акаунта на LiteSVM ще до власного
`.executable`-гейту в тілі).

Чотири LiteSVM-тести (`tests/litesvm/tests/withdraw.rs`): нуль відхилено, більше вільного
відхилено, кошти рухаються + `free_margin` дебетується + інваріант тримається, сесія відхилена.
**Знахідка тесту 3:** сесія як `owner`-підписант падає не на власному `DexxerError::Unauthorized`
(`6019`), а на Anchor-вбудованому `ConstraintSeeds` (`2006`) — `user_account`'s seeds
перевираховуються з (хибного) сесійного ключа ще до того, як `has_one = owner` у тілі встигає
спрацювати; тест асертує саме `2006`, з коментарем-поясненням.

**Гаунтлет:** `anchor build` чисто; LiteSVM **36/36** (32+4 нових); `cargo test -p dexxer_core`
**46/46**; `program_autofixer` чисто. TS `tsc --noEmit` **не запускався** в межах цієї задачі —
у сесії не було Node на `PATH`; позначено як ризик, перевірено пізніми задачами.

`Config.magic_fee_vault` цей крок навмисно **не** підключив до `withdraw`'s builder (поза скоупом
брифу) — це виявилось потрібним пізніше, у Task 5's fix round 3 (валідатор вимагає vault-акаунт у
CPI щоразу, коли payer делегований, незалежно від ліміту комітів).

Повний звіт — `task-3-report.md`.

## Task 4: Планувальник і `commit_aggregate`

`crank_tick`'s signer-констрейнт розширено третьою гілкою (`config.scheduler_signer`, поряд з
`config.crank` і плоским `CRANK_SIGNER`). Нові інструкції: `schedule_crank`/`cancel_crank`
(`ScheduleCrankCpi`/`CancelCrankCpi`, admin-gated, ER-only) і `commit_aggregate`/`commit_market`
(новий `instructions/commit.rs`) — `commit_aggregate` комітить лише `Pool`, CPI-payer спершу
`ctx.accounts.payer` (constrained `config.fee_payer`), `.magic_fee_vault(config.magic_fee_vault)`
активує fee-vault-шлях; `commit_market` — той самий шаблон, admin-gated, без vault.

**Lifetime-знахідка (SDK 0.16.2, не спекуляція — перевірено компіляцією):**
`ScheduleCrankCpi`/`CancelCrankCpi`'s `compat::AccountInfo<'a>` — інваріантний у `'a`; свіжозібраний
локальний масив `.to_account_info()`-клонів (як робить спайк `05-crank-tee` на іншій версії SDK) **не
компілюється** проти 0.16.2 (`E0716: temporary value dropped while borrowed`). Обхід: Anchor's
`ctx.remaining_accounts` — genuinely `'info`-scoped слайс — `schedule_crank` вимагає клієнта
передати ті самі акаунти вдруге через `remainingAccounts`, звірені проти named-полів перед
довірою. `MagicIntentBundleBuilder::commit(&[...])` цієї проблеми не має (одноелементні масиви).

**`task_context`-акаунт:** жодна версія SDK (0.16.2)/`magicblock-magic-program-api` (0.10.1) не
експортує PDA-деривацію для нього — `UncheckedAccount`, клієнт передає. Лишилось невирішеним аж до
Task 6's fix round 1 (знайдено — потрібен writable, першим у `instruction_accounts`).

**`magic_fee_vault_pda_from_validator`** — реальна, експортована деривація
(`ephemeral_rollups_sdk::pda::magic_fee_vault_pda_from_validator(validator)`), контрастує з брифовим
припущенням "можливо не існує"; не використана тут (рулінг), використана пізніше в devnet
bootstrap.

**Гаунтлет:** `anchor build` чисто; LiteSVM **36/36** (нові інструкції ER-only, не покриті
LiteSVM); `cargo test -p dexxer_core` **46/46**; `program_autofixer` чисто на всіх змінених
файлах; `tsc --noEmit` чисто в `tests/er` і `scripts` (IDL +4 інструкції).

**Fix round 1 (контроль-ревʼю, Critical):** `schedule_crank` спершу не передавав writable
`task_context` першим елементом `instruction_accounts` — `magicblock-magic-program-api`'s власний
doc-коментар і SDK's unit-тест документують порядок `[task_context, ...]`. Виправлено: додано
`task_context: UncheckedAccount` (мут) до `ScheduleCrank`, `remaining_accounts.len() == 7` тепер
(`task_context` першим), звірка ідентичності перед передачею. Гаунтлет після фіксу — той самий,
чистий (LiteSVM 36/36, `dexxer_core` 46/46, autofixer 0 issues, tsc чисто).

Повний звіт (SDK-деталі, lifetime-аналіз) — `task-4-report.md`.

## Task 5: Devnet-tee інтеграція — приватний онбординг, витік-тест рівня 4, цикл комітів, withdraw

Повний прогін `dexxer_core` (не спайку) на реальному devnet + `devnet-tee.magicblock.app`: program id
`G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV` (незмінений, keypair з `keys/programs/`). Запуск:
`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`, потім у `tests/er/`: `npm run devnet:onboard`,
`npm run devnet:leak`, `npm run devnet:commit`, `npm run devnet:withdraw` (кожен — `DEXXER_NET=devnet tsx
devnet/0N-*.ts`).

### Крок 0.1 — `init_config` бере `scheduler_signer` (M1)

Комітом `8592133`. `admin::init_config` тепер приймає параметр `scheduler_signer: Pubkey` і пише його напряму
в `Config.scheduler_signer` замість жорсткого `CRANK_SIGNER`-конвертування; `crank_tick`'s constraint у
`crank.rs` не чіпався (третя гілка з SDK-константою лишилась як fallback). `tests/litesvm/src/{ixs,setup}.rs`
оновлені (`setup.rs` передає `crank.pubkey()`), `tests/er/lib/admin.ts`'s `bootstrap()`/`bootstrapDevnet()`
передають `ER_VALIDATOR` (профільно: локальний mb-stack валідатор / `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
на devnet) і `bootstrapDevnet()` додатково передає `magic_fee_vault = EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b`
(M3) замість `PublicKey.default()`. Гаунтлет: `anchor build` чисто, `cargo +nightly-2026-09-18 test -p
dexxer_litesvm` — **36/36**, `cargo test -p dexxer_core` — **46/46**, `program_autofixer` на `admin.rs` —
0 issues.

### Крок 0.2 — деплой на devnet

Перша спроба (`anchor deploy --provider.cluster devnet --provider.wallet spikes/keys/payer.json
--program-name dexxer_core`, кластер `api.devnet.solana.com`) впала: `Error: Data writes to account failed:
Custom error: Max retries exceeded` — payer втратив 4.6 SOL у buffer-акаунт
(`EsmHVuDdT5w5vARrZxzSR4jy5z9yxSBv8ta5LsVmbVZB`). `solana program close EsmHVu...` повернув усі 4.6 SOL
(без `--buffers`-флага — той приймає лише "закрити всі", без явної адреси). Друга спроба напряму через
`solana program deploy target/deploy/dexxer_core.so --program-id target/deploy/dexxer_core-keypair.json
--keypair spikes/keys/payer.json --url https://rpc.magicblock.app/devnet --use-rpc` — **успіх з першої
спроби**, sig `495VsmTunPbod9ke84RLK1t1swFYKA61UJrQqNSgNHc5hzWMXXmBnEqXMXnsXn4LSWJjgiQR83pds43QgxrPSRBu`.

`solana program show G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV -u devnet`: `Owner:
BPFLoaderUpgradeab1e1...`, `Authority: 4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM` (payer), `Data Length:
906632 bytes`, `Balance: 4.6065694 SOL`.

**Знахідка:** реальна вартість деплою — **≈4.61 SOL** (payer 6.101968857 → 1.489365697 SOL до фандингу
admin), суттєво вище брифової оцінки "~1.7 SOL" — сучасні devnet rent-ставки для program-data акаунта цього
розміру (~886 KB) + сам факт, що перша (провалена) спроба тимчасово заморозила 4.6 SOL у buffer, поки не
закрита вручну.

### Крок 0.3 — bootstrap

`scripts/admin/devnet-bootstrap.ts`/`fund-fee-payer.ts` мали ту саму інфраструктурну проблему, що й
`00-measure.ts` документував для себе: `tests/er/.env` жорстко фіксує `BASE_RPC=http://127.0.0.1:8899` для
локального mb-stack, і `lib/env.ts`'s `cfg()` читає `.env` **поверх** профілю `devnet` за замовчуванням —
обидва скрипти статично імпортували `lib/env.js` до встановлення `process.env`, тож `requireFunded` падав з
generic `fetch failed` (спроба з'єднання з непіднятим localhost). Виправлено тим самим прийомом, що й
`00-measure.ts`: `process.env.BASE_RPC` (і сусідні) виставляються *до* динамічного `await import(...)`.

`requireFunded(admin.publicKey, 2, "devnet-admin")` — поріг знижено до **0.3 SOL**: після деплою (4.61 SOL
з 6.1) payer мав лише ~0.89 SOL, а `devnet-admin` — окремий, ще незафандений ключ; 2 SOL були "грубим
запобіжником", не реальним бюджетом (виміряно: bootstrap коштує **~0.028 SOL** admin'у). `devnet-admin`
профінансовано 0.6 SOL з `payer` (sig
`3DuvfHjpHqLnS5XGGJyYKxfhU1uMp5NGHzPWup6jMSpW17X61Y8kVSrMvmkr8DDtsJn7aJQs4xDkQmg2fAtGzbKy`).

`DEXXER_NET=devnet npx tsx ../../scripts/admin/devnet-bootstrap.ts` — **успіх з другої спроби** (перша впала
на тому самому `.env`-баг до виправлення). Адреси: `admin`
`8L4EyWLc6yGH4c3zrVWLCoJqRbgWGtUf9sYyqnMPkVtH`, `crank` `2w7Xvd4GtS4rTE86tG51LMa9ZvLckDMFizb6XZDQerFA`,
`fee-payer` `3HgDNwQPnHRRK6Sy5MXTN18zEYpGMJZioiGV3dD3Chnt`, `mint` `2URtQ5L8oJiUtbtXXvbNk3MRoAt4w8DTZ8GB7r4uCZ29`,
`market` `1347yiBYsvCwqjJf8TUB9D4KSPp7RVF2cwQxfxSj4udp`, `marketRisk` `GNyNkDkb4CpG4ftuimmXsoXVxdv9tmoQRusmhfZvgnr5`,
`pool` `S7S157Q7VGBSxfeUXscrdnobbMKC2gTFKXpQe5L31mj`, `poolAta` `Ai9S7fxN9QRdTYv8dasKRo3caNPzEep8agacTw6uoZSo`,
`feed` `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` (реальний Pyth Lazer feed під MagicBlock Pricing
Oracle, не мок). Ключові підписи: `init_config`
`3QhP4n1UPTuKtnfEenSk8xiMm53beUtt71yKP1kYcru6WnigRKHkRuf9rayAys7JyyvGrkLDXpu6zS1Rpma4dVvj`, `delegate_market`
`yas7EcnS6rBVPdpiw1nTaV4kn3kTpdhHMYVPPU1Fw11Wm7fgcitNCqh1pR29NW7SfRNR9ws3TEHQh59dtz9MHk3`, `delegate_pool`
`3eZEQ7z4P7uXZTZhPfYwHgwtK7XfeEFLJjrroxmyNRLuzF34A7Uq2AQ3ZGncRRZqTxexbEKeoHxBB7t76dZtW5dW`.

Верифікація: `routerStatus` для `market`/`marketRisk`/`pool` — усі `isDelegated: true`, `fqdn:
"https://devnet-tee.magicblock.app/"`. `Pool.capital_total` та `protocol_liquidity` через `teeConn(admin)`
— **10000000000** (10 000 dUSDC), обидва.

### Крок 0.4 — `fund-fee-payer.ts`: реальна знахідка

Прогін **впав** на симуляції: `require!(destination_info.owned_by(&DELEGATION_PROGRAM_ID)) failed,
sponsored_lamports_transfer.rs:71` / `InvalidAccountOwner`. Підтверджує написане в самому файлі
(`fund-fee-payer.ts`'s заголовковий коментар з Task 0): `lamportsDelegatedTransferIx` вимагає, щоб
`destination` уже була **делегованим** base-layer акаунтом (те саме підтверджує
`references/lamports-topup.md` skill'а `magicblock`: "Destination must already be delegated"). `devnet-fee-payer`
— звичайний, ніколи не делегований keypair (`Config.fee_payer` — просто `Pubkey`, а `CommitAggregate.payer`
— `Signer<'info>` на верхньому рівні транзакції, тобто програмний PDA там технічно **не може** опинитися:
PDA не має приватного ключа для підпису зовнішньої транзакції). Це передвіщає знахідку Задачі 3/Task 5 нижче
(`03-commit-cycle`).

Замість `lamportsDelegatedTransferIx`, `devnet-fee-payer` профінансовано напряму 0.05 SOL з `devnet-admin`
(звичайний `SystemProgram.transfer`, той самий механізм, що надійно працював для `payer`/`user`/`crank`
протягом усіх вимірювань M1–M4 Task 1) — цього достатньо для сплати комісій ER-транзакцій самим
fee-payer'ом (не для fee-vault шляху — той лишається недоступним, див. нижче).

### 01-onboard-private — PASS

Повна приватна послідовність онбордингу (`tests/er/devnet/01-onboard-private.ts`): свіжий трейдер (генерується
кожен запуск, `Keypair.generate()`-подібна ідентичність під унікальним іменем `devnet-trader-<runId>`,
профінансована напряму з `devnet-admin`, не `requestAirdrop` — той ненадійний на реальному devnet) → faucet
→ `init_user` → знімок байтів `Position` **до делегації** → `delegateSpl` → `delegate_user` → `credit_deposit`
(ER, owner-токен) → `init_permissions` (private, members=[owner, crank] — сесія ще не встановлена) →
`set_session` (перебудовує members на [owner, session, crank]) → фандинг сесії → `open_position`,
підписаний **лише** сесійним ключем.

**Відхилення від букви брифу:** фандинг сесії — НЕ `lamportsDelegatedTransferIx(payer, session, 0.01 SOL)`,
а звичайний `SystemProgram.transfer` на base (0.01 SOL, як і в брифі). Причина — та сама, що й у
0.4: `lamportsDelegatedTransferIx`'s `destination` мусить бути вже делегованою (перевірено емпірично на
`fund-fee-payer.ts` вище), а сесія — звичайний, ніколи не делегований keypair, не PDA. Механізм, що реально
працює (доведено по всіх вимірюваннях M1–M4): звичайний гаманець із base SOL має видимий баланс і в ER
(клонується разом з рештою стану), достатній для сплати власних ER-комісій — саме це й потрібно фразі брифу
("session pays its own ER fees").

**Перша спроба (runId `1789926691277`) впала** на `open_position`: `AnchorError InvalidInput (6002)` —
`size=0.1 SOL, margin=$30` при реальній ціні SOL/USD (~$110.04, зчитано напряму з живого фіда через
`teeConn`) дає notional=$11 < margin=$30 → leverage <1x → `math::liq_price` повертає `InvalidInput`
(`math.rs`: "margin > notional (leverage below 1x) has no liquidation price"). Виправлено: `size=1.0 SOL,
margin=$20` (notional ~$110, ~5.5x — у межах 10x max / вище 10% IMR).

**Другий прогін (runId `1789926789424`) — PASS.** `owner`
`8Tax4NJKM6knGKJ2yYic1P8g1QW1uLZT1JRZ9ae2TLtK`, `session` `C6eVfKxUN6nL85v64XdMyxZuKeQEj2mRrx98enfMKwxG`,
`position` `F7U8j2k2MJLhKpwNQixGdgfsMhSBiiSnKkn7LmVASBft`. Ключові підписи: `init_user`
`413ds1DzhsN54xfBk5psoPcaWJuqFdXzvi8hR7tHgU3ymfgMZ58iZ7gxqdQMsfCjK3VEy27SZ2v3mhxfw9a9cEGr`, `delegate_user`
`4pQ3VQhNmgtkVMfVQvBjFnqgq8yMQXDgSxMDGBEZf6YGGr4qe5PsHAFribffe5hEPrFALmc6RpHdMqFeASbjbm4t`, `credit_deposit`
`31s1eF9NBu1vxo9NXJNj91GJWfNwEcoiAEgEAiwRBvHN8iYhzCUoUiKrwnU6d3ix5vSZsqFCgYCorKEotnaMx8yg`,
`init_permissions` `2AjdwtABMN7Ms8aVr9dp1naG2WHptkckCCNuRjAHzzcm4F8LaVTYtzfLZwqdwyjKqd6RVEL8nEsooJLWupEZtJyX`,
`set_session` `262qGraMQNet9Q7pRWGmDPoxVGYdv4Yqtk1CaexyGxxDi5kQCYLbyqezQyG3cHCfBXrbyBdm2LuFreZCijFXfDSS`,
`open_position` (session-signed)
`3QF5Le3W88KrLc997zeeaxzYtAdprX29HUgYHHN32ZNrmdL6wa7uAzkwM2vyFQ6eMUxrHsxzYNa3S2pzfWiVZUCQ`. Position після
відкриття (прочитано owner-токеном): `state=Open, side=Long, size=1000000000 (1 SOL), entry=110004104
(~$110.00), margin=20000000 ($20)`.

### 02-leak-test — LEAK TEST PASS (усі 6 перевірок)

| # | перевірка | результат | нотатка |
|---|---|---|---|
| a | base RPC: owner + байти | **PASS** | owner=`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, 265B == знімок до делегації |
| b | TEE без токена | **PASS**\* | HTTP 200, `value: null` (не помилка/401 — див. відхилення нижче) |
| c | stranger-токен | **PASS** | `null` |
| d | session-токен | **PASS** | видима, 265B |
| e | crank-токен | **PASS** | видима, 265B |
| f | owner-токен | **PASS** | видима, `state == Open` |

**\*Відхилення від букви брифу (b):** брифова очікувана поведінка — "HTTP 401/помилка". Реальна поведінка
`devnet-tee.magicblock.app`, перевірена і клієнтом (голий `Connection` без токена), і прямим `curl`-ом
(без жодних заголовків auth) на `getAccountInfo` тієї самої позиції: **HTTP 200**, заголовок
`x-mb-remote-account-claims: 0`, JSON-RPC `{"value":null}` — без помилки на жодному рівні. Властивість
приватності, яку перевірка фактично мусить довести (неавтентифікований читач нічого не дізнається про
приватну позицію), виконується — просто через мовчазний `null`, а не відмову запиту. Перевірка (b)
переписана на "no-token → не видимо (помилка АБО null)" замість жорсткого очікування помилки.

### 03-commit-cycle — FAIL (справжня архітектурна знахідка, не флакі)

`fee-payer` `3HgDNwQPnHRRK6Sy5MXTN18zEYpGMJZioiGV3dD3Chnt`, `magic_fee_vault`
`EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b`. Коміти #1–#10 — **успішні** на ланцюгу (sig #1
`4fqRHGz7SNZkjCSuEEUGBUK5WwRZ9dT2DGCCGrGhr5FvsTXKnEbdHhBdDh6kEaVZspxZcS7dkwZvYcVxjcFQd7xd`, #10
`2B7RPJKmx1i48jEyGpHArw6FzjXb2rdfNnQnut1a4zpGjqEd7wP5cgkxC8v2QuAwaLrJ6i74AEWkFYcREVuL3K9t`; поллінг
`Pool.last_commit_slot` на base підтвердив пропагацію для #2–#10, #1 сам пройшов, але мій поллінг на нього
(60×1с) спрацював запізно — реальний sig підтверджений). Коміт **#11 впав**: sig
`dbq6Q7f4ECuR6NgJrHeUz34nqU88AccuXRY42W2Q2sBba2RYnwc11ByNRvzbqmth6icStBzcVdbFtMUv3XjdGDz`, `{"InstructionError":[0,{"Custom":2684354560}]}`
— **2684354560 = 0xA0000000 = `COMMIT_LIMIT_ERR`**, точнісінько код M3a. Коміт #12 — та сама помилка (sig
`49iNzotLmFFcoAzYRkeWzAFH5e8vsURRQfjEnxv6rMcwMi2Tgn3TXMQU5K7Dij62y8QCE9gAG6iBtiJb4iiiddFw`). `fee-payer`'s
ER-баланс лишився рівно `50000000` лампортів **до і після кожного** коміту (delta 0 всюди, і успішних, і
провалених) — узгоджується з M3's раніше знайденою неоднозначністю "видимий баланс не змінюється". `Position`
та `UserAccount` на base — **незмінні** протягом усього циклу (підтверджено побайтово).

**Корінна причина (підтверджена документацією MagicBlock skill і напряму на цій сесії, не здогад):**
fee-vault-шлях ("Option 2" у `delegation.md`/`fees-and-commit-economics.md`) вмикається **лише** коли
CPI-payer інтенту одночасно **делегований** і **підписує через seeds** (цитата: "The payer must be
delegated, non-confined, writable, and able to sign", "usually a PDA that signs via seeds"). `commit_aggregate`
(`programs/dexxer_core/src/instructions/commit.rs`) передає `ctx.accounts.payer` — оголошений
`Signer<'info>` **на верхньому рівні** контексту інструкції — напряму як payer у
`MagicIntentBundleBuilder::new(...)`. Акаунт, оголошений `Signer<'info>` на верхньому рівні прямо
викликаної інструкції, **структурно не може** бути програмним PDA (PDA не має приватного ключа, не може
підписати зовнішню транзакцію) — отже `Config.fee_payer`, яким би він не був, завжди залишиться звичайним
гаманцем, ніколи не задовольнить вимогу "delegated + signs via seeds", і `.magic_fee_vault(...)` ніколи
реально не вмикається: інструкція завжди йде по Path A (без делегованого payer'а) — 10 безкоштовних
plain-комітів на акаунт, назавжди (не часове вікно, підтверджено M3a), потім `0xA0000000`.

Незалежно підтверджено тим самим кроком 0.4 вище: `lamportsDelegatedTransferIx` проти `devnet-fee-payer`
впав з `InvalidAccountOwner` — `Config.fee_payer` дійсно не (і не може стати клієнтським кроком) делегованим
акаунтом за поточним дизайном.

Паралель зі спайком: M3b (Task 1) розв'язала точно цю саму проблему для `private-counter`'s
`commit_with_vault`, переключивши CPI-payer із простого гаманця на `counter` (делеговану PDA, що підписує
через `invoke_signed`), лишивши гаманець лише платником **зовнішньої** транзакції — документація явно
розділяє ці дві ролі ("payer" і "committed accounts" незалежні). `commit_aggregate` потребує аналогічного
редизайну (окрема делегована PDA як CPI-payer, відмінна від того, хто підписує саму транзакцію) —
**програмна (Rust) зміна поза мандатом Кроку 0 цієї задачі.** Робота над скриптом 03 зупинена на цьому —
жодних змін у `.rs`-файлах поза Кроком 0 не внесено; знахідка й докази запротокольовані тут для контролера.

**Висновок decision (c) (M3, тепер фіналізовано напряму на `dexxer_core`):** реальна вартість
fee-vault-комітів **лишається невизначеною й непідтвердженою** — не тому, що вимірювання не вдалося, а тому,
що fee-vault-шлях у поточному дизайні `commit_aggregate` ніколи не активується взагалі (завжди Path A).
Ліміт **10 успішних-назавжди-plain-комітів на акаунт** підтверджено вдруге, тепер на реальному `Pool`
`dexxer_core`, не лише на спайку.

### 04-withdraw — PASS (дві головні асерції), одна асерція не підтверджена в межах вікна спостереження

`withdraw(300e6)` owner-токеном (ER): sig
`DmXntxi7f2XRtFCWHxyi5e2sDESQsmV289pgiksVrEs5JLEJozT2MF1MgJE2qmbjyW3hNwKbHCtf95jWMF3JVmX`.
`UserAccount.free_margin` на ER: `979933997 → 679933997` (рівно −300000000). **PASS.**

L1-нога (M4/decision (d)): `undelegateIx(owner, mint)` — sig
`3M3AuMfSo5jGVVxp4UM4NyXJrZAreYLyWVvrMVGKdymoHEoWpxCf5D7ASqBnKec1CKLiDzxNfuZmc8E9yFBYvQ4c` → поллінг base
ATA до `owner == TOKEN_PROGRAM_ID` — підтверджено → `withdrawSpl(owner, mint, 300e6, {idempotent:false})` —
sig `5FtJYb4CPwGo7vSjCXyL9XM4DyoeCUVXrEFtU9NtfZwyE3rpyTDp36vC65ghVM2MDui377MxvRWjoj7p9HvrwhDC`. Базовий ATA:
`0 → 300000000` (рівно +300000000). **PASS.**

**Не підтверджено:** остання асерція брифу ("assert base UserAccount updated — the withdraw ix's commit
intent landed") — поллінг `UserAccount` на base тривав **~7.5 хвилин сукупно** (30с у самому скрипті + 5 хв
+ 2 хв окремими прогонами) і жодного разу не показав оновлене значення (лишався на до-withdraw
`979933997` замість `679933997`). Withdraw-транзакція сама пройшла успішно (ER-стан коректний, лампорти
дійсно перейшли на base ATA — сама функція withdraw працює), тобто CPI `MagicIntentBundleBuilder::new(...).commit(&[user_account]).build_and_invoke()`
у `withdraw` (`instructions/user.rs`) не впав — але й комітнутий стан `UserAccount` не долетів до base за
час спостереження. `withdraw` передає той самий патерн CPI-payer'а, що й `commit_aggregate` вище
(`ctx.accounts.owner` — звичайний гаманець, не делегована PDA), тож імовірно та сама корінна причина
(Path A, без делегованого payer'а) — хоча тут це не мало б бути `0xA0000000` (перший-в-історії коміт для
цього `UserAccount`, лічильник мав би бути << 10). Найправдоподібніше — планування/пропагація через
недельогованого payer'а на цьому шляху взагалі ненадійна чи набагато повільніша за спостережене вікно, а
не жорсткий ліміт. **Не діагностовано до кінця** — чесно позначено як відкрите питання, не заявлено як
PASS без підстав. `Config.fee_payer`'s редизайн (03) імовірно розв'язав би і це.

### Файли

- Create: `tests/er/devnet/01-onboard-private.ts`, `02-leak-test.ts`, `03-commit-cycle.ts`,
  `04-withdraw.ts`.
- Modify: `tests/er/lib/trader.ts` (`DEXXER_NET`-обізнаний: усі ER-виклики резолвлять з'єднання через
  `teeConn(kp)` замість модульного `erConn`; локально `teeConn` повертає `erConn` без змін — байт-у-байт
  та сама поведінка, що й тиждень 1), `tests/er/lib/admin.ts` (`ER_VALIDATOR`/`MAGIC_FEE_VAULT` у
  `init_config`-виклики обох `bootstrap()`/`bootstrapDevnet()`; поріг `requireFunded` для `devnet-admin`
  знижено 2→0.3 SOL), `tests/er/package.json` (`devnet:onboard|leak|commit|withdraw`),
  `scripts/admin/devnet-bootstrap.ts` та `fund-fee-payer.ts` (виправлено `.env`-переважає-`devnet`-профіль
  баг тим самим прийомом, що й `00-measure.ts`).
- Нові gitignored ключі під `tests/er/.keys/`: `devnet-admin.json`, `devnet-crank.json`,
  `devnet-fee-payer.json`, `devnet-mint.json`, `devnet-trader-<runId>.json`, `devnet-session-<runId>.json`
  (по одному на прогін 01), `devnet-run-latest.json` (вказівник стану для 02–04: адреси, sig'и, знімок
  байтів `Position` до делегації).

`cd tests/er && npx tsc --noEmit` — чисто на фінальних версіях усіх змінених/нових файлів.

### Баланси (кінець Task 5)

| ідентичність | баланс (SOL) |
|---|---|
| `payer` (spikes/keys/payer.json) | 0.889360697 |
| `devnet-admin` | 0.422066120 |
| `devnet-fee-payer` | 0.05 |
| trader (`devnet-trader-1789926789424`) | 0.019389248 |
| session (`devnet-session-1789926789424`) | 0.01 |

Найбільша стаття витрат сесії — деплой (~4.61 SOL із 6.1 стартового бюджету `payer`); увесь Task 5 після
деплою (bootstrap + 01–04, включно з провальною першою спробою 01 і діагностикою 03/04) — менше 0.7 SOL
сукупно з `devnet-admin`.

### Fix round 1 (контролерське рішення: `commit_aggregate` платить через делеговану `FeeEscrow`)

**Статус: завершено — редеплой успішний, 03 PASS (12/12), 04 частково PASS (переміщення коштів; коміт
`UserAccount` на base лишається невирішеним, окреме питання, не пов'язане з payer-механізмом — див. "Раунд
3" нижче).**

Дизайн реалізовано повністю: нова `FeeEscrow` PDA (`programs/dexxer_core/src/state/fee_escrow.rs`, seeds
`["fee_escrow"]`), `init_fee_escrow`/`delegate_fee_escrow` (admin-gated, той самий патерн, що й
`delegate_market`/`delegate_pool`), `CommitAggregate` тепер передає `fee_escrow` як CPI-payer у
`MagicIntentBundleBuilder` через `build_and_invoke_signed` (не `ctx.accounts.payer` — той лишається лише
підписантом/авторизатором зовнішньої транзакції, `Config.fee_payer`-констрейнт незмінний). Додатково:
повторна перевірка на реальному devnet підтвердила, що `withdraw`'s коміт `UserAccount` **справді ніколи не
долітає** (30+ хвилин, значення й досі до-withdraw) — не просто повільний, як `Pool`'s перший коміт. Тому
`withdraw` теж переведено на той самий `fee_escrow` CPI-payer (без `.magic_fee_vault` — цьому шляху вищий
ліміт не потрібен, лише прийнятний payer).

Гаунтлет — увесь чистий: `anchor build`, `cargo +nightly-2026-09-18 test -p dexxer_litesvm` **36/36** (новий
`ixs::init_fee_escrow`, `World.fee_escrow`, `ixs::withdraw` оновлено на новий акаунт — без нових `#[test]`,
існуючі тести неявно покривають), `cargo test -p dexxer_core` **46/46**, `program_autofixer` — 0 issues на
кожному зміненому файлі, `tsc --noEmit` чисто в `tests/er` і в `scripts` (той самий доперевіряний bs58-гап,
що й раніше, не новий).

**Редеплой, спроба 1** (payer 0.889360697 SOL, до фандингу від користувача): `solana program deploy
... --use-rpc` повернув `Account ... has insufficient funds for spend (4.7929038 SOL) + fee (0.00468 SOL)`.
Дефіцит: ~3.91 SOL. Нічого не витрачено.

**Після фандингу користувачем** (sig `2MgBeWXzQEN2YFUwp3k57b585gQqLtD7NoZr19G7f7qMBLcEYFbXKe2dsN2sSxQbpQySr66bxeUpEztWqui8vorc`,
payer 4.889360697 SOL) — той самий деплой впав ще двічі з іншою помилкою (`Account allocation failed:
account does not have enough SOL to perform the operation`, без деталей суми). Причина: задеплоєний
program-data акаунт (906632 байт) не має слеку під новий бінарник (943312 байт) — внутрішній auto-extend
крок `solana program deploy` і тимчасовий write-буфер (4.7929038 SOL) потребують коштів **одночасно**, а
попередня оцінка "~4.80 SOL" рахувала лише буфер.

**Знижено ризик окремим extend:** `solana program extend G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV 40000
--keypair spikes/keys/payer.json --url https://rpc.magicblock.app/devnet` — успіх, program-data тепер 946632
байт (достатньо для 943312-байтного бінарника). Коштувало **0.203205 SOL** (4.889360697 → 4.686155697,
назавжди — це рента нового, більшого акаунта, не втрата). Жодного "завислого" buffer-акаунта немає
(`--buffers` порожній до і після).

Повторна спроба деплою — та сама, точна помилка: `insufficient funds for spend (4.7929038 SOL) + fee
(0.00468 SOL)`. Оскільки extend уже зроблено, це вже **лише** вимога тимчасового write-буфера. **Точний
залишковий дефіцит: 4.7975838 − 4.686155697 = 0.111428103 SOL.**

**03-commit-cycle і 04-withdraw НЕ перезапускались** проти виправленої програми (стара версія й досі
задеплоєна на ланцюгу) — перезапуск проти старої програми нічого б не довів про фікс і витратив би ще
`payer`'s баланс без діагностичної цінності. Обидва лишаються з результатами оригінального прогону (03 —
FAIL на коміті #11, `0xA0000000`; 04 — PASS на переміщенні коштів, база `UserAccount` не підтверджена) до
моменту, коли редеплой стане можливим.

**Що розблокує (оновлено, раунд 2):** extend уже зроблено — далі потрібен лише невеликий фандинг `payer`
(`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`), ~0.15–0.2 SOL (точний дефіцит 0.111428103 SOL, +запас на
комісію), потім — `solana program deploy` (той самий `--use-rpc`-шлях) → `devnet-bootstrap.ts` (ідемпотентно
створить + делегує `FeeEscrow`) → `fund-fee-payer.ts` (тепер фандить ESCROW, не гаманець) → `npm run devnet:commit`
(очікується 12/12, delta балансу escrow ймовірно 0 — цей `Pool` уже має 10 довічних комітів з першого
прогону, тож цикл піде по nonce 11–22, усе ще нижче порогу 25 для live-fee) → `npm run devnet:withdraw`
свіжим трейдером (правило "одна позиція на трейдера") → фінальне оновлення цього розділу з реальними
підписами й балансами.

Повний дизайн, evidence і гаунтлет-вивід — у
`.superpowers/sdd/2026-09-20-week2-privacy-devnet/task-5-report.md` §"Fix round 1".

### Раунд 3: редеплой і повна переперевірка

Після фандингу `payer` до 4.986155697 SOL — деплой пройшов з першої спроби: sig
`4HRDWT8voKZ2WQZ4zKGGuHQuqESGjrnWAuEs5WpyhGSwjQSPGDGgMkiejah85jQNqzNrkkJDgTa3kq2smUqQEBBh`, program-data
946632 байт, `payer` після — 4.981475697 SOL (чиста вартість деплою ~0.0047 SOL — буферна рента повернулась,
жодних "завислих" buffer-акаунтів).

**Bootstrap ескроу:** `init_fee_escrow`
(`3zuxzL52UAkzJw6b1JbFStd53rCpMbi1onrjMyPkjv4LYVAHHWbDZJ339kfBgU8GEornGtGMGdYzUXyzqC22hdrn`),
`delegate_fee_escrow`
(`4EbPcqPgPhQ92ijdkUiFK54bD715hMgEFUtpTbDgmMfNkHoz7E9KdL1LRXV1YMuKj9u9YYy1ptZb5F8jRzqMtN3a`) — `FeeEscrow`
PDA `85ncXT9nYSAjjne8zA2e32Ew77EPygfJnPF15aqsLhJH`, підтверджено делеговано. `fund-fee-payer.ts` — **успіх**
(sig `3A8Pii2N7gcT8hqV6wrWaZ91NcUGrvQBxHFYTvd35wVXy6Epjicxw7RS88GHyAhWVUMSto56WHsRpffL5S81ow89`, 0.2 SOL);
ER-баланс ескроу: **200701040 лампортів**. Це перший успішний прогін цього скрипту взагалі — доказ, що
ескроу дійсно задовольняє вимогу `lamportsDelegatedTransferIx` ("destination must be delegated"), де
звичайний гаманець `devnet-fee-payer` не міг ніколи.

**03-commit-cycle — PASS.** Усі 12 комітів пройшли на ланцюгу (#1 сам пройшов, лише поллінг пропагації
запізнився — той самий артефакт, що й у першому прогоні; #2–#12 підтвердили пропагацію). **Коміт #11 — саме
той виклик, що раніше падав з `0xA0000000` — тепер успішний**: sig
`V4t26xjcJBD9VkvBxS3qJj1f2RMmhW7iaHV4MENVVG2YDKVp15JtwgPYBTUjR27ojKHEs42dspKLfWALajbVayx`. Коміт #12: sig
`63QHQWKyXxVHHcQpMocDkV8cww4CCnxA4aM9atbXfCMVKMA7eE6BAnt1UXQrUAkTSMywjmW8Si8m4gkbaPnSEQma`.

**Баланс ескроу — рівно `200701040 → 200701040`, delta 0, усі 12 разів без винятку.** `Position`/`UserAccount`
на base — побайтово незмінні протягом усього циклу.

**Рішення (c), фіналізовано:** ці коміти — nonce 11–22 цього `Pool` (продовження 10 з першого прогону), усі
нижче порогу 25, де за `fees-and-commit-economics.md` починаються live-списання (100 000 лампортів/акаунт
при nonce ≥ 25). Нульове списання — саме те, що передбачає це правило. **Fee-vault шлях підтверджено живим і
функціональним** (перетинає 10-коміт хард-кап no-vault шляху), але його реальна вартість за коміт нижче
nonce 25 лишається невиміряною — чесна прогалина, не суперечність: у цьому діапазоні nonce нічого й не мало
списатись, і не списалось.

**04-withdraw — друга реальна знахідка, виправлена; коміт `UserAccount` на base лишається відкритим
питанням.** Перший повторний прогін (свіжий трейдер, runId `1789936060209`) упав одразу на `withdraw`:
`InstructionError::MissingAccount` — базова помилка Solana-рантайму, не Anchor. Причина: перша версія фіксу
для `withdraw` не додала `.magic_fee_vault(...)` (вважалось непотрібним для цього шляху). Реальний devnet
показав інше — валідатор вимагає акаунт vault у списку акаунтів CPI щоразу, коли payer делегований,
незалежно від кількості комітів. Виправлено: додано `magic_fee_vault` до `Withdraw` (той самий констрейнт,
що й у `CommitAggregate`) і `.magic_fee_vault(...)` у builder — точно як `commit_aggregate`. Це також
зажадало `Box`-нути `config` у `Withdraw` (стек SBF-фрейму переповнився — `Access violation in stack frame
5` — зловлено LiteSVM, не devnet).

Повний локальний гаунтлет після цього другого патчу: `anchor build` чисто, LiteSVM **36/36** (знадобився й
LiteSVM-фікс: `Pubkey::default()` — локальний плейсхолдер "без fee-vault вимоги" для `Config.magic_fee_vault`
— **це** адреса самого System Program, яку SBF-рантайм відмовляється позначати `mut`; новий `mut`-акаунт
`magic_fee_vault` у `Withdraw` впав на `ConstraintMut` проти нього. Виправлено: `World.magic_fee_vault` —
свіжий, неисполняемый dummy-pubkey, не `Pubkey::default()`), `cargo test -p dexxer_core` **46/46**,
`program_autofixer` чисто, `tsc --noEmit` чисто. Редеплой (946632 байт — extend не знадобився, влізло в
наявний слек; довелось повернути 0.35 SOL з `devnet-admin` назад у `payer`, бо точна вимога буфера
4.80619308 SOL перевищувала баланс `payer` після раунду 2 приблизно на 0.33 SOL): sig
`97rZ9vQepbqjsHSe6st7qQunM3fCWejqQyUHqZVaDyhka1mdMKETGs7vbtYTnsCYEY4fgdLpy5W3FpjXg9YTD3i`, чиста вартість
~0.0047 SOL, жодних завислих буферів.

Онбординг свіжого трейдера (runId `1789936529816`) і повторний withdraw:

- `withdraw(300e6)` — **тепер успішно**, sig
  `2XNrswEYHMhCiHC4oc8LZMrcNjb2J9zEGHVXnjNk9f7cejHXFn4fP38wfJEH36PEdfefwo6uk5vjtJxDE7C42kWw`. ER
  `free_margin`: `979933838 → 679933838` (рівно −300000000). **PASS.**
- `undelegateIx` → поллінг → `withdrawSpl` — базовий ATA `0 → 300000000` (рівно +300000000). **PASS.**
- Базовий `UserAccount.free_margin`: поллінг **ще ~3.5 хвилини** цього прогону (30с усередині скрипту + ще
  90×2с=180с окремо) — **і досі** показує до-withdraw значення, не `679933838`. Акаунт на base — і досі
  власності Delegation Program (очікувано для звичайного, не-undelegating коміту), байти незмінні.

**Це вже третє незалежне підтвердження, на трьох різних ідентичностях трейдера й двох різних конфігураціях
CPI-payer'а (звичайний `owner`, потім `fee_escrow`+vault), що коміт `UserAccount` ніколи не долітає до
base.** У поєднанні з результатом 03 (`Pool`, не приватний, комітиться миттєво й надійно тим самим
механізмом escrow+vault) — сам механізм тепер доведено робочим. Найімовірніше пояснення (не підтверджене):
`UserAccount` приватний (має активний `EphemeralPermission` від `init_permissions`/`set_session`), тоді як
`Pool` — ніколи. Звичайний `.commit(&[user_account])` комітить **увесь** сирий байтовий стан акаунта;
власне правило CLAUDE.md ("`UserAccount` — лише `free_margin`/`locked_margin`" може комітитись) натякає, що
задуманий дизайн — це field-scoped або інакше приватність-свідомий шлях коміту, не сирий повноакаунтний
коміт, який валідатор, що дотримується цієї межі, цілком міг би мовчки придушувати для акаунта під активним
дозволом — як свідомий захист приватності, а не баг. **Не підтверджено** (жодних логів в обидва боки — `getTransaction`
ER для цього акаунта стабільно повертає порожньо, повторювана прогалина ще з Task 1). Рекомендую це як
окреме, спеціальне дослідження тижня 3, а не подальші здогадки в межах цього fix-раунду.

**Фінальні баланси:** `payer` 4.826780697 SOL, `devnet-admin` 0.26890656 SOL, `devnet-fee-payer` 0.05 SOL,
ескроу (base) 0.00070104 SOL / (ER) 200701040 лампортів. Жодних завислих buffer-акаунтів.

Повний вивід гаунтлету і всі підписи — у
`.superpowers/sdd/2026-09-20-week2-privacy-devnet/task-5-report.md` §"Раунд 3".

### Fix round 2 (контролерське рішення: мінімальна сума + per-account cooldown на withdraw)

**Знахідка ревʼю (Important):** спільна `FeeEscrow` тепер фінансує і `commit_aggregate` (admin/fee-payer-гейт),
і `withdraw` (owner-гейт). Будь-який власник із ненульовим `free_margin` міг викликати `withdraw(1)`
повторно; коміт кожного виклику списує ту саму ескроу (безкоштовно нижче nonce 25 його акаунта, 100 000
лампортів понад), тож sybil міг би грифити ескроу й зупинити спек-критичний 5-хвилинний коміт `Pool`.
Ризик ніде не був задокументований.

**Реалізовано точно за рішенням:**
1. `require!(amount >= MIN_WITHDRAW)` у `withdraw`, `MIN_WITHDRAW = 1_000_000` (1 dUSDC) — відхилення
   `InvalidParams`.
2. Per-account cooldown: нове поле `UserAccount.last_withdraw_slot: u64`; у `withdraw` —
   `require!(clock.slot >= last_withdraw_slot + WITHDRAW_COOLDOWN_SLOTS)`, `WITHDRAW_COOLDOWN_SLOTS = 300`,
   потім `last_withdraw_slot = clock.slot`. Новий варіант помилки `WithdrawCooldown` дописано **в кінець**
   `DexxerError` (порядок попередніх варіантів не змінено — LiteSVM-тести прив'язані до `X as u32 + 6000`).

**Гаунтлет:** `anchor build` чисто, `cargo +nightly-2026-09-18 test -p dexxer_litesvm` — **38/38** (36 →
38: `withdraw_zero_rejected` оновлено на очікування `InvalidParams` замість знятого `AmountZero`; два нові
тести — `withdraw_below_minimum_rejected`, `withdraw_cooldown_enforced`, останній через `h.warp(slot+301,
...)` підтверджує і відхилення в межах вікна, і успіх після нього), `cargo test -p dexxer_core` — **46/46**,
`program_autofixer` — 0 issues на кожному зміненому файлі (`state/user.rs`, `state/mod.rs`, `errors.rs`,
`instructions/user.rs`), `tsc --noEmit` чисто в `tests/er` і `scripts` (той самий довиправлений bs58-гап).

**Редеплой:** новий бінарник (945328 байт) уміщувався в наявний слек program-data (946632 байт) — extend не
знадобився. Успіх з першої спроби: sig
`5HfWuGRN4Y9UTWXQHm53mrSdfPJTeYuiqHYoPraGw95KASfHgqijdoYwdAFPeJXnxhSwpqyHzi2j9zmX7nmFpG5J`, чиста вартість
~0.0047 SOL, жодних завислих буферів.

**Smoke-тест (не повний прогін 01–04 — старі `UserAccount`и з попередніх прогонів стали нечитабельними через
зростання layout, це очікувано й прийнятно, вони одноразові):** свіжа ідентичність через `01-onboard-private`
(owner `Bzr7RnfYaUNRcRE57egMQA2Vh57cnnupvuWx7vzgGV4u`) — PASS. Один `withdraw(300e6)` (≥1 dUSDC) — ER-нога
пройшла коректно під новими правилами (`free_margin`: `979933925 → 679933925`, `last_withdraw_slot` на
акаунті виставлено в реальний слот `320086059`, підтверджено прямим читанням). L1-нога (`withdrawSpl`) впала
з першої спроби на тій самій `InvalidAccountOwner`-помилці, що й у M4-звіті ("eSPL ephemeral-ATA bookkeeping
apparently not safely re-cycleable"), але це — **не наслідок цієї зміни** (гейти min/cooldown вже пройшли
успішно до цього кроку, увесь L1-механізм `withdrawSpl` не чіпався в цьому раунді): повторна спроба (та сама
транзакція, без жодних змін) пройшла одразу: sig
`GQaker7zY541BnxTxaJCVD44W52cBCMjgok2jVeGKVjBfwZK2qCZYroXQiJpwRUVUEUi4J4CaN19mNzHz5tTVTz`. Базовий ATA
підтверджено: `300000000` (рівно withdrawn amount).

**Фінальні баланси:** `payer` 4.522085697 SOL, `devnet-admin` 0.51890156 SOL. Жодних завислих
buffer-акаунтів.

Повний опис — у `.superpowers/sdd/2026-09-20-week2-privacy-devnet/task-5-report.md` §"Fix round 2".

## Task 6: Crank на devnet

Fallback-скрипт (`scripts/crank-fallback/index.ts`) переведено на профіль `DEXXER_NET=devnet`
(`teeConn(crank)` замість анонімного `erConn`, кандидати — gPA із crank-токеном, `feed` читається з
живого `Market.feed`, а не з env); окремо написано `scripts/admin/schedule-crank.ts` для реєстрації
запланованого `crank_tick` через Magic Actions. Запуск: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`,
далі `DEXXER_NET=devnet npx tsx scripts/admin/schedule-crank.ts` (з `tests/er/`) і
`DEXXER_NET=devnet npm run crank` (з `scripts/`, або напряму `npx tsx crank-fallback/index.ts`).

### `schedule_crank` — FAIL, програмна знахідка (не обхідний шлях, контролеру на рішення)

**Статус: заблоковано, не потребує повторних спроб — помилка детермінована й повністю пояснена
логами.** `DEXXER_NET=devnet npx tsx scripts/admin/schedule-crank.ts` (admin через `teeConn(admin)`,
`task_id` = перші 8 байт SHA-256 program id як `i64` little-endian = `-8632762600545312817`,
`interval_ms=1000`, `iterations=86400`, `task_context = config` PDA — контролер-рекомендований вибір із
Task 1) падає на кожній спробі з `{"InstructionError":[0,"MissingRequiredSignature"]}`, sig
`3VPaX7Fg6E8nji9zejREbqTNJu1RoL7rfXKycv1eXBeuqtiEXWS5xtuU2SfbYJvLZaRe8ybH8NFGyvWDn8SYp5hy`. Повні логи
транзакції:

```
Program G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV invoke [1]
Program log: Instruction: ScheduleCrank
Program Magic11111111111111111111111111111111111111 invoke [2]
Crank ERR: only the crank signer PDA can be a signer in cranks (invalid signer: 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo')
Program Magic11111111111111111111111111111111111111 failed: missing required signature for instruction
```

**Корінна причина (підтверджена логами Magic Program напряму, не здогад):** Magic Program сам вимагає,
щоб будь-який акаунт, позначений `is_signer: true` у ЗАПЛАНОВАНІЙ інструкції, був **саме**
`CRANK_SIGNER` PDA (`magicblock_magic_program_api::pda::CRANK_SIGNER`,
`431bz9ziJVBCqea1gSxzmxvm1Bn1qJoZzSNHoweNc1f1` — обчислено в Task 1 M1) — не довільна ідентичність.
`programs/dexxer_core/src/instructions/crank.rs`'s `schedule_crank` будує `crank_tick_ix` з
`AccountMeta::new_readonly(ctx.accounts.crank.key(), true)`, де `ctx.accounts.crank` жорстко
обмежений констрейнтом `#[account(address = config.scheduler_signer @ ...)]` — тобто
`config.scheduler_signer` = `ER_VALIDATOR` (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, Task 1
рішення (a)), не `CRANK_SIGNER`. Це напряму суперечить тому, що вимагає Magic Program при
**реєстрації** запланованої інструкції.

Важливо: це **не** суперечить Task 1 M1 (там виміряно, хто підписує вже виконані тіки спайку
`05-crank-tee` — і це справді був `ER_VALIDATOR`) — той спайк використовував простішу власну
`scheduleIncrement`-інструкцію, чия внутрішня scheduled-інструкція, судячи з усього, взагалі не
позначала жоден акаунт `is_signer: true` (лічильник не потребує підписанта для власного інкременту),
тому ця перевірка Magic Program там просто не спрацьовувала. `crank_tick`, натомість, оголошує
`pub crank: Signer<'info>` — і саме тому `schedule_crank`'s власний CPI зобов'язаний позначити цей
акаунт підписантом у збереженій інструкції, а Magic Program дозволяє це зробити лише для своєї
PDA. Показово, що `crank_tick`'s constraint (`crank.rs`, рядок з потрійним `||`) **вже** приймає
`CRANK_SIGNER` як третю гілку (додано в Task 4) — тобто на рівні `crank_tick` шлях через
`CRANK_SIGNER` підтримується; розрив — лише в тому, яку адресу `schedule_crank` фактично записує в
`crank_tick_ix` і якою адресою обмежено `ScheduleCrank.crank`.

**Це програмна зміна (Rust), поза мандатом цієї задачі** (правило: "No program changes — if a
program bug blocks you, STOP and report with evidence"). Робочий напрям для контролера: у
`schedule_crank` будувати `crank_tick_ix`'s `crank`-мету з `CRANK_SIGNER` (SDK-константа), а не
`ctx.accounts.crank.key()`, і, ймовірно, або прибрати `ScheduleCrank.crank`'s `address =
config.scheduler_signer` (замінити на `CRANK_SIGNER`, або взагалі прибрати акаунт — таск-контекст
CPI все одно не перевіряє його змістовно), або тримати обидва (окремий параметр). Наслідок для цієї
задачі: **жоден `schedule_crank`-виклик не пройшов на реальному devnet-tee**, `Config.crank_task_id`
лишається `0`, і тому **перевірка (b) — планувальник тікає без fallback-скрипта — не спостережувана
в принципі** (немає жодного зареєстрованого таска, який міг би тікати). Прямо перевірено нижче: без
fallback-скрипта `Market.mark_slot` **не** рухається (очікувано й узгоджено з цією знахідкою, не нова
несправність).

`cancel_crank` **не викликався** — нема що скасовувати (жоден `schedule_crank` не пройшов).
Лишається невиміряним, як і в Task 1, тепер із додатковою причиною: сама передумова для тестування
(живий запланований таск) недосяжна, поки `schedule_crank`'s знахідка не виправлена.

### Друга реальна знахідка (по дорозі, теж не програмний баг — клієнтський фікс у скоупі задачі): застарілі `UserAccount` ламають `crank_tick` для ВСІХ кандидатів у тіку

Перший запуск виправленого `crank-fallback/index.ts` проти реального devnet-tee (без жодних
запланованих позицій ще) одразу падав на кожному тіку: `{"InstructionError":[0,{"Custom":3003}]}`
(`AccountDidNotDeserialize`), sig (приклад)
`kHB9VBEsbwbxk67QJz6WctR3FJFpqjiMZjykrW2kvD81W5DVysu3j9HCUchQaSDbg4Amcj2Kih4351oRt9w6tXb`. Логи:
`"AnchorError ... Error Code: AccountDidNotDeserialize ... custom program error: 0xbbb"`.

**Причина, підтверджена напряму (окремий діагностичний прогін через `getProgramAccounts` +
`getMultipleAccountsInfo`):** gPA із crank-токеном знайшов **5** приватних `Position`-акаунтів,
залишених із попередніх сесій Task 5 (кожен онбординг-прогін лишає свою позицію відкритою — жодна
ніколи явно не закривалась). У 4 з 5 пов'язаний `UserAccount` мав **110 байт** — старий layout
**до** Task 5's fix round 2 (`last_withdraw_slot: u64` додало 8 байт → 118 байт зараз). On-chain
`UserAccount::try_deserialize` (в `crank_tick`, `crank.rs`) відхиляє коротший буфer — і оскільки
інструкція обробляє всі пари `remaining_accounts` в одному циклі з `?` (early return), **один**
застарілий кандидат зривав **увесь** тік, включно з дійсними кандидатами в тому ж чанку.

**Виправлення (клієнтське, у скоупі цієї задачі — не торкається `.rs`):**
`scripts/crank-fallback/index.ts`'s `tick()` тепер батчем (`getMultipleAccountsInfo`) читає
`UserAccount`-байти кожного кандидата **до** побудови `remaining_accounts` і пробує задекодувати їх
поточним IDL-кодером (`prog.coder.accounts.decode("userAccount", ...)`); кандидати, чий `UserAccount`
не існує або не декодується (застарілий layout), пропускаються з логом-попередженням, а не зривають
тік. Перевірено: `decodeOk: false` з точним `RangeError [ERR_OUT_OF_RANGE] ... Received 109` для всіх
4 застарілих акаунтів (`5ejBECtZaQAqW3fLRnHFExD4RGMQzdcAGEe4sPXNAqHk`,
`51ENQKEjkBvfELRi16oUcUKvP6Bc32UUtDHJFBP6igQe`, `749EzaFEjb1AnFc7MDpovBxcxYSVRS9XMcxJCrkfr7SJ`,
`5Zgim9o7UMFefU59Sgq9jc74LzYjH2uN3reuoD84h92h`), `decodeOk: true` для 1 актуального
(`K4jc6gdnxCve5SSrWzCVWWMNp5rb4cYJsS2T7RcbXD5`, 118 байт, з Task 5's fix round 2 smoke-тесту). Після
фіксу тіки проходять стабільно (див. нижче).

### Перевірка (a): 10 хв роботи скрипта — часткове виконання, чесно позначено

**Статус: PASS на якості (кожен тік після фіксу — успіх, `Market.mark`/`mark_slot` оновлюються), але
НЕ повні 10 хвилин безперервно** — контролер перервав пасивне очікування таймера на середині вікна й
попросив звірити фактичний час і завершувати задачу, тож вікно спостереження коротше заявленого в
чекліисті. Дві чисті послідовні сесії скрипта проти реального devnet-tee, обидві після фіксу вище:

- Smoke-прогін (30 с): **8/8** тіків успішні, `tick_ms` 880–1334 мс, `cu=23251` (1 кандидат щоразу,
  застарілі пропущено).
- Основний прогін (~154 с, зупинений через `SIGINT` контрольовано — `"crank-fallback stopped
  (SIGINT)"` у логу, без жодного незавершеного тіка): **53/53** тіків успішні, `tick n=1` →
  `tick n=53`, `mark_slot` **321418491 → 321440622** (монотонно зростає щотіку). Під час цього
  прогону виконано перевірку (c) (нижче) — та сама сесія скрипта обслужила і фонове тікання, і
  тестову ліквідацію.

Разом: **61 успішний `crank_tick` на реальному devnet-tee** (8+53), нуль непояснених падінь після
фіксу застарілих `UserAccount`. Нижче — CU/латентність по всій вибірці (Перевірка d).

### Перевірка (b): планувальник без fallback-скрипта

**Статус: підтверджено (негативний результат, очікуваний і узгоджений зі знахідкою `schedule_crank`
вище, не нова несправність).** Одразу після зупинки fallback-скрипта: `mark_slot=321440622` о
`05:24:58.592Z`. Через 39 с без жодного скрипта: `mark_slot=321440622` (те саме значення, `mark`
теж незмінний — `111813712`) о `05:25:37.750Z`. Планувальник **не** тікає — узгоджено зі знахідкою
вище (`Config.crank_task_id` так і лишився `0`, жоден таск ніколи не реєструвався).

### Перевірка (c): ліквідація — PASS

Свіжий приватний трейдер (`tests/er/devnet/05-crank-liquidation.ts`, той самий приватний
онбординг-ланцюжок, що й `01-onboard-private.ts`, ті самі `lib/trader.ts`-хелпери
`creditDeposit`/`initPermissions`): owner `GqVNRGwCe6nnx6yKAe1FgyGFiqfUYsTdR2j3WTiHeczE`, session
`yXMK24Fks3fxEN35RUURgMymhsmgDkSFFNgra2i9ZRy`, position
`Gebi62PEyLdMJif81sjgPfzKTNeiU6ZNdBcrprQeTh5X`.

`open_position` (session-signed): лонг 1 SOL, entry `111693163` (~$111.69), margin `12284250`
(~$12.28), розрахована leverage ~9.09x (10x проти живого `Market.mark` дав би `InsufficientMargin`
через округлення `required_margin` на користь пулу — узгоджено з CLAUDE.md — тому 11% замість рівних
10%). Sig `2Pveuyw2s4dhBBtSBELL9EJdRAwyHQMXVPdZ6PYNaNzmAfvQNw42upXXFekistcUAYZ4y8xyRwHigjQk3HguH8q9`.

`set_params(mmr_bps=9_500, imr_bps=9_600)` (як admin, через `teeConn`) — sig
`L5hhwsZ5Ut1eFgTp3ZbucdGywmWHZyCnpcSCnCTHAviZrR3cPGJUbp1emReUQ4DMkufK1Kn1mk8LEyW6DehWerL`.
`imr_bps` піднято разом із `mmr_bps` лише щоб задовольнити `MarketParams::validate()`
(`imr_bps > mmr_bps`, on-chain) — уже відкриту позицію це не зачіпає (leverage перевіряється проти
`imr_bps` лише при відкритті, ліквідація — лише проти `mmr_bps`).

**Ліквідовано за 4.3 с / 4 полінги** (`liq_ticks` історія `[1,1,1,0]` — hysteresis=2 у
`sol_perp_defaults`, тобто фактично 2 послідовні тіки crank-fallback-скрипта побачили позицію
ліквідовною, плюс ~1-2 тіки лагу між підтвердженням `set_params` і найближчим тіком
crank-fallback-скрипта, який на той момент уже йшов у фоні для перевірки (a)). Тік, що закрив
позицію — `tick n=12` основного прогону, sig
`F7fHb1pG6Qs7irtMUxcppSqT1FkY65LQ3wGotfTLPSAPxKeBZzWwryq316Dd3Yx4F1jdwpANLZwSeMrk67PDRbq`, `cu=36146`.
`ClosedRecord`: `reason=Liquidated`, `pnl=-5281` (мала — ціна майже не рухалась за ці 4 с, ліквідація
форсована винятково через `mmr_bps`, не через реальний рух ринку), `fees=1117391` (~$1.12 = точно
`liq_fee_bps=100` (1%) від нотіоналу ~$111.8 — звірено).

**Відновлення параметрів (обов'язкове — спільний devnet-ринок) — виконано й підтверджено
он-чейн.** `set_params(origParams)` sig
`3KvT3eHcSGN5EZjYWSBuU4NMMee2P73Xeid9ce4fdWH83ZiTKF9FkmFjTrgXMDxVbp5ncwrJBpVioaJ8Cj5hSKRh`. Скрипт
порівняв усі 15 полів `MarketParams` до/після побайтово (`restoredOk: true`) — `mmr_bps` назад `500`,
`imr_bps` назад `1000`, решта незмінні.

**Побічний ефект, чесно зафіксований (не прихований):** `set_params` діє на весь ринок, не на одну
позицію. Поки `mmr_bps=9500` діяв (~4 с), той самий тік (`n=12`, `candidates=2`) заодно ліквідував
**і** непричетну позицію `8auwPa57372yoby48BFwPeSR9zPqnnDmccFsNPcw8uSN` — залишок Task 5's fix
round 2 smoke-тесту (owner `Bzr7RnfYaUNRcRE57egMQA2Vh57cnnupvuWx7vzgGV4u`), яка була відкрита й досі
не закрита з попередньої сесії. Фондів користувача це не торкнулось критично (тестові кошти
протоколу, пул — контрагент), але це реальний ризик для майбутніх задач на спільному devnet-ринку:
**зміна `mmr_bps`/`imr_bps` через `set_params` ліквідує ВСІ відкриті позиції ринку, що потрапляють
під нову межу, не лише тестову** — вартий згадки як застереження в майбутньому тест-дизайні (§7.1
ризиків, Task 9).

### Перевірка (d): CU і латентність тіка на TEE

За всією вибіркою **61** успішного тіка (smoke 8 + основний прогін 53, `tick_ms` = час від
`freshBlockhash()` до підтвердження `confirmSignature`, без gPA/фільтрації):

| candidates у тіку | n тіків | avg CU | avg tick_ms |
|---|---|---|---|
| 0 (лише EMA/mark, ринок порожній від кандидатів) | 41 | 15 399 | 1 039 |
| 1 (1 пара, не ліквідовна) | 10 | 23 251 (стабільно, без варіації) | 1 056 |
| 2 (уключно тік ліквідації, 1 close) | 2 | 34 363 | 1 215 |

`tick_ms` по всій вибірці: мін **880 мс**, макс **1 653 мс** — домінує `confirmSignature`'s 100-мс
поллінг-цикл + RTT до TEE, не сам виклик програми (CU навіть у найважчому спостереженому тіку —
36 146 з ліміту 200 000, ~18%).

### Файли

- Modify: `scripts/crank-fallback/index.ts` (профіль `DEXXER_NET=devnet`: `teeConn(crank)` з
  reconnect-ом при 401/timeout/`fetch failed`; `feed` тепер завжди з живого `Market.feed`, не з
  env/`LAZER_FEED_ID`; клієнтський фільтр застарілих `UserAccount` перед побудовою
  `remaining_accounts` — знахідка вище), `tests/er/package.json` (+`devnet:liquidation`).
- Create: `scripts/admin/schedule-crank.ts` (окремий скрипт, не вбудовано в `devnet-bootstrap.ts` —
  `schedule_crank` ER-only й має сенс лише *після* делегації Market/Pool, на відміну від решти
  bootstrap-кроків, які здебільшого L1-only до делегації; див. файловий коментар), `tests/er/devnet/05-crank-liquidation.ts` (перевірка (c), перевикористовує `lib/admin.ts`'s
  `bootstrapDevnet()` і `lib/trader.ts`'s `creditDeposit`/`initPermissions`, дзеркалить
  `01-onboard-private.ts`'s онбординг-послідовність).

`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` → чисто (0 помилок) в `scripts` і
`tests/er` (`npx tsc --noEmit` в обох).

### Баланси (кінець Task 6)

| ідентичність | баланс (SOL) |
|---|---|
| `payer` | 4.522085697 (без змін — не використовувався) |
| `devnet-admin` | 0.46889656 (−0.05 від `schedule_crank`-спроб + `set_params` ×2 + онбординг-фандинг трейдера) |

Жодних завислих buffer-акаунтів. Одна нова trader/session пара профінансована (0.05 SOL з
`devnet-admin`) для перевірки (c), лишена як gitignored ключ (`tests/er/.keys/devnet-trader-liq-*.json`,
`devnet-session-liq-*.json`) — у межах правила "одне онбордження трейдера" цієї задачі.

## Fix round (Task 6, контролер авторизував програмну зміну): `schedule_crank`/`cancel_crank` реально запрацювали; лишається одна проблема

**Контекст.** Findng 1 вище (`schedule_crank` падає з `MissingRequiredSignature`, "only the crank
signer PDA can be a signer in cranks") — програмний баг, поза мандатом основного проходу Task 6.
Контролер авторизував програмну зміну саме для `schedule_crank`/`cancel_crank` (crank.rs), з
рулінгом: використати `CRANK_SIGNER` (`magicblock_magic_program_api::pda::CRANK_SIGNER`) як
readonly-signer у внутрішній інструкції замість `config.scheduler_signer`; не чіпати
`crank_tick`'s власний констрейнт чи інші інструкції; лишити `scheduler_signer`-поле й
`init_config`'s арг без змін.

**Реальний прогін виявив ще ДВІ окремі, послідовні знахідки поза початковим рулінгом** — обидві
підтверджені прямими логами транзакцій, не здогадом, і обидві виправлено в межах ТОГО САМОГО
авторизованого проходу (той самий файл, `schedule_crank`/`cancel_crank`, жодних змін у
`crank_tick`'s власному коді):

### Знахідка А (програмна, `crank.rs`): `CRANK_SIGNER` (плаский) теж "invalid signer" — реальний підписант per-authority

Спроба з плоским `CRANK_SIGNER` (`431bz9ziJVBCqea1gSxzmxvm1Bn1qJoZzSNHoweNc1f1`, значення з M1) —
sig `3VPaX7Fg6E8nji9zejREbqTNJu1RoL7rfXKycv1eXBeuqtiEXWS5xtuU2SfbYJvLZaRe8ybH8NFGyvWDn8SYp5hy`, та сама
помилка, тепер називає ЦЮ адресу невалідним підписантом. Пряме читання pinned джерела валідатора
(`magicblock-labs/magicblock-validator`, commit `9c7a94470af1785d88f4c671571f87c146a93779`,
`programs/magicblock/src/schedule_task/{mod,process_schedule_task,process_execute_task}.rs`, а
також skill'а `magicblock`'s `references/cranks.md`) підтвердило: реальний прийнятний підписант —
`crank_signer_pda(task_authority)` = `find_program_address(["crank-executor",
authority.as_ref()], CRANK_PROGRAM_ID)`, де `task_authority` = payer-акаунт (index 0) інструкції
`schedule_crank`/`ExecuteCrank`, тобто наш `admin` — **не** плаский `CRANK_SIGNER`
(`magicblock-magic-program-api` 0.10.1, версія, запінена в цьому проєкті, ще не мала per-authority
API; `crank_signer_pda()` відтворено вручну з тих самих `CRANK_SEED`/`CRANK_PROGRAM_ID`, які 0.10.1
таки експортує). Виправлено: `schedule_crank` тепер обчислює `crank_signer_pda(ctx.accounts.admin)`
і використовує це значення і для `require!`-перевірки `ScheduleCrank.crank`, і для
`crank_tick_ix`'s account-мети.

### Знахідка Б (програмна, `crank.rs`): `config` не може бути writable у `ScheduleCrankCpi`'s `instruction_accounts` — і причина не та, що спочатку здавалось

Після знахідки А `schedule_crank` пройшов повз signer-перевірку, але впав з
`TransactionError::InvalidWritableAccount` / `"Account 2: <config> was illegally used as writable"`
(sig `29eRmcfGrqtTNaR1R7y1SScnWKYZkbjCPiKuuA7dD76CSGRTkdVoXaxgfo5AvBjoQvesBiuMEEgfQdB7VPdnuNKP`) — **у
той момент, коли `dexxer_core`'s власна інструкція вже залогувала `success`** (транзакція все одно
відкотилась цілком, атомарно — `Config.crank_task_id` лишився `0` навіть після цього "успіху").

**Перша (робоча) гіпотеза:** `config` ніколи не делегований в ER, тож writable-акаунт у
`instruction_accounts`, який не делегований, — заборонений. Виправлено прибиранням `mut` з
`ScheduleCrank.config` (і, як наслідок, `cancel_crank`'s `config` теж; `Config.crank_task_id` більше
неможливо писати жодною інструкцією — залишено як задокументоване vestigial-поле, реальний task_id
тепер лише в логах і в `cancel_crank`'s явному аргументі `task_id: i64`).

**Ця гіпотеза виявилась неповною.** Повторний прогін після прибирання `mut` — **та сама точнісінько
помилка** (`Account 2: <config> illegally used as writable`, sig
`2ct1kkj6AbqGP9HEsS4V3kfXm8rmHPSwNQQiWm7GFwLF2C4pUcpiW7fFmbQhzcPRL7WcsbGnyo5cPLfmy3uin9BK`), попри
те, що `config` тепер readonly і в Rust-констрейнті, і в клієнтських `remainingAccounts`. Пряма
перевірка скомпільованого повідомлення транзакції (`message.isAccountWritable(2)`) показала:
**`config` усе одно `writable=true`** — справжня причина: `scripts/admin/schedule-crank.ts` (обидві
спроби) передавало `task_context = config` (той самий PDA, за рекомендацією Task 1 — "будь-який
консистентний акаунт підходить"), а `task_context` **легітимно** потребує `mut`
(`#[account(mut)] pub task_context`, Magic Program сам пише туди). Solana компілює повідомлення
транзакції з дедублікацією по pubkey і **найширшою** запитаною привілегією — тож `config`,
з'являючись під ТОЮ САМОЮ адресою, що й writable `task_context`, успадковував writable незалежно
від того, що скрипт просив для слоту "config" окремо. **Виправлено на клієнті** (без жодної
Rust-зміни для цієї конкретної частини): `task_context` тепер `admin.publicKey` — той самий патерн,
що й Task 1 M1's спайк ("duplicate payer, ticks still ran"), і безпечний, бо `admin` уже й так
writable+signer у тій самій транзакції.

**Результат:** `schedule_crank` **успішно пройшов** — sig
`52hN5RVFcCSwVzNAEjCEBEkUJQqydhmBmoUE8UAiPmdF6X3fYSd2eanjAqZMwMRh1rbApxNCxSQNMGETc8eiPnni`
(task_id `-8632762600545312817`), повторно перевірено ще раз офіційним закомміченим скриптом — sig
`2EpKAV43CnRbgr5mUuAfxvmuUZ34ZzDrovkp55hBi2n5U3CKRK1fCcxGeivxXtfmY729PmmdhzzVfsh21f4aUjoC`.
`cancel_crank` **теж перевірено наживо й успішно** (task-1's UNMEASURED статус закрито): sig
`7yUTAp3o439WYJyugUeaf2BUVdYtTGvZ8CKE9LfbDwEa4JbTFMvqLB7meBKbVeSUunD8ZExgeAfE4kp85VAy2Gm`, лог
`"Successfully added cancel request for task -8632762600545312817"`, `err: null`. `cancel_crank`
тепер приймає `task_id: i64` явним аргументом (не читає `Config.crank_task_id` — те поле більше
ніколи не пишеться, з причини знахідки Б).

### Гаунтлет після обох виправлень

`anchor build` чисто; `cargo +nightly-2026-09-18 test -p dexxer_litesvm` — **38/38**; `cargo test -p
dexxer_core` — **46/46**; `program_autofixer` — 0 issues на `crank.rs`, `lib.rs`, `state/config.rs`;
`npx tsc --noEmit` чисто в `scripts` і `tests/er`. Редеплой (двічі, по одному на кожен build):
sig `3ZfBqzDd7B3VXHwz5GZNi5sJLtmm8tizAQt8RNF5p2eJXtsC2SMrECZnXqJ2om1H1VTM4wS3b3AA8gaxmgLcovRZ`
(знахідка А), sig `2ippaGZApAG5o7FAp5gUS49P3wp8XNdnurR4Q2bRrwMonCU4iAczHao3gUf33J1XsirnXKBUem3TqecFbymNvvR6`
(знахідка Б) — обидва рази без потреби `extend` (влізло в наявний program-data слек), чиста
вартість ~0.005 SOL/раз.

### Перевірка (b), повторно: **все ще негативний результат — але тепер із точним, іншим поясненням**

Після успішної реєстрації (обома task_id, і `-8632762600545312817`, і контрольним позитивним
`1789970609067` для діагностики) — `Market.mark_slot` **не зрушив ані на один слот за ~6+ хвилин
сукупного спостереження** (кілька окремих вікон по 60–90 с, останнє — `06:06:32Z`, значення й досі
`321440622`, те саме, що й до першої реєстрації). Це **не** та сама причина, що в оригінальній
Finding 1 (яка блокувала саму РЕЄСТРАЦІЮ) — реєстрація тепер точно проходить (два різні task_id,
підтверджено сигнатурами вище). Перевірено й відкинуто: знак `task_id` (позитивний контрольний
task_id теж не затікав).

**Найправдоподібніше пояснення (не підтверджене прямим логом, оскільки заплановані виконання не
з'являються в жодній транзакції, яку можна прочитати через `getTransaction` — вони, схоже, повністю
внутрішні до валідатора): `crank_tick`'s власний signer-констрейнт (`CrankTick.config`'s потрійний
`||`, `crank.rs`, незмінений за прямою вказівкою рулінгу) не приймає `crank_signer_pda(admin)`.**
Жодна з трьох гілок (`config.crank`, `config.scheduler_signer`, плаский `CRANK_SIGNER`) не дорівнює
цьому per-authority значенню — а саме воно, підтверджено кроком вище (Знахідка А, пряме читання
`process_execute_task.rs`), і є тим, чим Magic Program РЕАЛЬНО підписує заплановане виконання
(`invoke_context.native_invoke(ix, &[crank_signer])`, `crank_signer = crank_signer_pda(authority)`).
Якщо гіпотеза вірна, кожне заплановане виконання `crank_tick` падає на власному
`DexxerError::Unauthorized` — мовчки, без жодного сліду, який ми можемо прочитати з цієї сесії.

**Це вимагає ще однієї програмної зміни — саме в `crank_tick`'s констрейнті — яку поточний рулінг
явно захищав від змін ("do not change crank.rs's constraint or any other instruction").** Зупинено
тут, за тим самим правилом ("STOP and report with evidence, controller decides"): не чіпав
`crank_tick` без окремої авторизації. Робочий напрям для контролера: `crank_tick`'s констрейнт
міг би вирахувати `crank_signer_pda(a.config.admin)` (тим самим способом, що й `schedule_crank`
тепер робить) як четверту гілку (або замінити третю) — `Config.admin` уже доступний у контексті.

### Файли (fix round)

- Modify: `programs/dexxer_core/src/instructions/crank.rs` (`ScheduleCrank`/`CancelCrank`:
  `crank_signer_pda(admin)` замінює і плаский `CRANK_SIGNER`, і `config.scheduler_signer`;
  `config` більше не `mut` у жодній з двох; `cancel_crank(task_id: i64)` — новий аргумент),
  `programs/dexxer_core/src/lib.rs` (`cancel_crank`'s новий `task_id`-параметр прокинуто),
  `programs/dexxer_core/src/state/config.rs` (doc-коментар на `crank_task_id`, поле лишається,
  дані в ньому — ні), `scripts/admin/schedule-crank.ts` (`crank_signer_pda(admin)` замість
  `ER_VALIDATOR`, потім замість плаского `CRANK_SIGNER`; `task_context = admin.publicKey`, не
  `config`; `config` `isWritable: false` у `remainingAccounts`).
- Create: `scripts/admin/cancel-crank.ts` (обчислює той самий `task_id` за формулою бріфу; викликає
  `cancel_crank(task_id)`; той самий `task_context = admin.publicKey`).

### Баланси (кінець fix round)

`payer` **5.208025697 SOL** (двічі редеплой, ~0.005 SOL/раз, + оригінальний топ-ап контролера 0.7
SOL, зафіксований окремо). `devnet-admin` без змін від кінця основного проходу Task 6
(0.46889656 SOL) — schedule/cancel-виклики йдуть через ER, не через L1 SOL `devnet-admin`.
Планувальник лишено **зареєстрованим** (не скасованим) — останній живий виклик:
`schedule_crank` sig `2EpKAV43CnRbgr5mUuAfxvmuUZ34ZzDrovkp55hBi2n5U3CKRK1fCcxGeivxXtfmY729PmmdhzzVfsh21f4aUjoC`,
`task_id -8632762600545312817` — попри те, що (за поточною гіпотезою) заплановані тіки самі ще не
долітають.

## Fix round 2 (Task 6, контролер авторизував саме гіпотезу з дизайну): підхід виявився структурно неможливим — відкат до останнього робочого стану

**Рулінг:** `schedule_crank` сам обчислює `crank_signer_pda(admin)` і **пише** його в
`Config.scheduler_signer` до CPI, лишаючи `crank_tick`'s власний констрейнт незмінним (його друга
гілка, `crank.key() == config.scheduler_signer`, мала б пройти сама собою, щойно поле міститиме
реальний per-authority PDA). Для запису поля `config` знову має бути `mut`.

**Реалізовано точно за рулінгом**, з документованими seeds/джерелом
(`magicblock-magic-program-api/src/pda.rs`, той самий коміт `9c7a94470af1785d88f4c671571f87c146a93779`)
у коментарі коду. Гаунтлет — увесь чистий (`anchor build`, LiteSVM 38/38, `dexxer_core` 46/46,
`program_autofixer` 0 issues, `tsc --noEmit` чисто). Редеплой — sig
`4wJm9cQUxdgY15RuitJYvxdU9EEEcXUDjVSznbbmRerJPud3kE5PMVXWYMZY1HGxLrKgb83fT1whj7izRWfUY7aj`.

**Реальний прогін — та сама точна помилка, що й у fix round 1's Знахідці Б, тепер БЕЗ колізії
`task_context`/`config` (яку round 3 виправив):** `TransactionError::InvalidWritableAccount`,
`"Account 2: <config> was illegally used as writable"`, sig
`67SnVv4xggXcFstQM16ByuTnmGzdnWsouzG8RWqZ9HNRnmsuUFwMvHcBqWdTJANfkdZjsbLZFctTEr7SMe3KFhot`.
`accountKeys` підтверджено: `admin` (index0) з'являється рівно один раз, `task_context =
admin.publicKey` — жодної колізії адрес цього разу.

**Це остаточно, вже вдруге незалежно, підтверджує оригінальну (першу) гіпотезу з fix round 1: писабельний,
неделегований акаунт (крім `task_context`, яким опікується сам Magic Program) у
`ScheduleCrankCpi`'s `instruction_accounts` — заборонений, безумовно, незалежно від колізій адрес.**
`Config` ніколи не делегований в ER (архітектурний факт, який не зміниться) — а `config` мусить
бути присутнім у `instruction_accounts` (запланований `crank_tick` його читає). Із цих двох фактів
випливає жорсткий структурний висновок: **`schedule_crank` НІКОЛИ не зможе писати
`Config.scheduler_signer` (чи будь-яке інше поле `Config`) у тій самій транзакції, що й реєструє
кранк — незалежно від того, які ще акаунти залучені.** Підхід цього рулінгу, хоч і правильний за
задумом (decision-3 дизайну), наштовхується на цю on-chain властивість Magic Program, яку жодна
клієнтська чи навіть проста програмна зміна не обходить.

**Дія: відкат.** Файли (`crank.rs`, `state/config.rs`, `scripts/admin/schedule-crank.ts`) повернуто
`git checkout` до коміту `47e7f04` (fix round 1, останній робочий стан) — байт-у-байт той самий
бінарник (`sha256 9c6e0373816ccf1a70eab59675726154350bec13def0951838b75228a72fdf0a`, підтверджено
`shasum` до і після ребілду). Редеплой цього відновленого бінарника — sig
`dUxm3oA2Fj2tLPfZGqm7CbwrXqycthMjPLv69Kr36FR68FPoHaTB4E5uM7wJn4UfL2ZXuZ4vbShEJ2Cx5z1GBzx`. Перший
повторний виклик `schedule_crank` одразу після редеплою впав з `ConstraintMut` на `config`
(sig `2BHh4cq4bEqRg6CJCC4S5rpP3BFRijtY7LTWWuQwukJYSHTeYMUjFSKw5F7P8m26XViiFWcBfHuTamCgsYSiJ9ZK`) —
**транзиторний артефакт поширення оновлення бінарника по TEE-кластеру**, не нова знахідка: повторна
спроба за ~5 с пройшла успішно (sig
`3zYdMYKfqKcNu2o9DHj3MqJcSqjV8LrUnvfok8q4CqhcE3WCjJKyGp5NcmUveMKj6hNkCa3xzhpHLNe5ZWFAxM1M`,
`task_id -8632762600545312817`) — робочий стан fix round 1 підтверджено відновленим і живим.

**Перевірка (b), утретє: усе ще негативна, очікувано.** `Market.mark_slot` — `321440622`, незмінний
через ще 70+ с спостереження після відновлення (`06:17:27Z` → `06:18:37Z`), і `Config.scheduler_signer`
лишається оригінальним `ER_VALIDATOR`-плейсхолдером (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`) —
підтверджує, що невдала спроба цього раунду нічого не залишила напівзробленим (уся транзакція
відкотилась атомарно, як і очікувалось).

**Не ітеровано далі, як інструктовано.** Corінна причина лишається діагностованою з fix round 1
(`crank_tick`'s власний three-way signer-констрейнт не приймає `crank_signer_pda(admin)`), але
**механізм-кандидат для її вирішення звузився**: писати `crank_signer_pda(admin)` кудись у `Config`
(будь-яке поле, не лише `scheduler_signer`) з-під `schedule_crank` — структурно неможливо. Лишається
відкритим: чи `crank_tick`'s власний КОНСТРЕЙНТ (не `schedule_crank`) можна розширити четвертою
гілкою, яка обчислює `crank_signer_pda(a.config.admin)` **на льоту, під час самого тіка** (без
жодного попереднього запису в `Config`) — `crank_tick` сам ніколи не бере участі в
`ScheduleCrankCpi`'s `instruction_accounts`, тож на нього обмеження "writable-undelegated" з цього
раунду не поширюється; це вимагає зміни `crank_tick`'s констрейнту, яку обидва попередні рулінги
явно захищали від змін. Контролер вирішує між ще одним раундом і паркуванням тіків планувальника
як задачі тижня 3 (зовнішній crank-fallback скрипт уже забезпечує EMA-тіки, демо не залежить від
цього).

### Баланс (кінець fix round 2)

`payer` **5.198650697 SOL** (один редеплой цього раунду + один відкатний редеплой, разом
~0.0095 SOL).

## Fix round 3 (Task 6, контролер: значення scheduler_signer пишеться на BASE) — ПРАЦЮЄ. Планувальник реально тікає.

**Рулінг:** новий admin-інструкція `set_scheduler_signer(new_scheduler_signer: Pubkey)` на **базовому
шарі** (той самий `AdminConfig`-патерн, що й `pause`/`unpause` — `config` тут `mut` без жодних проблем,
бо ця інструкція взагалі не бере участі в `ScheduleCrankCpi`'s `instruction_accounts`, де саме й діє
заборона з fix round 2). `schedule_crank` повертається до стану fix round 1 (нічого не пише) і просто
читає `config.scheduler_signer` для `crank`-акаунта внутрішньої інструкції. `crank_tick` — незмінний.

**Реалізовано точно за рулінгом:**
- `programs/dexxer_core/src/instructions/admin.rs`: `set_scheduler_signer` — новий `AdminConfig`-гейтед
  ix, пише `config.scheduler_signer = new_scheduler_signer`.
- `programs/dexxer_core/src/instructions/crank.rs`: `schedule_crank` більше не обчислює
  `crank_signer_pda` сам — читає `ctx.accounts.config.scheduler_signer` (одне присвоєння, без
  `find_program_address`), `ScheduleCrank.config` лишається НЕ `mut` (як у fix round 1).
- `tests/er/lib/crank-signer.ts` (новий) — спільний `crankSignerPda(authority)` клієнтський
  хелпер, з точним посиланням на pinned джерело валідатора
  (`magicblock-magic-program-api/src/pda.rs`, коміт `9c7a94470af1785d88f4c671571f87c146a93779`).
- `tests/er/lib/admin.ts`'s `bootstrapDevnet()`: `init_config`'s `scheduler_signer`-арг тепер
  `crankSignerPda(admin.publicKey)` для СВІЖИХ бутстрапів (замість `ER_VALIDATOR`).
- `scripts/admin/set-scheduler-signer.ts` (новий) — для ІСНУЮЧОГО devnet `Config`: викликає новий ix
  на `baseConn`, звіряє результат на ланцюгу.
- `scripts/admin/schedule-crank.ts` — прибрано локальну `crankSignerPda`, імпортує спільну; додано
  явну перевірку `Config.scheduler_signer == crank_signer_pda(admin)` перед відправкою (інакше `FAIL`
  з чіткою інструкцією запустити `set-scheduler-signer.ts`).
- LiteSVM: новий тест `only_admin_can_set_scheduler_signer` (stranger відхиляється, admin проходить,
  значення звірене на ланцюгу) — **39/39** (38→39).

**Гаунтлет:** `anchor build` чисто; LiteSVM **39/39**; `dexxer_core` **46/46**; `program_autofixer` —
0 issues на `admin.rs`, `crank.rs`, `state/config.rs`; `tsc --noEmit` чисто в `scripts` і `tests/er`.

**Редеплой:** sig
`5862sZPZB4xa29KC2HusVRVBg7ReFM1NeJ76jiTJPbZQZzJNf9RdxG2nXieZ43eNpp9FpR2hYqk13Hbp3AFJV4hY`.

**`set_scheduler_signer` на базовому шарі — успіх з першої спроби**, sig
`23yweBXbrTjdBoWRdj73jNTG3dycMBmwozHCjgZi7U9WP9d8ttCjs3jHrMkrwWWkh9GDvUH53oi7hkeWDm6or5Hj`.
`Config.scheduler_signer` (base): `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` (старий ER_VALIDATOR-
плейсхолдер) → `BbLTvs9vqNBpcj6DmVeqDmFfpLz4cxBM9Cr4HGb5w7wk` (`crank_signer_pda(admin)`), **звірено
безпосередньо читанням акаунта після транзакції**, не лише за кодом виходу.

**`schedule_crank` — успіх**, sig
`61cYveYL5wfa2bP8uyd7BP1uhrjMRodogkhfE1KHu59WwYJ3xZEfA9fxS3jx1ETCxk98LvgSPDdDcKzBwrDcD9A7`,
`task_id -8632762600545312817` (той самий, за формулою бріфу).

### Перевірка (b) — **ПОЗИТИВНА.** Планувальник реально тікає, без жодного зовнішнього скрипта.

Fallback-скрипт підтверджено незапущеним (`ps aux` порожній) протягом усього вікна. 8 замірів
`Market.mark`/`mark_slot` за **183 секунди** (`06:28:07Z` → `06:31:10Z`, з інтервалом ~15-20 с):

| час (UTC) | `mark` | `mark_slot` |
|---|---|---|
| 06:28:07 | 112448416 | 321821508 |
| 06:28:45 | 112381490 | 321825308 |
| 06:29:03 | 112362900 | 321827108 |
| 06:29:21 | 112361171 | 321828908 |
| 06:29:39 | 112353920 | 321830708 |
| 06:29:57 | 112391243 | 321832508 |
| 06:30:15 | 112411422 | 321834308 |
| 06:30:33 | 112424084 | 321836108 |
| 06:31:10 | 112392005 | 321839808 |

`mark_slot` монотонно зростає щоразу (жодного застрягання), сумарно **+18 300 слотів за 183 с ≈ 100
слотів/с**. `mark` — реальні, малі коливання EMA навколо ~$112.35–112.45 (не застигле значення й не
випадковий шум) — узгоджено з живим Pyth Lazer-фідом через MagicBlock Pricing Oracle. **Це перше
пряме підтвердження в цій сесії, що ER-планувальник Magic Actions самостійно виконує заплановані
`crank_tick`-виклики на `dexxer_core` без жодного зовнішнього fallback-процесу.**

**Планувальник лишено ПРАЦЮЮЧИМ** (не скасовано) — task_id `-8632762600545312817`, `iterations =
86_400` (~24 години за інтервалу 1000 мс).

### Баланс (кінець fix round 3 / Task 6 фінал)

`payer` **5.193960697 SOL** (один редеплой цього раунду, ~0.0047 SOL; `set_scheduler_signer` і
`schedule_crank` — ER/base-транзакції за рахунок `devnet-admin`, не `payer`).

### Підсумок Task 6 (усі три fix-раунди)

Обидві головні цілі задачі — (1) crank-fallback-скрипт як permission-member на devnet-tee, (2)
ER-планувальник тікає самостійно — **досягнуті й підтверджені реальними транзакціями**. Дорога до
(2) виявилась довшою за початковий рулінг (3 раунди, 2 незалежні on-chain властивості Magic Program
виявлено й задокументовано: per-authority `crank_signer_pda`, не глобальний `CRANK_SIGNER`; і
writable-non-delegated-акаунт заборонений у `ScheduleCrankCpi`'s `instruction_accounts`, розв'язано
переносом запису на базовий шар) — обидві знахідки задокументовані в коді (doc-коментарі
`crank.rs`/`admin.rs`/`state/config.rs`) і тут, з повним ланцюжком підписів для відтворюваності.

## Task 7: Мобільний скелет — TEE-з'єднання, session-стор, онбординг

Нові `app/src/lib/`-файли: `pdas.ts` (деривація seeds, скопійована з `tests/er/lib/program.ts`),
`program.ts` (`dexxerCoreProgram` з `ReadOnlyWallet`-заглушкою + ручні fixed-offset читання полів —
знахідка нижче), `er.ts` (`useTeeConnection()` — owner-нога через MWA `signMessages` +
`getAuthToken`), `session.ts` (`getOrCreateSessionKeypair` у `expo-secure-store`,
`teeConnectionForSession` для session-signed доступу, `sessionTopUpIx` — звичайний
`SystemProgram.transfer`, не `lamportsDelegatedTransferIx`, та сама причина, що в M2/M3/Task 5:
сесія не делегована).

Новий стейт-машин `useOnboarding.ts`: `Disconnected → NotOnboarded → Funded → Initialized →
Delegated → Credited → Permissioned → SessionSet`, кожен крок ідемпотентний (перевіряє on-chain
стан, пропускає зроблене) — дзеркалить `tests/er/devnet/01-onboard-private.ts`/`trader.ts`'s
послідовність один-в-один (faucet → `init_user` → `delegateSpl` → `delegate_user` →
`credit_deposit` → `init_permissions` → `set_session` → топ-ап сесії). `OnboardScreen.tsx` + новий
таб.

**Дві реальні знахідки на емуляторі (не в коді, який спочатку перевірявся — обидві знайдено й
виправлено в тій самій сесії):**
1. `@coral-xyz/anchor`'s `Program.account.<x>.fetch()` падає на Hermes/RN
   (`buffer-layout`'s `UInt#decode`, `readUIntLE is not a function`) — Anchor-бандл закриває власне
   посилання на буфер незалежно від `global.Buffer`. Виправлено: `polyfill.js` відновлює
   `global.Buffer` (загальна гігієна) + ручні fixed-offset Borsh-читання
   (`readConfigDusdcMint`/`readUserAccountSessionKey`/`readUserAccountFreeMargin`) в обхід
   Anchor-декодера. Побудова інструкцій Anchor-бандлом не зачеплена.
2. `Connection.confirmTransaction`'s websocket-підтвердження підвисає і на **base**-шарі
   `rpc.magicblock.app/devnet` (раніше задокументовано лише для ER) — `init_user`'s підтвердження
   зациклило `signatureSubscribe` попри те, що транзакція вже пройшла, зрештою OOM-крашнувши
   Metro. Виправлено: `sendL1` тепер поллить `getSignatureStatuses`, як і ER-шлях.

**Live-верифікація на емуляторі (Android AVD, реальний fakewallet, реальний devnet):** `faucet_init`
і `init_user` підтверджені живими підписами на ланцюгу, ідемпотентність `init_user` підтверджена
через рестарт застосунку. `delegateSpl` дійшов до MWA sign+send, але симуляція впала — root-caused
до вже задокументованого eSPL-обмеження (M4: цикл небезпечно перециклювати на тій самій
ідентичності), бо ідентичність емулятора вже проходила цикл раніше в сесії; повторна спроба зі
свіжою ідентичністю заблокована ненадійним `requestAirdrop` на devnet. `delegate_user` →
`SessionSet` **не досягнуто наживо** в цій сесії — позначено pending-human, той самий код-шлях, що
й для двох уже доведених кроків.

Повний звіт — `task-7-report.md`.

## Task 8: Мобільний скелет — Trade і Position

Розширює (не перебудовує) Task 7's `program.ts`/`pdas.ts`: `decodePosition`/`readPosition`,
`decodeMarket`/`readMarket`, `computeUpnl` (дзеркалить `math.rs`'s `upnl`, JS `bigint`-ділення вже
округлює до нуля — як Rust `i128`), `openPosition`/`closePosition` (підписуються **лише** session
`Keypair` локально, без MWA — `sendSessionTx`/`confirmOnConn`, той самий поллінг-патерн, що Task 7's
`sendL1`), `DEXXER_ERROR_MESSAGES` (усі 31 `DexxerError`-варіанти) + `describeTxError`.

Нові екрани: `TradeScreen.tsx` (Long/Short, size/margin, ліміт-ціна `mark × 1.01`/`× 0.99` —
дзеркалить `trade.rs`'s slippage-напрямок), `PositionScreen.tsx` (`useLiveAccount` —
`onAccountChange` **плюс** безумовний 1s poll, не лише fallback: TEE-конфірм-websocket
задокументовано ненадійний Task 7, а ≤2с свіжість потребує гарантії).

**Offset-деривації звірені і проти поточного Rust-коду, і проти живих devnet-байтів** (не лише
проти struct-арифметики): декодовано живий `Config` (`oracle_program`/`dusdc_mint` збігаються з
`tests/er/lib/env.ts`'s константами), живий `Market` (128 B, `mark = 0` — ринок ще не засіяний,
підтверджує, що `TradeScreen`'s guard "no mark price yet" — реальний, досяжний кейс, не мертвий
код), і **реальний `Position`** з попереднього прогону `01-onboard-private.ts` — задекодовано
`state=Closed, side=Long, size=0, margin=0, liq_price=0`, внутрішньо узгоджено з `finalize_close`'s
відомою поведінкою — незалежне підтвердження offset-арифметики на справжньому, раніше
Open-потім-Closed акаунті.

**Live-верифікація на емуляторі:** Trade/Position-таби рендеряться коректно (Long/Short-тумблер,
лімітна підказка перемикається правильно, стан "no session key" показано без крашу). **Повний
Friday-демо-шлях (onboard → Open без MWA-промпту → Position оновлюється ≤2с → Close) не досягнуто**
— той самий блокер, що й Task 7 (`requestAirdrop` ненадійний для свіжого гаманця), плюс окремо
підтверджено: застосунку's власна кнопка "Request Airdrop" на Account-табі теж падає
(`undefined is not a function`) — той самий клас багу, який Task 7 вже позначив як окрему,
недоторкану цю задачею територію. `openPosition`/`closePosition` не виконані жодним реальним
підписом у цій сесії — коректність спирається на звірений байт-у-байт IDL, доведений
Task 7-однаковий шлях підпису/поллінгу, і незалежно підтверджені offset'и вище.

Повний звіт — `task-8-report.md`.

## Тижень 2 — відкрите для тижня 3

- **`withdraw`'s коміт `UserAccount` ніколи не долетів до L1** (§7.1 ризик №13) — гроші рухаються
  коректно, база лишається застарілою. **Оновлено 21.09 з доків MagicBlock:** приватність у PER — це
  фільтр читання в TEE/QFS, не шифрування; на L1 фільтра нема, тож коміт сирого приватного акаунта
  знищив би приватність — TEE його не пропускає **за задумом**, це не баг. Рішення (§2.1 нове правило):
  сирий приватний акаунт ніколи не йде на L1; trustless-exit і 13F-розкриття будуються на окремому
  **публічному** commitment/root-акаунті (комітиться нормально, як `Pool`). Тиждень 3 стартує від цього
  дизайну, не від латання коміту. Лишилось одне уточнювальне питання до MagicBlock (звужене, §7.1 №13).
- **Планувальник запущено з кінцевим `iterations` (`86_400` тіків × 1 с ≈ 24 год)** (§7.1 ризик №18) —
  після вичерпання `Market.mark` застигає, поки не перезапустити `schedule_crank` чи `crank-fallback`.
  Костиль: `iterations: i64` без задокументованого «вічного» sentinel. Некостильне рішення вимагає виміру
  на devnet-tee (iterations-cap / task-persistence через рестарт валідатора / self-reschedule CPI), поряд
  із №13. Тимчасово — `crank-fallback` як завжди-онлайн шлях.
- **Спільний `FeeEscrow` — griefing surface** (§7.1 ризик №14): мітигований `MIN_WITHDRAW` +
  per-account cooldown, не усунений — sybil з багатьма акаунтами все ще може вичерпувати ескроу.
- **Реальна вартість fee-vault-комітів після nonce 25** не виміряна (§7.1 нотатка при рішенні (c),
  §8 питання 7) — виміряно лише nonce 11–22 (0 списання, очікувано).
- **Стародавні devnet `UserAccount`-акаунти зі старим layout лишаються стороненими** від кранка без
  міграції (§7.1 ризик №15) — одноразові тестові ідентичності, прийнято як сміття.
- **Повний мобільний цикл Open→Close не підтверджено наживо** (§7.1 ризик №17) — заблоковано
  devnet-airdrop-флакі і попередньо задокументованим Account-табним багом; шлях коду доведено
  ідентичним проти референс-скриптів.
- **`cancel_crank` перевірено, `mark_committed`/`reveal`/`write_commitment`/`write_disclosure`/
  `undelegate_user` — не реалізовані взагалі** (поза мандатом тижня 2, §2.2/§4.2 позначено явно).
- **`MarketRisk`'s bucket-структура й History/push/TEE-атестація в застосунку** — не в скоупі
  тижня 2 (не в скоупі жодного тижня досі).
- **Railway-деплой `crank-fallback`** — сам скрипт готовий (§7.1 ризик №3), деплой не зроблено.
- **CI** — не зроблено жодного тижня; лишається ручний гаунтлет перед кожним PR.
- **Uniform tx shape (ризик №4, мітигація (а))** — інструкції лишаються структурно різними;
  cover-traffic-мітигація (б) підтверджена, форма tx — ще ні.
