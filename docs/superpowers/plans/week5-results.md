# Тиждень 5 — результати

Надійність без relayer-а: ліквідації з планувальника всередині TEE. Гілка `week4-mvp-polish`
(база — `2f24c2a`), план — `docs/superpowers/plans/2026-09-23-week5-reliability.md`. Формат той
самий, що й у `week4-results.md`: виміряний підсумок для контролера й спеки, не заміна власних
task-звітів (`.superpowers/sdd/2026-09-23-week5-reliability/task-N-report.md`).

## Task 0: Спайк P3 — per-position scheduler

**Питання спайку.** Тиждень 4 довів, що єдиний глобальний розклад (`ScheduleCrank` без
`remaining_accounts`) може рухати лише `Market.mark` і ніколи не ліквідовує — акаунти задачі
фіксуються назавжди в момент реєстрації. Один розклад **на позицію** знімає саме це обмеження,
якщо планувальник MagicBlock підтримує шість речей, виміряних нижче.

**Де код.** `spikes/05-crank-tee/programs/crank-counter/src/lib.rs` (нові `init_escrow`/`init_slot`/
`delegate_slot`/`delegate_escrow`/`init_slot_permission`/`set_slot_privacy`/`set_flag`/
`schedule_slot_task`/`cancel_slot_task`/`slot_tick`), `spikes/05-crank-tee/w5-p3.ts`, скрипт
`npm run w5:p3`. Відображення на реальні сутності: `SlotCounter` PDA ≈ `Position`,
`slot.flag == 1` ≈ «позиція Open», `slot_tick` ≈ `crank_tick`, `escrow` PDA ≈ програма як
**авторитет задачі** (`ScheduleCrankCpi.payer` через `invoke_signed`, seeds `[b"w5escrow"]`).

**Прогін.** Devnet, program id `9pAYXKX2xwpsUhQFvW5rGVGRKmv9mTwpPLMGKgBHsv3q` (задеплоєний і
закритий у межах цієї задачі), деплой-tx
`2gbjigafJdiiwdJ5b4qz5DYNf21pM7276TcVHysaYkmsJVY1crQ4f4NvvgSLzFHVmrjsatEagB4Lc5tzydR66LnD`.
Акаунти: escrow `94XqVFF4Vr9PdKbaUAeWSXU6JLkhB8ZW19cY3cDbwdEW`; slot 0
`5ZXxQjuwqykA74qMH3jQAoawRCnPnVFNYmh6Cj1RFvpZ`, slot 1 `FRQU1qGviACwA9LmRhwfwyNBzMqtZiEWe4rnxaKbe9Eo`,
slot 2 `6VriKRKtzx6Mw1EmkBjYdLUPSRRcijdhqz3wbSmvsotn`, slot 3 (публічний контроль)
`Hi95ZHz1sxMAdK6LUk7XjYqozQVfABQDF4VpJGxFV7dB`. Слоти 0/1/2 — **приватні, members = `[owner]`**;
`crank_signer_pda(escrow)` свідомо НЕ член. Слот 3 лишено публічним як контроль «чи тікає задача
взагалі».

### Таблиця результатів

