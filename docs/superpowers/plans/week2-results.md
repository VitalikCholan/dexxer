# Тиждень 2 — результати

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
