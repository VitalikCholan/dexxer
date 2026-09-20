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
