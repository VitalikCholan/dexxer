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
| 2 | Скільки коштує реєстрація і тік, і з якого акаунта? | **0 лампортів, ні з якого акаунта.** Escrow ER-баланс `100 731 520` **не змінився** ні за 3 реєстрації, ні за ~136 тіків, ні за 3 cancel-и. Owner ER-баланс `2 769 463 697` теж без змін; owner base-баланс у ER-фазі без змін. Уся реальна вартість спайку — **base-layer**: 0.1358 SOL на init+prefund+делегування 5 акаунтів (deploy рахується окремо) | escrow ER lamports: `100731520 → 100731520` (реєстрація) → `100731520` (після тіків і cancel-ів, окремий 30-с пробник: `deltas {"ownerBase":0,"ownerEr":0,"escrowEr":0}`). Побічно: приватний слот тримає `6 102 288` лампортів проти `6 103 344` у публічного — різниця **1056** = `Member::SIZE (33) × EPHEMERAL_RENT_PER_BYTE (32)`, тобто рента на 2 членів `EphemeralPermission` платиться з самого slot-PDA. **Ці два числа зняті ad hoc поза скриптом під час прогону** (перша редакція `w5-p3.ts` читала ER-баланси лише для escrow і owner); fix round 1 додав їх у скрипт — тепер фаза `q1` друкує `slotErLamports` (і `lamports` у кожному семплі), тож цифра відтворюється звичайним `npm run w5:p3` |
| 3 | Чи проходить `CancelCrankCpi` з `authority = PDA` програми (`invoke_signed`)? | **ТАК, з першої спроби.** `CancelCrankCpi { authority: escrow PDA }` + `invoke_signed(&[&[ESCROW_SEED, &[bump]]])` прийнято; тіки скасованої задачі припинилися **миттєво й назавжди**, сусідня задача продовжила тікати | cancel-tx slot 0 `4AsBYgKomuHfyYv527FRXeVsLvr5dyUNgMZEGWUrsvPx56WwFt1EvWrVBk6tBU7NbBTyU4XmwN82E4m8FWDrhost`; за 25 с після: slot 0 `22 → 22` (Δ0), slot 1 `21 → 27` (Δ+6). Cleanup-cancel-и `3fbaJYcjMPVmTNEk995AuDGzBKN6hieyitYQgqjB1vGMX77NZWDJSvd2rsDt77gB1KveujBtZwytRMpgQTTxuukn` (slot 1) і `5PaoTs4ihv158aXA7Nrtb7u9Btsp8fa5wZUjTWmYTMVj9BULf9gbukQ3Kivga9QcPEfvEw9GcQ3iFfguXKr98bj6` (slot 2); контрольний пробник через 30 с — **0 тіків на всіх чотирьох слотах** |
| 4 | Чи видимий реєстр задач поза TEE? | **НІ, ніде.** `getProgramAccounts(Magic11111…)`: base RPC — **0 акаунтів**; TEE без токена — **2 акаунти**, і це лише `MagicContext1111…` та `MagicVau1t999…` (жодного per-task акаунта); TEE з owner-токеном — ті самі 2. `getProgramAccounts(Crank11111…)`: **0** з усіх трьох ендпоінтів. Тобто задачі взагалі не матеріалізуються як on-chain акаунти в цьому білді валідатора — реєстр живе у внутрішньому стані планувальника | `{"label":"Magic @ base RPC","count":0}`, `{"label":"Magic @ TEE, NO token","count":2,"sample":[MagicContext…, MagicVau1t…]}`, `{"label":"Magic @ TEE, owner token","count":2,…}`, `{"label":"Crank @ …","count":0}` ×3. Контроль приватності самого слоту: TEE без токена — `null`, TEE з токеном **чужого** гаманця — `null`, TEE з owner-токеном — видно; base RPC — видно (це L1-знімок **до** делегування, ticks=0/flag=0, очікувано) |
| 5 | Чи може `instruction_accounts` містити permissioned акаунт, членом якого scheduler-signer НЕ є — і чи виконається тік? | **ТАК, тік виконується.** Слоти 0/1/2 були private з `members = [owner]` (єдиний член); підписант тіку — `crank_signer_pda(escrow)` = `BvE3gsiR8sBkfVUN7WfgWNf8VcZQQbnf8gQCM5aQPond`, не член. Тіки все одно пройшли і **записали** приватний акаунт (+16 кожному). Гілка 5b (додати crank-signer у members і переміряти) **не знадобилася** — не виконувалась | `last_signer` після 60 с на **всіх** чотирьох слотах = `BvE3gsiR8sBkfVUN7WfgWNf8VcZQQbnf8gQCM5aQPond`; приватні слоти 0/1/2 Δ+16 за те саме 60-секундне вікно. Публічний контрольний слот 3 у цьому вікні НЕ тікав (у таблиці семплів він стоїть на `3/3` весь час) — він відтікав **раніше**, у фазі (6), трьома скінченними ітераціями, і саме там довів, що запланована задача взагалі виконується; тому нульовий приріст приватних слотів був би відрізнений від «планувальник мовчить». Це пряме розширення рулінгу 8 / ризику #23 (тиждень 3): TEE-permission-шар гейтить **читання через RPC**, а не інклюзію й записи транзакцій |
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
| після `solana program close` | **4.922835137 SOL** (CLI: «2.15337644 SOL reclaimed»; приріст балансу — 2.153371440 SOL, різниця 5 000 лампортів — комісія самої tx закриття) |

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