| # | Питання | Виміряна відповідь | Докази |
|---|---------|--------------------|--------|
| 1 | Чи тікають N паралельних задач (N = 3)? | **ТАК.** Три задачі з `interval 5000 мс`, `iterations = i64::MAX`, по одному акаунту кожна, тікали синхронно: **+16 тіків на кожну за 60 с** вікна (0→16/16/16), без взаємного блокування й без дрейфу між ними | schedule-tx: slot 0 `3jqCRMxWPNAa5HnEJBeCVwzgz9fnYFcNS2cnoL7zdqbHFmi9iUUXN59fpDopuYSyBLg6HTn2bEazM4nERWFyoLtU`, slot 1 `2BNphRYrFsvBfWqfv5vgsoCdUY5cKKyr3RZZQoycbsepQ5huLuTCL6ophtGqNpnKtaAmZaxDCU9k7oQS53ajHcyn`, slot 2 `5ruUpGskfkwgDRTqb2Tbn9pNuUGmtViPHYxrHFg2ZPgBXkdYU5bzZHkjU2ZERuoE9Rp8DUTL1qtR8FRPJqFdjQWq`. Семпли t+5…t+60 с: `s0 3,4,5,7,8,9,10,11,13,14,15,16` (те саме для s1/s2) |
| 2 | Скільки коштує реєстрація і тік, і з якого акаунта? | **0 лампортів, ні з якого акаунта.** Escrow ER-баланс `100 731 520` **не змінився** ні за 3 реєстрації, ні за ~136 тіків, ні за 3 cancel-и. Owner ER-баланс `2 769 463 697` теж без змін; owner base-баланс у ER-фазі без змін. Уся реальна вартість спайку — **base-layer**: 0.1358 SOL на init+prefund+делегування 5 акаунтів (deploy рахується окремо) | escrow ER lamports: `100731520 → 100731520` (реєстрація) → `100731520` (після тіків і cancel-ів, окремий 30-с пробник: `deltas {"ownerBase":0,"ownerEr":0,"escrowEr":0}`). Побічно виміряно: приватний слот тримає `6 102 288` лампортів проти `6 103 344` у публічного — різниця **1056** = `Member::SIZE (33) × EPHEMERAL_RENT_PER_BYTE (32)`, тобто рента на 2 членів `EphemeralPermission` платиться з самого slot-PDA |
| 3 | Чи проходить `CancelCrankCpi` з `authority = PDA` програми (`invoke_signed`)? | **ТАК, з першої спроби.** `CancelCrankCpi { authority: escrow PDA }` + `invoke_signed(&[&[ESCROW_SEED, &[bump]]])` прийнято; тіки скасованої задачі припинилися **миттєво й назавжди**, сусідня задача продовжила тікати | cancel-tx slot 0 `4AsBYgKomuHfyYv527FRXeVsLvr5dyUNgMZEGWUrsvPx56WwFt1EvWrVBk6tBU7NbBTyU4XmwN82E4m8FWDrhost`; за 25 с після: slot 0 `22 → 22` (Δ0), slot 1 `21 → 27` (Δ+6). Cleanup-cancel-и `3fbaJYcjMPVmTNEk995AuDGzBKN6hieyitYQgqjB1vGMX77NZWDJSvd2rsDt77gB1KveujBtZwytRMpgQTTxuukn` (slot 1) і `5PaoTs4ihv158aXA7Nrtb7u9Btsp8fa5wZUjTWmYTMVj9BULf9gbukQ3Kivga9QcPEfvEw9GcQ3iFfguXKr98bj6` (slot 2); контрольний пробник через 30 с — **0 тіків на всіх чотирьох слотах** |
| 4 | Чи видимий реєстр задач поза TEE? | **НІ, ніде.** `getProgramAccounts(Magic11111…)`: base RPC — **0 акаунтів**; TEE без токена — **2 акаунти**, і це лише `MagicContext1111…` та `MagicVau1t999…` (жодного per-task акаунта); TEE з owner-токеном — ті самі 2. `getProgramAccounts(Crank11111…)`: **0** з усіх трьох ендпоінтів. Тобто задачі взагалі не матеріалізуються як on-chain акаунти в цьому білді валідатора — реєстр живе у внутрішньому стані планувальника | `{"label":"Magic @ base RPC","count":0}`, `{"label":"Magic @ TEE, NO token","count":2,"sample":[MagicContext…, MagicVau1t…]}`, `{"label":"Magic @ TEE, owner token","count":2,…}`, `{"label":"Crank @ …","count":0}` ×3. Контроль приватності самого слоту: TEE без токена — `null`, TEE з токеном **чужого** гаманця — `null`, TEE з owner-токеном — видно; base RPC — видно (це L1-знімок **до** делегування, ticks=0/flag=0, очікувано) |
| 5 | Чи може `instruction_accounts` містити permissioned акаунт, членом якого scheduler-signer НЕ є — і чи виконається тік? | **ТАК, тік виконується.** Слоти 0/1/2 були private з `members = [owner]` (єдиний член); підписант тіку — `crank_signer_pda(escrow)` = `BvE3gsiR8sBkfVUN7WfgWNf8VcZQQbnf8gQCM5aQPond`, не член. Тіки все одно пройшли і **записали** приватний акаунт (+16 кожному). Гілка 5b (додати crank-signer у members і переміряти) **не знадобилася** — не виконувалась | `last_signer` після 60 с на **всіх** чотирьох слотах = `BvE3gsiR8sBkfVUN7WfgWNf8VcZQQbnf8gQCM5aQPond`; приватні слоти 0/1/2 Δ+16, публічний контрольний слот 3 — теж тікав. Це пряме розширення рулінгу 8 / ризику #23 (тиждень 3): TEE-permission-шар гейтить **читання через RPC**, а не інклюзію й записи транзакцій |
| 6 | Як деривується `task_context` для довільного `task_id`? | **Ніяк — деривації не існує, і вона не потрібна.** `task_context` у цьому білді — **інертний writable-плейсхолдер**: підходить БУДЬ-ЯКИЙ вже існуючий акаунт, який можна взяти writable; планувальник його не створює, не пише й не міняє власника. Неіснуючий акаунт (випадковий pubkey і здогадка `PDA(["task-context", le(task_id)], MAGIC_PROGRAM_ID)`) відхиляється на рівні верифікації транзакції. Один і той самий акаунт обслуговує **багато задач одночасно** — у прогоні всі 3 паралельні задачі + задачі виміру (6) використали `owner.publicKey` | Кандидат «owner wallet»: прийнято (`2zghiAdL9Jd42w1f4XZvHYVskPecqZCJmihhyitX79F2asZYUXqoHPLsDvQxL76kTiYGmur9JxBepBw4RULbUBp3`), +3 тіки, акаунт НЕ змінився: `lamports 2769463697 → 2769463697`, `dataLen 0 → 0`, `owner = 11111111111111111111111111111111`. Кандидати «випадковий pubkey» (`D919U7azcjcESb4u1oRktRoeSR1RgBZgeLwxyEoXMurW`) і `PDA(["task-context", le(task_id)], Magic…)` (`BVXcx1zuLwCYqHHQXf7SGAhGoAQpqYGTzaCW9gFt5C7i`) — обидва FAIL з точним текстом: `transaction verification error: Transaction loads a writable account that cannot be written` |