---

## Task 4: Редеплой devnet, міграція, перші виміри, регресія 05/06/08/09

Гілка `week5-reliability`, коміти Tasks 1–3 (`26ee85a`…`40e0fbb`) виведені на devnet.
Program id `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, upgrade-authority
`spikes/keys/payer.json` (`4P1WD92zwtUB2jxYQJRvsQc4fLSDtergp6tvMyzMgGMM`).

### 1. Інвентаризація застарілого стану ДО апгрейду

Читано crank-токеном через `getProgramAccounts` на `devnet-tee` (рулінг контролера: спершу
інвентаризація, потім деплой).

| Акаунт | Кількість | Примітка |
|---|---|---|
| `UserAccount` | **24** | усі `version = 1`; розміри **150 B ×16**, **118 B ×4**, **110 B ×4** |
| `Position` | **24** | 6 `Open`, 2 `Closed`, решта `Empty` |
| `DisclosureQueue` | **24** | усі `len = 0` |

`UserAccount` v2 = **151 B** (`exited` додано в кінець), тож **жоден** із 24 акаунтів не
читається типізованою інструкцією після апгрейду. Два менші розміри — ще давніші лейаути
(118 B — без `exit_salt`, week 1–2; 110 B — ще й без `last_withdraw_slot`), тобто **8 з 24
акаунтів були непрочитними вже ДО тижня 5**, чинною (week-4) програмою.

Сума по всіх 24: `free_margin = 17 106 736 723` (17 106.7 dUSDC), `locked_margin = 80 000 000`
(80 dUSDC). `MarketRisk` до апгрейду: `oi_long = 448 252 365`, `oi_short = 0`.

**Закриття Open-позицій на СТАРІЙ програмі** (скрипт-одноразівка на IDL з `f2e293f`,
`close_position(signer, config, market, market_risk, pool_live, user_account, position, feed)`):

| Позиція | Власник | Ключ у нас? | Результат |
|---|---|---|---|
| `BRqThEwJzvtBUrGv2JpbB1FZMRmyfWUtJ74oimrayuop` | `9sTYJez…RoK33` | так (`devnet-trader-liq-1790145419498`) | **CLOSED** `55eo5oAnJq5tAaetqCBtypQL5tL22Bw82aLeFLR1EbvyCTCe35UcL968m4A3KxNQbX5YbUWHcYUdNLbQ7CsgeQ7r` |
| `6oR7VV6uoyogWyZYAfWbtPAVE7T8yhUvs8WU5ARKvx3B` | `Fn6ihxS…8msp7` | так (`devnet-trader-1790142260563`) | **CLOSED** `5yPyxJWbH97ZGvmcK2tJrrv68zcgtw2fZnWuWvsDUUpzTcqUXBHEa9fAybk5YakhgWY4SuGRXw5CrxMw8rXrVTsc` |
| `5AbTWnYKCuDXSnHYxuzEUBoi7kFBs2ASAw294ufRrHgs` | `GufA6yG…XPTrn` | так | **FAIL `0xbbb` (3003 `AccountDidNotDeserialize`)** — його `UserAccount` 110 B |
| `F7U8j2k2MJLhKpwNQixGdgfsMhSBiiSnKkn7LmVASBft` | `8Tax4NJ…2TLtK` | так | **FAIL 3003** — `UserAccount` 110 B |
| `DDYZWxYS9DS8dtEWfvwLEtoCTsk7KnTxRmv8J1Jz1ifr` | `CYAVxQz…7qwTH` | так | **FAIL 3003** — `UserAccount` 110 B |
| `A8dt5KAe16uCkSJKQJXMcMJrvJUW4mZxrZSgE8nZLP7d` | `Ddqoidm…D4rmU` | **ні** | не пробувано — ключа нема; `UserAccount` 118 B |

**Виміряний висновок, важливіший за сам рулінг:** 4 із 6 Open-позицій **неможливо було закрити
вже на старій програмі** — їхні `UserAccount` лишилися на лейауті тижнів 1–2 і стару програму
теж не проходять. Тобто «stranded» їх зробив не цей апгрейд. Вони застрягли назавжди з
`locked_margin = 4 × 20 000 000 = 80 000 000` і `oi_long = 448 252 365`
(110 404 645 + 110 004 104 + 110 268 611 + 117 575 005). Один із них (`A8dt5K…`) належить
гаманцю застосунку з живого смоуку тижня 4 — ключа в репозиторії нема.

`MarketRisk.oi_long` і `PoolLive.locked_total` після міграції лишилися рівно на цих числах
(`448 252 365` / `80 000 000`) — усі позиції тижня 5 відкрито й закрито чисто.

### 2. `extend` + деплой

| Крок | Баланс `payer` | Дельта |
|---|---|---|
| до `extend` | 4.922835137 SOL | — |
| після `solana program extend … 131072` | 4.256984377 SOL | **−0.665850760** |
| перша спроба деплою | 4.256984377 SOL | **FAIL**: `insufficient funds for spend (6.16121196 SOL)` |
| 3 × `solana airdrop 1` (кран `https://rpc.magicblock.app/devnet`) | 7.256984377 SOL | +3.000000000 |
| після `solana program deploy` | 7.250645579 SOL | **−0.006338798** |
| після 09 (`prefund trader 0.3 SOL` — цей скрипт платить із `payer`) | 6.950640579 SOL | −0.300000000 |

**Знахідка про вартість деплою.** `Data Length` 1 179 344 B < `.so` 1 212 664 B, тож `extend`
на 131 072 B був обов'язковий (стало 1 310 416 B) — це єдина **незворотна** витрата
(0.6659 SOL). Сам апгрейд коштує майже нічого (**0.0063 SOL**, буфер повертається), але
вимагає **6.16 SOL вільних на payer-і в момент виклику** — це рента буфера, яку CLI списує
наперед. Кран `api.devnet.solana.com` був порожній (`rate limit`), кран
`rpc.magicblock.app/devnet` видавав по 1 SOL із паузами. Три інші програми того ж авторитету
тримають 5.56 SOL (`Gn3Uvs…` 1.879, `2DvXCX…` 1.905, `6Tm2qG…` 1.772) — `solana program close`
брифом заборонено, тож їх не чіпали.

Деплой-підпис `3hDzZgGzZqZrcqn7w7XDMHcbcbpGwbwVovGCDpUzUMfZnoLYnVNMWFYJ1ptMmjGeUEVW1MmGkV8sjgzPKnKSGhm1`,
слот 503 069 579. Перевірено байт-у-байт: `solana program dump` → sha256
`343569b5d79a6a8cf98504791dda6569f39e7d11995df51bea195a7406163f54` == локальний
`target/deploy/dexxer_core.so`. `cmp target/idl/dexxer_core.json app/src/idl/dexxer_core.json` —
ідентичні.

Інші ключі: `devnet-crank` **0.1 SOL без змін** (тіки в ER безкоштовні, підтверджує вимір 2
Task 0), `devnet-fee-payer` **0.18841004 SOL без змін** (`commit_aggregate` платить із
делегованого `FeeEscrow`), `devnet-admin` 0.3507 → 0.2507 (три тестові трейдери по 0.05) →
+1 SOL із крана → 1.1007.

### 3. Бутстрап і `set_params`

`npm run devnet:bootstrap` — **повністю ідемпотентний**, жодного `init_*` не повторив
(`init_config/init_market/init_pool/init_pool_live/init_fee_escrow/init_balances_root/
init_market_permissions` — усі `exists, skipped`; делегування — `already delegated, skipped`;
action-escrow і rent-надлишок `MarketRisk`/`PoolLive` — вистачає).