### Додаткові виміри (не питання брифу, але потрібні Task 3)

- **Авторитет задачі = CPI-payer, а не зовнішній підписант транзакції.** Зовнішню tx підписував
  `owner` (`4P1WD92z…`, `crank_signer_pda(owner) = CsYGwbuQZVzqnFi8gtWy9vSmD1N2V1M7scdkycy1eamE`),
  але `ScheduleTask` CPI платив escrow PDA — і планувальник дав тіку підпис
  `crank_signer_pda(escrow) = BvE3gsiR8sBkfVUN7WfgWNf8VcZQQbnf8gQCM5aQPond`. Тобто валідатор бере
  за `authority` **акаунт index 0 інструкції `ScheduleTask`** (= `ScheduleCrankCpi.payer`), і
  програма може бути повноцінним авторитетом задачі без жодного людського підписанта.
- **Тік по «закритій позиції» — безпечний no-op.** Після `set_flag(0)` на слоті 2 тіки **не**
  припинилися (`ticks 16 → 21` за 20 с), але гейтований лічильник **застиг** (`count 16 → 16`;
  фінально `ticks 57 / count 16`). Отже задача, яку забули скасувати, не ламає бухгалтерію — вона
  просто нічого не робить, доки акаунт існує і делегований.
- **Фактична частота трохи вища за запитану.** 16 тіків за 60 с при `interval 5000 мс` (очікувано
  ~12), з бурстом ~3 тіків одразу після реєстрації. Розраховувати на точний wall-clock інтервал не
  можна — це збігається з формулюванням `references/cranks.md`.
- **Реєстрація 3 задач не потребувала нічого понад те, що вже є в `dexxer_core`:**
  `instruction_accounts` подаються через `ctx.remaining_accounts` у порядку
  `[task_context, crank, <акаунти задачі>]`, inner-ix має рівно один підписант —
  `AccountMeta::new_readonly(crank_signer, true)`.

### Вартість devnet

| Момент | Баланс `spikes/keys/payer.json` (`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`) |
|---|---|
| до деплою | **5.061652297 SOL** |
| після деплою спайку (423 720 B, `--max-len` за замовчуванням) | 2.905327737 SOL (деплой = **2.156324560 SOL**) |
| після прогону вимірів (base-layer init/prefund/делегування 5 акаунтів) | 2.769463697 SOL (прогін = **0.135864040 SOL**) |
| після `solana program close` | **4.922835137 SOL** (повернуто 2.153376440 SOL) |

**Чиста вартість спайку — 0.138817160 SOL.** У ній лишилися замкненими ~0.126 SOL на делегованих
escrow/slot PDA (prefund 0.1 + 4×0.005 + рента): програму закрито, undelegate для цих акаунтів у
спайку не реалізовувався — свідомо, бо окремий білд+редеплой заради 0.126 SOL дорожчий за саму суму.

### Рішення

**Рішення після спайку P3:** **open-time** — реєстрація задачі в `open_position`, cancel у
`close_position` — бо всі чотири передумови саме цього варіанта виміряні позитивно: реєстр задач
не видно ні на L1, ні на TEE без токена (4), тож сам факт реєстрації не зливає «у цього юзера є
відкрита позиція»; cancel авторитетом-PDA працює (3), тож `close_position` закриває задачу без
людського підписанта; маржинальна вартість задачі й тіку — нуль (2), тож N задач масштабуються;
N паралельних задач тікають рівно (1). Init-time відпадає окремо й незалежно: акаунти задачі
фіксуються назавжди в момент реєстрації, а на момент `init_user` `Position` ще не існує — задача,
зареєстрована тоді, ніколи не змогла б вказати на правильний `Position`.

**Чи треба додавати `scheduler_signer` у members permissioned-акаунтів: НІ** (вимір 5) —
запланований тік із підписом `crank_signer_pda(authority)` успішно **пише** приватний акаунт,
членом якого цей підпис не є. Це те саме допущення, на якому вже стоїть увесь торговий шлях
тижня 4 (рулінг 8, ризик #23); Task 3 його не розширює, а лише продовжує спиратися на нього.

**Відкрите для Task 3** (не входило в брифові шість питань, тож не вимірювалося):

1. `task_id` має бути похідним від `Position` PDA — він валідатор-глобальний, а не per-program.
2. Осиротіла задача (cancel не пройшов, а `Position` уже закрито/undelegate-нуто) при
   `iterations = i64::MAX` тікатиме вічно з помилкою. Вимірювалося лише «акаунт існує, прапорець
   0» (безпечний no-op), а не «акаунт зник». Варіанти: скінченні `iterations` із поновленням,
   або залишати `Position` делегованим до успішного cancel.
3. Стійкість розкладу до рестарту devnet-tee — так само не виміряна (як і в тижні 3, M-D(3)).