`liq_hysteresis_ticks 2 → 3` (дефолт змінив Task 3; на devnet `Market` лишалося 2):
`set_params` в ER, підписано `devnet-admin`, сиг
`4BbcAZdAXtdpTXK6saX9sktZYHRMaxa2RZ4pRzyWreNLRokDFZ6tQZsS8jwDohnWWWf3e8NEsjK9uAk6npti1jsY`.

Для цього додано `tests/er/devnet/10-set-params.ts` (`npm run devnet:setparams -- KEY=VALUE`):
`set_params` бере **всю** структуру `MarketParams`, тож скрипт читає живий `Market`, накладає
лише названі поля й шле назад. Це не косметика — на devnet `max_conf_bps = 0` (навмисно,
знахідка тижня 2: реальний Pricing Oracle віддає `conf == 0`), і наївний виклик із
`MARKET_DEFAULTS` мовчки повернув би його на 50 й зламав торгівлю.

Живі параметри після міграції: `max_lev_bps 100000, imr_bps 1000, mmr_bps 500,
open/close_fee_bps 6/6, liq_fee_bps 100, oi_cap 0, max_position 100000000000, min_size 10000000,
max_staleness_secs 2, max_conf_bps 0, max_deviation_bps 200, ema_alpha_bps 3000,
liq_hysteresis_ticks 3, max_stale_ticks 30`.

### 4. Виміри (a)/(b)/(c) — `npm run devnet:liqtask` (`devnet/11-liq-task-migration.ts`)

Трейдер `CgRmYr96f2vSpGubuVgomA8KCUkRkVPDD8szQBfipQLx`, позиція
`5QNy1vL7hCTSCfnqqiqSKtPd8BXChJMX7LuCtMdLQ4T8`, `task_id = 11513052046185142512`
(`keccak256(position)[0..8]`, big-endian).

**(a) Скасування НЕВІДОМОГО `task_id` — PASS, блокера нема.**
`close_position` (`3gA8BN3aNGuaHw4k4ngPz295AWKKUx1RRMj1Us6UTkACru8BAxs9qwRX9mEq5GxNzFFhrVZetPWVqga3zu3eGod2`)
скасував живу задачу; `undelegate_user`
(`678FK1ifmgv5V7n7ki2BnA1H9RPEoTx4Xnvcy47xrjizk6sEHASchjWwHu35XbsYiyvvL9s5Qb66QNFY7Eu3bJBk`)
скасував **той самий id вдруге**, коли його вже не існує — і пройшов. Тобто `CancelCrankCpi`
на невідомий `task_id` — **не помилка** для цього валідатора. Ризик M-I закрито: безумовні
in-path cancel-и в `close_position`/`decrease_position`/`undelegate_user` лишаються як є,
запасний план (окрема `cancel_liq_task` + другий апгрейд) не потрібен.

**(b) Реєстрація `liquidation_check` у `open_position` — прийнято; прямих логів нема.**
`open_position`
(`gGvqoyRw2894PDcmXiEwRLsaiSz9vZRiMnCSWRTK4ST2yXLy1bunEvr3ASNcqBFZDfEm5uVWDobjEH5iPzfLH4d`)
пройшов із `task_context == position` (дубльований ключ в одному списку акаунтів) і
`liq_crank_signer = crank_signer_pda(fee_escrow)`. CPI `ScheduleTask` в `open_position`
безумовний (гейт лише `magic_program.executable`, істина на devnet-tee), тож відхилення
реєстрації або дубльованого ключа завалило б усю інструкцію.

> **Нова знахідка devnet-tee: для ER-транзакцій TEE не віддає ні логів, ні CU.**
> `getTransaction` повертає `computeUnitsConsumed: 0` і **порожній** `logMessages`;
> `simulateTransaction` теж без логів (`unitsConsumed: 0`). Разом із виміром 4 Task 0
> (реєстр задач невидимий із жодного ендпоінта) це означає, що **доказ «задача зареєстрована»
> може бути лише поведінковим**. Повний поведінковий доказ (тік справді ліквідовує) — M-G′
> у Task 7; тут він свідомо не робився, бо ліквідація НЕ скасовує задачу
> (`crank_tick`/`liquidation_check` не скасовують за задумом), і тоді (a) вимірювався б на
> живому, а не невідомому `task_id`.

**(c) Вихід із боргом розкриття — PASS, але форма не та, що очікувалась.**
`undelegate_user` при `dq.len = 1`:

| Акаунт | L1 після | ER, crank-токен | ER, owner-токен |
|---|---|---|---|
| `UserAccount` | `G2okX5…` (розделеговано), `version = 2`, `exited = true`, 151 B | — | — |
| `Position` | `G2okX5…` (розделеговано) | — | — |
| `DisclosureQueue` | `DELeGGvXpWV2…` (**лишився делегованим**) | **читається**, `len = 1` | **`null`** |

Тобто осиротіла черга **невидима власникові** — `undelegate_user` звужує її
`EphemeralPermission` до `members = [crank]`, і owner-токен отримує ту саму відповідь, що й
чужий гаманець. Сигнал-осиротілість, на який спирається `close_orphan_queue` (Task 2),
видно **лише крану** — що якраз і правильно, але наївна перевірка «`getAccountInfo` == null
для UA/Position» **не працює**: розделеговані акаунти не зникають з ER, вони повертаються
туди звичайними акаунтами під `dexxer_core`. Скрипт 11 перевіряє саме п'ять фактів із таблиці.

### 5. Регресія

| Скрипт | Результат | Ключові підписи / зауваження |
|---|---|---|
| `devnet:liquidation` (05) | **PASS** | ліквідація за **6.4 с**, `liq_ticks [0,2,2,0]`; open `3UMpYLpk74BMuWXpJhttuR7oWiPqeZx2XDApENtzJa7UwvZ3nXwUybbXmDqx3K9sTYcvYwAAgLPo3fMuuxqPwWZf`, `set_params(mmr=9500)` `5Ykc7ssFwntaJ8A32p4ihtGo3eK4KtzzjmbndQ3eZ31vWJwDKU5a5zsmZYneCgBbgWVU1mEiucR8hDChgLxPHESB`, restore `5mwNKV381WnC5VDEtNeVTYHPY7LdxYgjSB421Qk2z6e8DFdHgvH9V1XkrdDh9NkaHos6v6oYXgiNhhp8XEbR9BVB` (параметри відновлено 1-в-1). Ліквідував **локальний** relayer трійками: тік `2KrAEopAvcX28bXo4VX2LCRn6XBbiYmKiJQy7r4uG5hXx92EHNweeu9QFJi7gwvRsNWA3fmXZPm9Yzq755PWgB5F`, **CU 43 294** проти 15 4xx на порожньому тіку |
| `devnet:disclosure` (06) | **PASS** (після правки, див. нижче) | **ОДИН** `commit_aggregate` `4p1XzXRmWLkZR4J5vzRtbrJgn2D8otAa5x9QZ2uBAo3dG1nXYjx8P8jS12UaxykB2B4V9qZ4mFpfEmWyRtqksamp` → `Commitment` на L1 за 3.4 с, `Disclosure` за 3.5 с, `dq.len 1 → 0`. Усі 12 полів `Disclosure` збігаються з `ClosedRecord`, хеш переобчислено |
| `devnet:undelegate` (08) | **PASS** | drain одним bundle `2UFin4zNfukVY2mgzstmZtM8heso7pGQ7tg1dPYFa9VgiX9VwworDKoSPMftwU6Q7fqt2ws7HtBowxp7CP5eRc7u`, `withdraw` `2P8VXMkjzcrQCZrQC7NnUtmH277wx5drYspnH6zxEMdPtdkunXdv2q5JJJf2YLg4oP1XH7EVGKBZsFpvpFV9SMFi`, `undelegate_user` `5F2aAJoWk55CjsVtbmr8EmGYhJXRcU6yudu9xkAfqLLaiYAfGHbvEpaCDRWwYxqzeSzo2BjcCUt5VQEHcTYZc4tu`; owner-flip на базі за **4.1 с**, скраб перевірено |
| `devnet:snapshot` (09) | **PASS** | `open` `4qiqqZoDV58HSJTgRpuQi6Qj9JJRERQWWmzNDa5X5tqyEBKJCXPd9Lm9BnktBtZbBwrRCtXgggkqH1nViMdppyyn`, `commit_aggregate` `5jZreGkaUVT6NSy6rvo4XekNu1TzXx1zMdKaYaj82tfsRzR2wTNH2vF3hGvuWNCMaTK2zmWSEpdAYQLy2BTCeo4m`; `Pool` не змінився на open, `PoolLive.locked_total +20 000 000` рівно на маржу, огрублення знімка тримається, `PoolLive`/`MarketRisk` чужому токену — `null` |

**Правка, без якої 06 і 08 не мали шансу пройти: `reveal_after_slot` — це слот ER, а не бази.**
`ClosedRecord.reveal_after_slot` штампується `Clock` всередині ER, і лічильник ER **не має
нічого спільного** з базовим: виміряно **ER ≈ 343.4 млн проти base ≈ 503.1 млн**, і ER іде
**~80 слотів/с** проти ~2.5 у бази. Обидва скрипти чекали `revealAfterSlot` на `baseConn` —
тобто порівнювали два різні лічильники й поверталися миттєво. Виправлено на опитування ER
(`waitForErSlot`). Побічний наслідок цього ж факту: `Config.disclosure_delay_slots = 100` — це
**~1.2 секунди**, а не 40 с.

**`disclosure_delay_slots = 0` встановити не вдалося** — поле пишеться **лише** в `init_config`,
сеттера в програмі нема, а `Config` на devnet існує з тижня 1. Вимогу брифу («при delay 0 —
`Disclosure` на L1 після ОДНОГО `commit_aggregate`») перевірено по суті при delay 100: обидві
дії (`write_commitment` + `write_disclosure`) вийшли **з одного bundle**, черга спорожніла в
тій самій транзакції. Окремої інструкції `set_disclosure_delay` бракує — див. відкрите нижче.

**Старий relayer на Railway зламався рівно так, як передбачалося** (він досі на коді `main`):
під час 05 його `crank_tick` ліг з `Custom 6026 = InvalidCandidate` (парами замість трійок) —
`5iVDaq4ZF378g5NqX4BUiCnc5EG6n7nZyRZtT5BXRifoSVkDq2Gu7y7FwuEyCtVHE13bjBHWict6HepT1aegyLfw`
та десятки таких самих о 18:30 UTC. Поза цим вікном він тікає нормально
(`candidates=0`): єдині Open-позиції на ринку — 4 застряглі legacy, і він їх пропускає з
`failed to decode (stale layout?)` — тобто **поведінка Task 2 «крank пропускає v1»
підтверджена на живому сервісі** (і старим, і новим кодом). `Market.mark` не застигав жодного
разу. Relayer у цій задачі НЕ передеплоювався (Task 5).

### 6. Відкрите після Task 4

1. **Немає `set_disclosure_delay`.** `Config.disclosure_delay_slots` пишеться раз, в
   `init_config`; змінити демо-затримку без реініту `Config` неможливо. Однорядкова
   admin-інструкція (`AdminConfig`-патерн, як `pause`/`set_scheduler_signer`) — кандидат у
   наступний апгрейд.
2. **Осиротіла задача після ліквідації.** Ліквідація не скасовує `liquidation_check` (за
   задумом — скасувати може лише `undelegate_user`), тож позиція 05
   `6VQQqtWN9DGzJUa3amwoVGSpYmCNZVBt4MJhVAdEnNij` лишилася з живою задачею, яка тікатиме
   вічно як no-op (`iterations = i64::MAX`). Матеріальної шкоди нема (вимір Task 0: тік по
   «закритій» позиції — безпечний no-op, коштує 0), але кількість таких задач монотонно росте.
3. **4 застряглі legacy-позиції** (`oi_long 448 252 365`, `locked_total 80 000 000`) —
   непрочитні жодною чинною інструкцією, ключа на одну з них нема взагалі. Або жити з
   постійним зміщенням OI/locked на devnet, або окрема crank-інструкція «списати позицію з
   нечитабельним `UserAccount`» (сирі байти, без типізації) — не в скоупі тижня 5.
4. **Логів і CU для ER-транзакцій на devnet-tee нема** — будь-який майбутній вимір, що
   спирається на `logMessages`/`computeUnitsConsumed` в ER, треба одразу планувати як
   поведінковий. (CU, що фігурує в цьому звіті — 15 4xx/43 294 — relayer знімає зі СВОГО
   `crank_tick` через власний шлях, не через `getTransaction` TEE.)
5. **Апгрейд дорожчий за суму витрат:** кожен наступний деплой вимагає ~6.2 SOL **вільних**
   на payer-і (рента буфера, повертається). На devnet це вирішується краном
   `rpc.magicblock.app/devnet` по 1 SOL — планувати заздалегідь.
