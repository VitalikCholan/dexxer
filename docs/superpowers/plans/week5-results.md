# Тиждень 5 — результати

Надійність без relayer-а: ліквідації з планувальника всередині TEE. Гілка `week5-reliability`
(мердж-база `main` — `f2e293f`), план — `docs/superpowers/plans/2026-09-23-week5-reliability.md`.
Формат той самий, що й у `week4-results.md`: виміряний підсумок для контролера й спеки, не заміна
власних task-звітів (`.superpowers/sdd/2026-09-23-week5-reliability/task-N-report.md`).

## Підсумок тижня 5

Коміти `144dc1f..a6d5623` (23 коміти на гілці `week5-reliability`, мердж-база `f2e293f`). Мета —
надійність без relayer-а як єдиної точки відмови: ліквідації з планувальника, коротший reveal,
вихід з боргом розкриття, 0-SOL онбординг. Порядок виконання — Task 0 (спайк) → Tasks 1–3
(програма) → Task 4 (редеплой + виміри) → Task 5 (другий апгрейд + relayer) → Task 6 (застосунок)
→ Task 7 (виміри M-G′/M-H/M-J/M-I/M-K + fix дефекту бриджу) → Task 8 (ця документація).

**Що зроблено, по шарах.**

- **Програма** (`programs/dexxer_core`, program id незмінний
  `G2okX5Bae4CxfK8vzso1Ecc96QUv7E3P4YvxaZnaYXoV`, 2 devnet-апгрейди): close — queue-first
  (`finalize_close` штовхає `ClosedRecord` у `DisclosureQueue`, `Position → Empty` одразу,
  `Position.closed` завжди `None`, поле лишено в лейауті); `commit_aggregate` бере дії з черги —
  спершу `write_commitment` (прапорець `commitment_written` перемикається на записі в ER), далі
  `write_disclosure`, `MAX_ACTIONS_PER_COMMIT = 8` як програмна стеля; `mark_committed`/
  `MarkCommitted`/`pending_commitment` видалені; кандидати `crank_tick` — трійки `[Position,
  UserAccount, DisclosureQueue]`, повне кільце пропускається (`continue`), недекодовний v1
  `UserAccount` пропускається; `Trade` несе `disclosure_queue`/`fee_escrow`/`task_context`/
  `magic_program`/`liq_crank_signer`; `UserAccount` v2 (`exited: bool` у кінці); частковий
  `undelegate_user` (черга лишається делегованою, `members = [crank]`); `close_orphan_queue`
  (ER, crank; сигнал сирітства — `UserAccount` відсутній/чужий АБО присутній з `exited == true`);
  `close_exited_user` (base, fee_payer, закриває три PDA разом); `init_user_reuse_queue`;
  `set_disclosure_delay` (admin); `liquidation_check` — задача планувальника на позицію,
  реєструється в `open_position` (payer/authority — `FeeEscrow` PDA, `task_id =
  keccak(position)[0..8]`, інтервал 5000 мс, `iterations = i64::MAX`, підписант тіку —
  `crank_signer_pda(fee_escrow)`, **не** `Config.scheduler_signer`), скасовується в
  `close_position`/повному `decrease_position`/`undelegate_user` (cancel невідомого id —
  безпечний no-op, виміряно); `DelegateUser.payer`; дефолт `liq_hysteresis_ticks` 2 → 3; нові
  помилки `LiquidationTaskFailed 6041`, `NotExited 6042`, `QueueStillPending 6043`. LiteSVM
  71 → 87, unit 55 → 61 (`cargo test -p dexxer_core 2>&1 | grep "test result"` → `61 passed`,
  fix round 1 re-verified; grep для літерального `#[test]` знаходить лише 60 — 61-й тест
  живе всередині `proptest! { ... }`-блоку в `math.rs`, макрос генерує `#[test]`-обгортку, яка
  не містить літерального атрибута в джерелі, тож текстовий grep його не бачить).
- **Relayer** (`services/relayer`, живий на Railway): disclosure-цикл queue-first (найстарший
  борг першим, з rotation), `COMMIT_INTERVAL_TICKS` (env, живе значення `60`),
  `COMMIT_MAX_ACTIONS` (env, живе значення `4` — місток відхиляє реальні 8 дій, виміряно),
  halve-and-retry, `QuarantineState` (карантин отруєних черг), `orphan.ts`-janitor (ER
  `close_orphan_queue` → base `close_exited_user`, пропускає черги, чиє розделегування вже сіло
  на базу), стейлнес оракула за `publish_time`, `/sponsor`-whitelist `{faucet_init, init_user,
  init_user_reuse_queue, delegate_user}` за формою акаунтів `{owner idx 0, payer idx 1}`, ATA
  `{payer idx 0 = fee_payer, owner idx 2 = owner-підписант}`, eSPL-shapes; гілку
  `SystemProgram`-топ-апу видалено разом з `SPONSOR_ALLOW_SESSION_TOPUP`. Тести 61 → 100.
- **Застосунок**: 0-SOL онбординг (ATA/faucet/init/делегування — платить `fee_payer`, ER-леґ
  залишається owner-funded, але виміряно за ~0 лампортів на живих 0-SOL гаманцях),
  `init_user_reuse_queue`-шлях, `mwaAuth.ts` — identity-хешований auth-token з `deauthorize` при
  зміні identity/дисконекті (усі точки входу централізовані), History = записи черги +
  L1-розкриття (`Position.closed` більше не джерело), Exit-чеклист — «немає відкритої позиції» +
  «баланс виведено» + інформативно «N угод розкриються після виходу», копі «No SOL needed —
  account rent is sponsored».

**Траєкторія тестів.** LiteSVM **71 → 87 → 89** (останні два — фінальна фікс-хвиля, §нижче), unit (`cargo test -p dexxer_core`) **55 → 61**,
relayer (`node --test`) **61 → 100 → 102** (Task 1 довів до 61, Task 5 — до 75, Task 7 — до 100, фінальна фікс-хвиля — до 102, через
quarantine/rotation-тести й e2e-шов).

**Devnet-апгрейди й вартість (SOL, `spikes/keys/payer.json`, Task 4/5):**

| Апгрейд | Причина | Вартість | Зауваження |
|---|---|---|---|
| #1 (Task 4) | Tasks 1–3: queue-first close, exit-with-debt, per-position scheduler | `extend` **0.665850760** (незворотно) + деплой **0.006338798** = **0.672189558 SOL** | вимагав **6.16 SOL вільних** у момент виклику (рента буфера, повертається); `Data Length` 1 179 344 B < `.so` 1 212 664 B → `solana program extend … 131072` обов'язковий |
| #2 (Task 5) | Прелюдія: сигнал сирітства `close_orphan_queue` (виміряно зламаним у Task 4) + `set_disclosure_delay` | **0.006015 SOL** | `.so` 1 213 624 B ≤ вже розширеної довжини 1 310 416 B → `extend` не знадобився |

Разом два програмних апгрейди тижня 5 коштували **≈0.678 SOL** (переважно одноразовий `extend`).
Окремо — спайк Task 0 (`spikes/05-crank-tee`, власний тимчасовий program id, закритий у межах
задачі): чиста вартість **0.138817160 SOL**.

**Виміряні істини (Task 7, `tests/er/devnet/13–15-*.ts`):**

| Вимір | Результат | Джерело |
|---|---|---|
| M-G′ — ліквідація без relayer-а (`CRANK_ENABLED=false`, лише планувальник у TEE) | **PASS**, **6.97 с** до ліквідації (`liq_ticks [0,2,0]`) | §Task 7.1 |
| M-H — Close → L1 `Disclosure` за один цикл (`disclosure_delay_slots=0`, `COMMIT_INTERVAL_TICKS=60`) | **PASS по суті** — обидва PDA (`Commitment`/`Disclosure`) існують на L1, точний момент landing-у невідомий (post-hoc підтверджено, скриптовий 100-с таймаут — FAIL за власним вердиктом скрипта) | §Task 7.2 |
| M-J — Close→Open той самий слот негайно; 9-те закриття при повному кільці | **PASS** (reopen за 1.7 с) + **PASS** (`Custom 6023 QueueFull`, `Position` лишилась `Open`) | §Task 7.3 |
| M-I — 0-SOL гаманці: онбординг → торгівля → exit з боргом → janitor-реклейм | **PASS** для обох гаманців (0 лампортів протягом усього циклу, включно з ER-леґом) | §Task 7.4 |
| Cap реальних дій бриджу MagicBlock | виміряно **8 FAIL / 4 PASS** на реальній формі дій (не синтетичний спайк тижня 3) — дефолт relayer-а `COMMIT_MAX_ACTIONS=4` | §Task 7.0 |
| Сигнал сирітства `close_orphan_queue` | старий `data_is_empty() \|\| owner != crate::ID` — **завжди хибний** на devnet-tee (ER віддає розделегований акаунт як клон бази, `owner == crate::ID`); новий — `exited == true`, коли акаунт присутній, АБО відсутній/чужий | §Task 4.4(c), §Task 5.1 |

**Дайджест рулінгів** (усі `Ruling`-рядки контролерського леджера
`.superpowers/sdd/2026-09-23-week5-reliability/progress.md`, що впливали на дизайн — що
вирішено / чому / ціна помилки):

1. Тестові лічильники в брифі — орієнтир, не ворота приймання (назви тестів відрізняються) — ціна: нуль.
2. Заборону агентам запускати емулятор (правило тижня 4) знято користувачем 23.09 на тиждень 5 — ціна: нуль.
3. «Повторний `undelegate_user`» з фокусу ревʼю Task 2 покритий наявним тестом
   `undelegate_with_pending_disclosures_keeps_queue`, окремого тесту не додано — ціна: пропущений
   edge-case подвійного виходу, пійманий пізніше на devnet (M-I).
4. Повне кільце ліквідаційного кандидата — crank пропускає його (`continue`), не абортує весь
   батч; relayer шле не більше 8 кандидатів за транзакцію (`CRANK_TX_MAX_CANDIDATES`), програмний
   `MAX_CANDIDATES` лишається 16 — ціна помилки: недоліквідований full-ring трейдер (поганий борг)
   до Task 2/3.
5. `init_user_reuse_queue` — `mut`-переініціалізація трьох PDA (гейт `exited == true` /
   `Position::Empty`), не `init` (PDA після розделегування існують, скраблені, не закриті) — ціна
   помилки: повторний онбординг ламається на devnet M-I, лагодиться одним редеплоєм.
6. Legacy `UserAccount` v1 (на байт коротший), що не десеріалізується в кандидатах кранка —
   `msg!` + `continue`, не абортує батч.
7. `close_queue_l1` з брифу замінено на `close_exited_user` (база, `fee_payer`, закриває всі три
   PDA разом, гейт — `exited`/нульові баланси/`Position::Empty`) — ціна помилки: один редеплой;
   `orphan.ts` (Task 5) мусив цілитись саме в `close_exited_user`.
8. `delegate_user` вимагає `!exited` (ручна десеріалізація) — не можна ре-делегувати вихідний акаунт.
9. Окремої інструкції міграції v1 не буде; Task 4 інвентаризував v1-акаунти з відкритими
   позиціями на devnet і закрив їх на СТАРІЙ програмі до апгрейду.
10. `close_orphan_queue` лишається crank-only, доки сигнал сирітства не виміряний на devnet
    (M-I); permissionless-варіант — після.
11. `task_context` = `Position` PDA (фолбек — гаманець owner-а); `Trade` отримує
    `scheduler_signer` останнім полем; `cancel_liquidation_task` — і в `undelegate_user`; шляхи
    ліквідації задачу ніколи не скасовують — ціна помилки: осиротіла задача тіка́є вічно як
    безпечний no-op (0 лампортів в ER, виміряно), або exit падає на cancel невідомого id
    (перевірено в Task 4 — PASS, не падає).
12. Дефолт `liq_hysteresis_ticks` 2 → 3 (два незалежних джерела тіків — crank і планувальник) —
    ціна помилки: ліквідація на один crank-секунд пізніше.
13. Task 4 спершу вимірює (а) cancel невідомого `task_id`, (б) exit/close з cancel, і лише потім
    деплоїть далі; запасний план на випадок помилки — прибрати in-path cancel-и + окрема
    admin-інструкція `cancel_liq_task`, другий апгрейд — ціна: ≈0.03 SOL і час (не знадобився,
    (а)/(б) — PASS).
14. Проміжний стан «спонсорований онбординг не повний до Task 6» прийнятий свідомо — Task 5/6
    несуть його далі в брифах.
15. Зберігання liq-crank-signer-а в `Config` відкладено до фінального ревʼю гілки (потребує зміни
    лейауту `Config`).
16. Сигнал сирітства `close_orphan_queue` замінено на `exited == true` при присутньому акаунті
    АБО відсутній/чужий власник — програмний патч + LiteSVM-тест + другий апгрейд, зв'язані в
    прелюдію Task 5.
17. Адмінська `set_disclosure_delay` додана в той самий (другий) апгрейд — потрібна для демо M-H
    (`delay=0`).
18. 4 застряглі legacy-позиції (недекодовний `UserAccount`, одна без ключа в репо) прийняті як
    devnet-сміття, бeклог тижня 6 — ціна: постійне зміщення `oi_long`/`locked_total`.
19. Бриф-текст `close_queue_l1` → `close_exited_user` скрізь; `COMMIT_INTERVAL_TICKS=60` на
    Railway на весь тиждень (демо M-H); цикл сирітства — спершу ER (`close_orphan_queue`,
    crank), потім base (`close_exited_user`, `fee_payer`).
20. Нумерація devnet-скриптів 10–12 у плані вже зайнята — Task 7 узяв 13/14/15
    (`liquidation-check`/`close-reopen`/`exit-debt`).
21. Relayer отримує `COMMIT_MAX_ACTIONS` (дефолт 4, clamp `[1, 8]`) і halve-and-retry по бюджету
    дій, не по кількості черг; програмна стеля `MAX_ACTIONS_PER_COMMIT=8` лишається
    задокументованим верхнім клампом.
22. Корінна причина застряглої черги — гіпотеза ризику #26 (`commitment_written` піднявся, а
    `write_commitment` не долетів) **перевірена й спростована** (6 з 6 `Commitment`-PDA існують
    на базі); relayer отримує карантин/ротацію того ж вечора.
    **ОНОВЛЕНО 24.09.2026 (фінальне ревʼю, C1 — механізм знайдено, дефект закрито).** Рулінг
    зупинився на «механізм невідомий» передчасно: він лежав у власному дифі тижня. До апгрейду
    #3 `commit_aggregate` **не мав аргументів** — `room` брався прямо з
    `MAX_ACTIONS_PER_COMMIT = 8`, тож ОДНА черга з повним кільцем завжди емітила всі свої 8 дій,
    хоч би що просив клієнт (`COMMIT_MAX_ACTIONS` обирав лише *які* черги йдуть у бандл). Саме
    тому halve-and-retry був no-op для однієї черги (`selectCandidates(pending, 4)` і
    `(pending, 2)` повертали той самий `[queue]` → байт-у-байт та сама tx), і саме тому «падало
    на кожному бюджеті 8→1». `HgvCy4r2…` мала рівно 6 due + 2 незакомічені = **8 дій**;
    8 реальних дій — виміряний FAIL бриджу, 4 — PASS. Фікс: `commit_aggregate(max_actions: u8)`,
    clamp `[1, MAX_ACTIONS_PER_COMMIT]` (апгрейд #3, сиг `eXAtUAVt…`), relayer передає
    `COMMIT_MAX_ACTIONS` як аргумент і халвить його ж на `0xA0000002`. Доказ — нижче.

(Операційний рулінг поза дизайном: місячний ліміт витрат на opus вдарив під час Task 5 → подальші
імплементери диспетчерились на sonnet із повнішими брифами, ескалація на opus лише для
fix-раундів ≥4 — ціна: більше раундів ревʼю.)

**Відкриті ризики → тиждень 6.** ~~Застрягла отруєна черга `HgvCy4r2…`~~ **ЗАКРИТО 24.09.2026**
(фінальне ревʼю C1 + апгрейд #3 — див. рулінг 22 і §«Фінальна фікс-хвиля» нижче: черга
дренувалася 8 → 6 → 2 → 0 за три цикли, усі 8 записів на L1); з нею re-rated і
недоліквідований full-ring трейдер — повне кільце більше не термінальний стан, `QueueFull` знову
тимчасовий (архітектурно можливий борг лишається, але як «трейдер чекає цикл», не «назавжди»);
**нові (фінальне ревʼю):** #37 — `due_reveals` знімає запис із черги в тій самій ER-tx, що лише
*планує* L1-дію: якщо дія не долітає, 13F-запис втрачено без ретраю (гостріше при
`disclosure_delay_slots = 0`, де commitment і reveal в одному бандлі); #38 — у гістерезису немає
per-sample гарду: повторні виклики в одному слоті можуть ліквідувати за ОДНИМ семплом mark
(підписант довірений, тож не експлойт — діра в коректності); #39 — `close_exited_user` віддає
ренту `fee_payer` беззастережно, що для legacy (owner-paid) акаунтів є вилученням коштів
власника; далі —  4 legacy-позиції тижнів 1–2 застрягли назавжди (зміщення OI/locked);
стійкість планувальника до рестарту devnet-tee не виміряна; осиротіла `liquidation_check`-задача
на departed `Position` (тікає вічно як no-op, матеріальної шкоди не виміряно, кількість монотонно
росте); чи ER взагалі шанує `ComputeBudget` на 1.4M CU — не підтверджено (devnet-tee не віддає
логи/CU для ER-транзакцій; непрямий доказ — 367k CU на 16 ліквідацій не впав); ризик #23
(TEE-permission гейтить лише читання, не інклюзію tx) тепер несе й `liquidation_check`;
`close_orphan_queue` — crank-only, залежність від живучості релеєра; `listBaseOwners` — O(n)-скан
бази; історія міграції v1-лейауту відсутня як окрема інструкція; #27 (SIWS-гейт на `/sponsor`) —
далі в тиждень 6; **живий Phantom-смок (24.09.2026, фікс-раунд 2):** Phantom відхиляє
`reauthorize` для будь-якого неверифікованого dApp-identity (Digital Asset Links на
`identity.uri`) — клієнт тепер робить свіжий `authorize` в одній сесії замість реюзу токена
(`app/src/lib/mwaAuth.ts`'s `reauthorizeFresh`), але постійний фікс — хостити `assetlinks.json`
на власному домені, далі в тиждень 6.

---

## Task 1–3, 6: короткі підсумки

Повних task-звітів для цих чотирьох задач тут немає (формат — лише Task 0/4/5/7, які торкалися
devnet/спайку напряму); нижче — короткий підсумок кожної з посиланням на
`.superpowers/sdd/2026-09-23-week5-reliability/task-{1,2,3,6}-report.md`.

### Task 1 — Close звільняє позицію одразу, розкриття з черги

Коміт `26ee85a` (доопрацьовано з WIP після падіння попереднього імплементера) + fix round 1
`b2f17ba`. `finalize_close` штовхає `ClosedRecord` у `DisclosureQueue` і одразу скидає
`Position → Empty`; `commit_aggregate`'s `Position`-шлях видалено — джерело дій тепер лише черга
(`pending_commitments`/`due_reveals`); `mark_committed`/`MarkCommitted` видалені; `crank_tick`
переведено на трійки `[Position, UserAccount, DisclosureQueue]`. Знахідка WIP: 4 нові акаунти
`Trade` пробили SBF-стек (4104 B > 4096) — виправлено боксуванням `config`. Ревʼю: full-ring
кандидат мав абортувати весь `crank_tick`-батч — за рулінгом контролера замінено на `continue`
(push-into-ring, не batch-abort). LiteSVM 71, unit 59, relayer 61 (complete).

### Task 2 — Exit із боргом розкриття

Коміт `9998b04` + fix round 1 `6aef671`. Частковий `undelegate_user` (черга з `len > 0` лишається
делегованою, `members → [crank]`, `UserAccount.exited = true`); нові інструкції
`close_orphan_queue` (ER, crank) і `init_user_reuse_queue` (база, ре-онбординг без `init`);
бриф-варіант `close_queue_l1` (порожнє тіло) замінено ревʼю на `close_exited_user` (база,
`fee_payer`, закриває три PDA разом, гейт `exited`/нульові баланси) — перший варіант не мав
`exited`-гейту й «цегляв» власника в напівзакритому стані. `USER_ACCOUNT_VERSION = 2`. Помилки
`LiquidationTaskFailed 6041` (зарезервовано під Task 3), `NotExited 6042`, `QueueStillPending
6043`. LiteSVM 78, unit 59 (complete).

### Task 3 — `DelegateUser.payer` (P1) + per-position `liquidation_check` (P3)

Коміт `0bc1453` + fix round 1 `40e0fbb`. Новий модуль `instructions/liquidation.rs`:
`LiquidationCheck`-контекст (9 акаунтів, усі великі — `Box`), `liquidation_check` читає mark з
`Market`, оракул лише як gate свіжості; `schedule_liquidation_task`/`cancel_liquidation_task` —
`ScheduleCrankCpi`/`CancelCrankCpi` через `invoke_signed` з `FeeEscrow` PDA як payer/authority.
`open_position` реєструє задачу, `close_position`/`decrease_position`-до-нуля/`undelegate_user`
скасовують. Спільна логіка (`liq_due`/`liquidate_now`) винесена й використовується і `crank_tick`,
і `liquidation_check` — без дублювання. `DelegateUser` отримує `payer: Signer` окремо від
`owner`. Ревʼю: дефолт `liq_hysteresis_ticks` піднято 2→3 (два незалежні джерела тіків), gate
`task_context == position` доданий явним constraint. LiteSVM 84, unit 61 (complete). Програмна
частина тижня 5 завершена тут — Task 4 лише редеплоїть.

### Task 6 — Застосунок: 0-SOL онбординг, identity-aware MWA, History/Positions/Exit

Коміти `15d07f9`, `6ff03f8`, `9094d90` + fix round 1 `6c657ca`. `batchOnboarding.ts`/
`program.ts`: ATA-`payer` і `delegate_user`'s `payer` тепер `fee_payer` (відповідає новим
sponsor-shapes Task 5), сесійний L1 top-up (`SystemProgram.transfer`) видалено разом із мертвим
`LEGACY_ONBOARDING`-фолбеком. Новий `app/src/lib/mwaAuth.ts`: `auth_token` прив'язаний до хешу
`AppIdentity` (sha256 над відсортованим JSON), `ensureAuthorized`/`disconnect` де-авторизують
токен, виданий під іншою identity, до виклику `connect()`/після `disconnect()` — виправляє
відсутній `wallet.deauthorize(...)` у бібліотечному хуку. `useHistoryRows.ts` (нове) виносить
дані History з `HistoryScreen.tsx`; `Position.closed` більше не декодується
(`DecodedPosition`); `PositionCard`/`PositionsScreen` втратили мертву гілку «Closed pending
commitment»; `ExitSheet.tsx` замінює чекліст-поле `historyQueueEmpty` на інформативне
`pendingDisclosures: N`. Ревʼю: `WalletUiDropdown`/settings-конект оминали `mwaAuth` — виправлено
централізацією в `WalletUiButtonConnect`/`Disconnect` + auth-provider `signIn`. `tsc`/`lint`/
`format` чисті; 6 скріншотів на емуляторі (`docs/superpowers/plans/assets/week5-task6-*.png`);
живий фреш-онбординг/reuse-queue/exit-з-чергою залишено на Task 7 M-I (devnet) — не завершено на
емуляторі цим завданням.

---

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

**(c) Вихід із боргом розкриття — PASS за механікою, але сигнал-осиротілість у програмі
ЗЛАМАНИЙ. Потрібен другий апгрейд.**

Свіжий трейдер `8ZsNG1s1anFhA5ubZM978x4qRYwXwhf7jCoYhmx7Qe5E`, позиція
`gb2v4XryA7PQ5WvjdxSbpXqViaJuJJrPxeoXXSr9WYb`, черга
`DDe6rXjnyCF9MdAd7MgYgE1nboyvyriUsgWVxQd8QdWf`. `undelegate_user` при `dq.len = 1` —
`AYTMeEzMPW5rU5QrS5CWtUGK5nF8tLeMiZB9cBDTHb51h2s1M2AtaZQHK7Ex1Gt5k7hBKM3sEVo96bhSyucbLHx`.
Кожен акаунт прочитано з ТРЬОХ ендпоінтів **двічі** — t+10 с і t+40 с після того, як
розделегування сіло на базу (на випадок лінивого клону в ER). **Обидва знімки ідентичні**,
байт у байт і лампорт у лампорт:

| Акаунт | base | TEE, owner-токен | TEE, crank-токен |
|---|---|---|---|
| `UserAccount` | `G2okX5…` 151 B / 1 424 584 лампортів / `exited = true` | **те саме**: `G2okX5…` 151 B / 1 424 584 / `exited = true` | **те саме**: `G2okX5…` 151 B / 1 424 584 / `exited = true` |
| `Position` | `G2okX5…` 265 B / 2 003 704 | **те саме** | **те саме** |
| `DisclosureQueue` | `DELeGGvXpWV2…` 1156 B / 6 529 984 (**лишився делегованим**) | **`null`** | `G2okX5…` 1156 B / 6 524 832, `len = 1` |

Два незалежні факти:

1. **Черга невидима власникові.** `undelegate_user` звужує її `EphemeralPermission` до
   `members = [crank]`, тож owner-токен отримує те саме `null`, що й чужий гаманець. Осиротілість
   бачить **лише кранк** — тобто саме той, хто має її прибирати. Це працює як задумано.
2. **Розделеговані `UserAccount`/`Position` НЕ зникають із ER** — TEE віддає клон базового
   акаунта: той самий власник (`dexxer_core`), та сама довжина, ті самі лампорти, `exited = true`.
   Клон видно **обом** токенам (permission-акаунт закрито `close_permission_if_present`, акаунт
   знову публічний), і він **стабільний** між t+10 с і t+40 с.

**(c2) Вирішальний вимір — не RPC, а сам рантайм ER.** RPC-читання ще не доводить, що бачить
рантайм усередині транзакції, а весь сенс питання саме в цьому. Тому чергу вичерпано одним
`commit_aggregate`
(`5QBXkBVWuDFyUmzbtUGkaK5d4MaJ28yECRtdndAJd24Z3BnqQjWoecxCcZ44GVtFk73yc14WTDXgpvnPeHhthdzP`,
`len 1 → 0`) і викликано справжню `close_orphan_queue` кранком на справжньому сироті:

```
31m5Ahe79PZu6go3pZzzCtEAxWtJSm4ZFt3SwkjpfDGWQRoaEEiCVhKzG8Xw35BRF9wrKuqi7mPdcuKM4vmpT4Fj
  InstructionError [0, Custom 6042]  =  DexxerError::NotExited
```

**Вердикт: сигнал `require!(ua.data_is_empty() || ua.owner != crate::ID, NotExited)` у
`close_orphan_queue` (`instructions/user.rs:1173`) на devnet-tee НІКОЛИ не спрацює** — акаунт
присутній і належить `crate::ID`, тож жодну осиротілу чергу прибрати неможливо, і вони
накопичуватимуться назавжди. Рантайм підтвердив те, що показав RPC.

**Рекомендація (рішення за контролером):** приймати `exited == true`, коли дані присутні —
тобто `require!(ua.data_is_empty() || ua.owner != crate::ID || UserAccount::try_deserialize(..)?.exited, NotExited)`,
або простіше: типізувати `user_account` як `Account<'info, UserAccount>` з
`constraint = user_account.exited`, лишивши `data_is_empty()`-гілку для випадку, коли акаунт
із ER справді зник. Це **другий апгрейд програми** — сам по собі невеликий, але `close_orphan_queue`
до нього неробочий.

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

0. **БЛОКЕР Task 2: `close_orphan_queue` непрацездатна на devnet-tee.** Її сигнал
   `require!(ua.data_is_empty() || ua.owner != crate::ID, NotExited)` виміряно як завжди-хибний —
   ER віддає розделегований `UserAccount` як клон базового (присутній, власник `crate::ID`),
   і реальний виклик кранком упав `Custom 6042 NotExited`
   (`31m5Ahe79PZu6go3pZzzCtEAxWtJSm4ZFt3SwkjpfDGWQRoaEEiCVhKzG8Xw35BRF9wrKuqi7mPdcuKM4vmpT4Fj`).
   Потрібен **другий апгрейд програми**: приймати `exited == true`, коли дані присутні (деталі
   й точне формулювання — §4 (c2) вище). Осиротіла черга
   `DDe6rXjnyCF9MdAd7MgYgE1nboyvyriUsgWVxQd8QdWf` (`len = 0`, вже вичерпана) лишилася на devnet
   як готовий тест-кейс для перевірки фіксу.

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

---

## Task 5: Другий апгрейд програми + переробка relayer-а

### 1. Частина A — програма (апгрейд #2)

**Що змінено (2 файли логіки):**

1. **`close_orphan_queue` — сигнал осиротілості.** Стара умова
   `require!(ua.data_is_empty() || ua.owner != crate::ID, NotExited)` вимірялася в Task 4 як
   **завжди хибна** (ER віддає розделегований `UserAccount` як клон базового: присутній,
   власник `G2okX5…`, `exited = true`). Нова умова — обидві половини сигналу:

   ```rust
   if !ua.data_is_empty() && ua.owner == &crate::ID {
       let u = UserAccount::try_deserialize(&mut &ua.data.borrow()[..])?;
       require!(u.exited, DexxerError::NotExited);
   }
   ```

   Тобто закривається, якщо акаунт **відсутній/чужий** АБО **присутній і `exited`**; живий
   (`exited == false`) — як і раніше `6042 NotExited`. Legacy-акаунт, що не десеріалізується,
   дає помилку — консервативно, черга не закривається.

2. **`set_disclosure_delay(ctx: Context<AdminConfig>, slots: u64)`** — закриває відкрите
   питання 1 з §6 Task 4 (`disclosure_delay_slots` писався лише в `init_config`). Патерн
   1-в-1 як `pause`/`set_scheduler_signer`; `0` — легальне значення (потрібне демо M-H).

**Гаунтлет:** `cargo fmt`, `clippy -D warnings`, `program_autofixer` (обидва змінені фрагменти —
`issues: []`, `require_another_tool_call_after_fixing: false`), `anchor build`,
unit **61**, LiteSVM **84 → 87** (нові: `close_orphan_queue_rejects_live_user`,
`close_orphan_queue_accepts_absent_user`, `set_disclosure_delay_admin_only`; існуючий
`close_orphan_queue_requires_empty_queue_and_exited_user` переписано на реальну devnet-форму —
крок (3) тепер очікує **Ok** на присутньому `exited = true`, а не `NotExited`),
`cmp target/idl/dexxer_core.json app/src/idl/dexxer_core.json` — байт-у-байт, `tsc` ×4.

**Апгрейд #2 на devnet.** `.so` 1 213 624 B ≤ 1 310 416 B (довжина даних, розширена в Task 4) —
`extend` не знадобився.

| | |
|---|---|
| Підпис деплою | `rTNNmdXhWapr2ciVewNHwczY4ePY2NZPqLaGRyYoGoRdfyrEs8bDyJfSwvsHZ8Kt9s6vzmi3pXHfzfe9Py21RhG` |
| SOL payer-а до | 6.950640579 |
| SOL payer-а після | 6.944625579 |
| **Вартість** | **0.006015 SOL** (лише мережеві збори; рента буфера ≈6.17 SOL повернулася) |

**Доказ фіксу на живому devnet** — новий скрипт `tests/er/devnet/12-close-orphan.ts`
(`npm run devnet:orphan`), прогнаний на осиротілій черзі, яку Task 4 навмисно лишив
(`DDe6rXjnyCF9MdAd7MgYgE1nboyvyriUsgWVxQd8QdWf`, власник
`8ZsNG1s1anFhA5ubZM978x4qRYwXwhf7jCoYhmx7Qe5E`, `len = 0`):

| Крок | Результат |
|---|---|
| `close_orphan_queue` (crank, ER) | **OK** `3AR23nkojoE63f4CGv2VpVGGUp1Ymi5kxxTN5KpoptDE3EwkrMpAJkEoVFSQGxeB78BtXDoUfh8HpGJLgRKSTKcw` (до апгрейду ця сама черга давала `6042 NotExited`) |
| Розделегування сіло на базу | так, `owner == G2okX5…` при першому ж поллінгу |
| `close_exited_user` (fee_payer, base) | **OK** `jQTPGzV3jb5QaCkpxqiZEfAaMKrH69YLe6SQJPMPoUzNNwUtVbikZNBNQ2dcKVuaeEHDHwqP4gCQjuqh6CLVsL5` |
| Рента назад на `fee_payer` | **+0.009953272 SOL** (три PDA мінус збір) |
| Три PDA на базі після | усі три `closed` |

Тобто повний шлях «вихід із боргом розкриття → дренаж черги → повернення ренти» вперше
пройдено end-to-end на devnet. Блокер 0 із §6 Task 4 **закрито**.

### 2. Частина B — relayer

**`COMMIT_INTERVAL_TICKS`** (env, дефолт 300) замінює зашитий `DISCLOSURE_EVERY_TICKS`;
видно в `/healthz` як `commitIntervalTicks`. Значення < 1 або нечислове відкочується на
дефолт (а не крутить цикл щотіка). **На тиждень виставлено `60`** (≈1 хв) — це половина
демо M-H: разом із `set_disclosure_delay(0)` закрите розкриття доходить до L1 за один цикл.

**`runDisclosureCycle` — черговість (minor #8 з ревʼю Task 1).** Кандидати сортуються за
`closed_slot` **найстарішого непогашеного** запису черги (нічия — за pubkey, щоб порядок був
стабільним, а не залежав від порядку `getProgramAccounts`). Без цього один трейдер із повним
рингом (`DQ_CAPACITY` записів — більше ніж один бандл дій) з'їдав би весь
`MAX_ACTIONS_PER_COMMIT = 8` щоцикл вічно, і сусід із одним закриттям не комітився б ніколи.
Перевірка «чи настав reveal» читає **ER-слот** (`ctx.conn` — ER-конекшн): `reveal_after_slot` —
ER-слот (~80/с проти ~2.5/с на базі, вимір Task 4).

**`src/orphan.ts` — `runOrphanCycle`,** раз на `COMMIT_INTERVAL_TICKS`, **після**
disclosure-циклу (саме він дренує ринг того, хто йде; дренована цього ж циклу черга встигає
бути прибраною в ньому ж). Два проходи:

1. **ER (crank):** кожна `DisclosureQueue` з `len == 0`, чий `UserAccount` (читання через TEE
   crank-токеном) відсутній АБО `exited == true` → `close_orphan_queue`. `len > 0` не
   чіпається взагалі (транзакція навіть не шлеться — програма все одно дала б
   `QueueStillPending`).
2. **base (`fee_payer`):** власники, чиї три PDA повернулись під `dexxer_core` і в кого
   `UserAccount.exited` → `close_exited_user`.

Проходи навмисно незалежні: розделегування з проходу 1 сідає на базу вже після кінця циклу,
тож власника підбирає прохід 2 **наступного** циклу — причому через скан ланцюга, а не
пам'ять процесу (рестарт relayer-а не лишає нікого на півдорозі). Помилка на одному власнику
логується й не зупиняє решту. Уся логіка на інжектованих читачах/писачах
(`OrphanCycleDeps`) — 9 юніт-тестів без мережі.

**Staleness за `publish_time`.** `isStale` тепер міряє вік **публікації оракула**, а не
момент, коли процес отримав нотифікацію: TEE шле нотифікацію на кожен ER-слот незалежно від
того, чи змінилися байти (вимір тижня 4, `useLiveAccount`), тому «прийшло повідомлення» не є
доказом живого паблішера. Це та сама умова, якою `oracle.rs` гейтить кожне читання на
ланцюзі. `publish_time` зберігається потіково (міграція `005_ticks_publish_time.sql`, epoch
ms, nullable для доміграційних рядків), `/mark` віддає `{price, slot, ts, publishTime, stale}`,
`/healthz.indexer` — `lastPublishTimeMs` + `oracleStale` за ним, WS-фрейм `mark` теж несе
`publishTime`.

**Sponsor-shapes:**

| Зміна | Було | Стало |
|---|---|---|
| ATA `CreateIdempotent` | owner-paid (`{ownerIdx:2}`, `fee_payer` заборонений всюди) | **`{payerIdx:0, ownerIdx:2}`** — рент ATA платить `fee_payer`; `owner`@2 мусить бути підписантом (це й не дає профінансувати чужу ATA) |
| `init_user_reuse_queue` | не в whitelist | **`{ownerIdx:0, payerIdx:1}`** |
| `delegate_user` | `{ownerIdx:0, payerIdx:1}` (Task 3) | без змін |
| `init_permissions`, `set_session` | у whitelist | **видалено** |
| SystemProgram transfer (session top-up) | гілка за `SPONSOR_ALLOW_SESSION_TOPUP` | **видалено разом із env-змінною, `SESSION_FUND_LAMPORTS` і крос-перевіркою `set_session.session_key`** |

Обґрунтування видалення ER-леґу: devnet-tee відхиляє чужого `fee_payer` як платника ER-tx
(`InvalidAccountForFee`, вимір тижня 4), тож ця гілка **недосяжна для чесного клієнта і
досяжна лише для атакера**. Побічний виграш: `fee_payer` тепер не рухає лампорти взагалі —
дренажна поверхня прибрана конструктивно, а не перевірками.

**Тести relayer-а: 61 → 72** (`node --import tsx --test test/*.test.ts`,
`DEXXER_IDL_DIR=$PWD/../../app/src/idl`). Нове: `test/orphan.test.ts` (9 — уся таблиця
рішень), sponsor (ATA payer=fee_payer для чужого owner-а → reject; самотня fee_payer-оплачена
ATA → reject «немає owner-підписанта»; `delegate_user` з payer ≠ fee_payer → reject; будь-який
SystemProgram → reject; `init_user_reuse_queue` → accept; цілі леґи L1a і L1b → accept),
feed (`publishTimeMs`, staleness за publish_time, майбутній publish_time не stale), health
(`commitIntervalTicks`).

### 3. Деплой на Railway

`railway up --service relayer` (проєкт `dexxer`, env `production`),
`COMMIT_INTERVAL_TICKS=60` виставлено окремою змінною. `/healthz` після деплою:

```json
{"ok":true,"tick":27,"crankSol":0.1,"feePayerSol":0.198363312,"db":"ok",
 "commitIntervalTicks":60,
 "indexer":{"ticks":47,"lastTickTs":1790191005094,"lastPublishTimeMs":1790191005000,
            "disclosures":0,"wsClients":0,"oracleStale":false}}
```

`/mark`: `{"price":"114212551","slot":343713380,"ts":1790191006094,"publishTime":1790191005000,"stale":false}`
— `publishTime` є, `stale` рахується з нього.

Міграція `005_ticks_publish_time.sql` застосувалася на старті (`db: applying migration …`).
Тік: `tick n=35 slot=343714590 mark=114242939 … cu=15438 tick_ms=567 candidates=0` — без
помилок. Цикл на 60-му тіку відпрацював повністю:

```
root: filled=6 slot=343719005
commit_aggregate: sig=5EscbqHRRc3q3GKyNeLh2KZtHjyKzNfBNVh1hQxuGH1VghM8jqCNGb5Fovt8AcDgjNomK8iRDZ64ZQ44XuayLbF4 actions=0
orphan: closed queue 9mjRLVMv43dqarsZ6RjM6gEWVQmTGKqC97yLKt9SgqkL of CgRmYr96f2vSpGubuVgomA8KCUkRkVPDD8szQBfipQLx in the ER (exited) sig=4mVscRRy2C9eM1C7SNCs9bQscAdL1bX8YZ4cYSfpsLjF6guo4iexdLGsRmJrzJioiXydgbqBBGmKAcDH4Pr8AC17
orphan: closed the three PDAs of CgRmYr96f2vSpGubuVgomA8KCUkRkVPDD8szQBfipQLx on base … sig=4jZvbiJjBD1SSzf4s2u3WLA6KpY3MXTPNJZLVAPzmkRNSDBAz1E9it8mnBgXGS24i675LkcURnSY23WRNGjwGxEb
orphan: closed the three PDAs of CEc1DtmbnMzs48tUu5g7Uo1vd5uQTBq54QeWx5biNHuj on base … sig=325JvjfjGfB54WbL8nFw1Evkkice1WeyRnD26TEdF3XsQQEMA2Ed8qWHFtGr2SewTixAZp3RqM3vAxusjWtQq5e1
orphan cycle: scanned=30 closedInEr=1 closedOnBase=2 skipped=28 errors=1
```

Тобто **janitor одразу прибрав двох власників, що висіли з попередніх тижнів** — не лише
логіка, а й реальний ефект підтверджено на живому сервісі з першого циклу.

### 4. Fix round 1 — знайдено живим прогоном

`errors=1` вище: `close_orphan_queue` для `CEc1Dtmb…` впав
`InstructionError [0, "ReadonlyDataModified"]`
(`4hLD8vAWhVd3woh7JGVrbkFLDxoVyaVB2gEgqtUAb29mLXDR2u2urvZRr5B3HKPGu2iRRQ96kowfwckTotoZSFji`).

**Причина (новий вимір):** черга, чиє розделегування **вже сіло на базу**, усе одно
віддається ER-ом — як **read-only клон базового акаунта**, з власником `dexxer_core` рівно
так само, як делегована. Всередині ролапу ці два стани не розрізняються нічим. Розрізняє їх
**власник на базі**: справді делегований акаунт там належить Delegation Program.

**Фікс:** `listQueues` відкидає дреновані черги, чий базовий акаунт уже під `dexxer_core`
(один батчений `getMultipleAccountsInfo` на цикл) — ними займається базовий прохід, який у
цьому ж циклі обох власників і прибрав. Чиста предикат-функція `stillDelegatedOnBase`
винесена окремо й покрита юніт-тестами. Тести relayer-а **72 → 75**.

### 5. Відкрите після Task 5

1. **Крос-задачна залежність: додаток (Task 6) мусить перейти на нові sponsor-shapes.**
   `app/src/features/onboard/batchOnboarding.ts` зараз будує ATA з `payer = owner` і
   `delegateUser({ payer: owner })` — обидва тепер **відхиляються** `/sponsor`-ом
   (`account index 0 (payer) must be fee_payer` / `account index 1 (payer) must be
   fee_payer`). Половина з `delegate_user` була такою вже після Task 3; ATA — нова з цієї
   задачі. До Task 6 свіжий гаманець без dUSDC-ATA не завершить спонсорований леґ L1a.
2. **`listBaseOwners` — O(n) скан бази** (gPA по дискримінатору `UserAccount` + по одному
   `getAccountInfo`, бо власника не витягнути з адреси PDA). Раз на комміт-інтервал і на
   devnet це копійки, але перед реальною кількістю юзерів потребує обмеження.
3. **`set_disclosure_delay` задеплоєно, але ще не викликано на devnet** — це M-H у Task 7
   (`delay 0` + `COMMIT_INTERVAL_TICKS=60`).
4. **`fee_payer` — 0.198 SOL** (crank 0.1 SOL). Кошти не рухалися. Спонсорування за добу —
   0.0616 SOL / 15 викликів; janitor-ові `close_exited_user` рент **повертають**, тож для
   `fee_payer` цикл нетто-позитивний.
5. **Legacy-акаунти з тижнів 1–2** (`RangeError` на декоді `UserAccount`, 4 позиції) далі
   логуються щотіка як `skipping candidate …` — відомий пункт 3 з §6 Task 4, не регресія.

## Task 7: Виміри M-G′ / M-H / M-J / M-I / M-K

Продовження після обриву попереднього агента (скрипти `13-liquidation-check.ts` /
`14-close-reopen.ts` / `15-exit-debt.ts`, `tests/er/lib/admin.ts::setDisclosureDelay` — уже
існували; цей запис завершує вимірювання, лагодить дефект релеєра, який вони й виявили, та
пише підсумок).

### 0. Реальний дефект, знайдений вимірами: місток МагикБлоку відхиляє «важкі» дії задовго до
    програмної стелі `MAX_ACTIONS_PER_COMMIT`

**Симптом у прод-логах Railway (до фіксу):**
```
root: filled=11 slot=344328608
commit_aggregate failed: Error: transaction 4Qm3ZdPD… failed: {"InstructionError":[0,{"Custom":2684354562}]}
commit_aggregate: retry without candidates sig=5QoYshq7… actions=0
```
`2684354562 = 0xA0000002` — та сама помилка містка MagicBlock, яку тиждень 3's M-C вимірював
дешевою синтетичною дією (28 PASS / 29 FAIL). `tests/er/lib/program.ts`'s TS-дзеркало
`MAX_ACTIONS_PER_COMMIT` тим часом застигло на **4**, тоді як Rust-константа
(`state/mod.rs`) тижнем 5, Task 1 піднята до **8** (повна черга може потребувати до
`DQ_CAPACITY` комітів + стільки ж розкриттів) — клієнт де-факто бюджетував на застарілій
стелі в одну сторону, коментарі в `disclosure.ts` вже вважали 8 — в іншу.

**Вимір реального бюджету (локальний одноразовий виклик `runDisclosureCycle` тим самим
білдером, проти реального бeклогу на devnet):** черга `HgvCy4r2W5W3q4JmkEDYCQ3rSXbNNXMAypdb9zYuVHEY`
(власник `DsTSrhSCHtCCcnyhqcuki8w34YQujfv1xs2mYhdE1fPg`, породжена M-J's тестом переповнення —
повне кільце `DQ_CAPACITY=8`, 2 незакомічені + 6 прострочені `write_disclosure`) **відхилена
місtком на КОЖНОМУ протестованому бюджеті** — 8, 6, 4 (halved 2), 2 (halved 1) — усі
`0xA0000002`, жодного разу не PASS:

| Запитаний бюджет | Результат | halve-and-retry |
| --- | --- | --- |
| 8 | FAIL (actions=8) | halved до 4 — теж FAIL |
| 6 | FAIL (actions=6) | halved до 3 — теж FAIL |
| 4 | FAIL (actions=4) | halved до 2 — теж FAIL |
| 2 | FAIL (actions=2) | halved до 1 — теж FAIL |

Тобто відмова містка тут **не проста лінійна «count > N»** — навіть ОДНА `write_disclosure`-дія
з цього конкретного бeклогу відхиляється незалежно від того, скільки дій у бандлі. Контрольний
позитивний вимір: **свіжий, не-беклоговий бандл з 4 реальними діями (2× `write_commitment` + 2×
`write_disclosure`, дві різні черги, гаманці M-I нижче) пройшов одним викликом**
(`2poYVpWqZLvjv4wh9TbeTtuKtRx6uwSrLpymaBTdJsurfsr6JeDcT2iM6B56sDAK9BWrztvVAZFMsnKtAXUwVuA7`) — це
і є доказова основа дефолту `4`.

**Виміряний N (найвищий підтверджений PASS у реальних умовах): 4.** Не «найвищий N, після
якого завжди FAIL» — сам вимір показує, що FAIL/PASS тут залежить від вмісту/віку конкретного
запису, не лише від лічильника, тож `4` — це evidence-backed консервативний дефолт, не строго
виведена межа.

**Фікс, раунд 1 (перше review виявило CRITICAL: цей самий вимір — доказ АКТИВНОГО liveness
outage, не просто змарнованих ретраїв).** Перша версія фіксу (лише `COMMIT_MAX_ACTIONS` +
halve-and-retry, без quarantine) мала фатальну діру: `selectCandidates` — oldest-debt-first,
і `HgvCy4r2…` — найстарша черга з боргом. Оскільки вона провалюється на КОЖНОМУ бюджеті
(таблиця вище), вона **завжди** обиралася першою, **завжди** провалювала і full, і halved
спробу, і жодна молодша черга НІКОЛИ не діставалась до бандла — цикл щоразу падав до bare
0-дій retry. Це не гіпотетично: саме тому M-I (§4 нижче) знадобився ручний, поза циклом
`commit_aggregate`, що обійшов `selectCandidates` напряму — живий цикл сам НІКОЛИ б не
дістався до гаманців M-I, поки `HgvCy4r2…` стоїть попереду.

**Корінна причина (перевірено, гіпотезу #26 СПРОСТОВАНО):** контролер запропонував ризик #26 —
`write_commitment` мовчки відкинутий містком, поки `commitment_written` вже піднявся в ER, тож
`write_disclosure` читає неіснуючий `Commitment`. Пряма перевірка на ланцюгу (fix round 1):
для всіх 6 «due»-записів `HgvCy4r2…` — `commitmentWritten=true` в ER, і `Commitment`-PDA
**існує на базі для 6 з 6**; жоден із 6 `Disclosure`-PDA ще не існує (0 з 6 — не конфлікт
`init` на вже зайнятий акаунт). Тобто ризик #26 **не** те, що тут відбувається — комміти
реально landed, а `write_disclosure` все одно падає містком. Справжній механізм лишається
непідтвердженим: найімовірніше — розмір/CU конкретної `write_disclosure`-дії (повний
`ClosedRecord` + читання `Commitment`) або транзієнтна перевантаженість містка в момент
вимірювання; не програмна помилка, яку можна полагодити цим тижнем без зміни програми.

**Фікс, фінальна версія (`services/relayer/src/disclosure.ts`):**
- новий env `COMMIT_MAX_ACTIONS` (дефолт **4**, clamp `[1, MAX_ACTIONS_PER_COMMIT]`, стеля
  8 — програмна, з `state/mod.rs`, лишається абсолютним верхнім клампом);
- `tests/er/lib/program.ts`'s `MAX_ACTIONS_PER_COMMIT` виправлено `4 → 8` (застаріле дзеркало);
- halve-and-retry на `0xA0000002` халвить **бюджет дій**, а не кількість черг
  (`selectCandidates(pendingQueues, floor(totalActions/2), quarantine, cycle)`) — halvING по
  чергах нічого не дає, коли одна-єдина черга сама перевищує стелю (вимірено вище:
  `queues=1` на кожному кроці);
- **quarantine/rotation (`QuarantineState`, fix round 1):** коли й full-budget, і halved
  спроба падають на `0xA0000002` в одному циклі — кожна черга з halved-набору отримує +1
  послідовну невдачу. Перша невдача одразу виключає чергу з відбору на **рівно наступний
  цикл** («rotation» — жодна одна погана черга не коштує іншим більше одного циклу); друга
  ПОСЛІДОВНА невдача (`QUARANTINE_THRESHOLD=2`) виключає на `QUARANTINE_CYCLES` циклів (env,
  дефолт **10**, ~10 хв за `COMMIT_INTERVAL_TICKS=60`), з логом
  `quarantined queue <key> (n failures)`; по завершенні карантину — рівно одна повторна
  спроба (лічильник невдач НЕ скидається карантином, тож третя поспіль невдача одразу
  повертає в карантин); будь-який успіх повністю чистить стан черги
  (`recordCycleSuccess`);
- один halve, далі — існуючий bare-retry (0 дій, комміт `Pool`+`BalancesRoot` усе одно
  проходить щоцикл незалежно від кандидатів, як і раніше);
- `/healthz` несе `commitMaxActions`; `sendCommitAggregate` тепер injectable через
  `DisclosureCtx` (тестовий шов, IMPORTANT-пункт review) — дефолт лишається реальним.

`services/relayer`: **100/100** тестів (було 75, 89 у першій версії фіксу; нові — quarantine/
rotation: `selectCandidates` з `QuarantineState` (виключення після 2 невдач, rotation після 1,
retry по завершенні карантину), `recordCycleFailure`/`recordCycleSuccess`/`isQuarantined`,
`parseQuarantineCycles`, і один end-to-end тест `runDisclosureCycle`, що ганяє реальну
послідовність try→halve→quarantine→bare через fake `conn`/`prog`+`sendCommitAggregate`,
включно з ТРЕТІМ циклом, де карантинована черга A виключена і `send` бачить лише молодшу B).
`npx tsc --noEmit` — чисто.

**Деплой (фінальний, з quarantine):** `railway up --service relayer`. `/healthz`:
```json
{"ok":true,"tick":11,"feePayerSol":0.191982024,"commitIntervalTicks":60,"commitMaxActions":4, ...}
```
`QUARANTINE_CYCLES` не виставлявся окремо — дефолт (10) лишено, як і радила review.

**Підтверджено на живому проді, 3 послідовні цикли (`COMMIT_INTERVAL_TICKS=60`, спостережено
через `railway logs`):**

| Цикл (тик) | Що сталось | Sig(и) |
| --- | --- | --- |
| 1 (60) | full(4) FAIL → halved(2) FAIL → **failure #1 для `HgvCy4r2…`** (rotation, виключена на цикл 2) → bare(0) SUCCESS | full/halved: `0xA0000002`; bare: `5s8ZGhwB73qMSxjpy8zFxeXpTo11uMuELNsi4TcGarpfSjaV65m8BGYQKiKyhmVYnpfszVkwCvfTXiPWgyijKcW1` |
| 2 (120) | `HgvCy4r2…` виключена (rotation), інших pending черг не було → primary SUCCESS одразу, **0 провалів узагалі** | `4PWifVv5e5x9StxzNmDhrJKLYi3QAAcFMtijuY8uhMWvm6WVYhPdPBtJAZK1Aeu7sVh3CH8xbR6ftjrTioS1MNBB` (actions=0 queues=0) |
| 3 (180) | rotation минула, `HgvCy4r2…` знову відібрана → full(4) FAIL → halved(2) FAIL → **failure #2 → QUARANTINE** (лог `quarantined queue HgvCy4r2W5W3q4JmkEDYCQ3rSXbNNXMAypdb9zYuVHEY (2 failures)`) → bare(0) SUCCESS | full/halved: `0xA0000002`; bare: `5rBHyJ1eqK7eiSgi9zxXH7xjtrDF2hRKR2v7RFkF3D6jpAvteAXNx4MkXgT8Pkb5AUJmdgbUPCzrFAuN99wuXSpq` |

**Пряма демонстрація «молодша черга drain'ється, поки отруєна — на карантині»:** оскільки на
момент фіксу реального pending-беклогу, окрім `HgvCy4r2…`, не було (M-I вже drain'явся раніше
ручним викликом — §4), це завдання онбордило ще одного 0-SOL трейдера через `/sponsor`
(власник `5HaszEL9qcZ9AapKkTf9hzTc2yeFFhzgA9gdYYywDVi8`, черга
`7Du8pfEvoE9ut1ZHrg4GUtqL3WCTuoxS7qBs38nJut4B`), відкрив і закрив позицію — свіжий, молодший
за `HgvCy4r2…` запис. Наступний цикл (тик 360, `HgvCy4r2…` ще на карантині) підхопив і
задренував його **без жодної невдалої спроби**: `commit_aggregate: sig=qveLP2tqr8jvVWMzPmN4B8neonw4CXnz9BDf7wkEhebEaKYMCHNZu7gqbUEjoeBwxxGHateK7wRxVgAMpzuy9Lu
actions=1 queues=1`. Перевірено напряму: `DisclosureQueue.len` свіжого власника = **0**
(повністю розкрито одним бандлом, `disclosure_delay_slots=0`), `HgvCy4r2…` лишилась
незайманою — `len=8` (той самий стан, що й до фіксу) — картина точно та, яку мав дати фікс:
одна погана черга більше не блокує решту.

**Баланси (кінець фіксу, свіжий read):** `devnet-admin` 0.800648 SOL (не рухався),
`devnet-fee-payer` 0.133726048 SOL (спад від 0.191982024 — sponsor-плата за L1a+L1b нового
демо-трейдера плюс паралельний живий `/sponsor`-трафік, `sponsor.count_today` 20→25),
`devnet-crank` 0.1 SOL.

**Висновок:** `HgvCy4r2…` (`DsTSr…`'s власник) лишається так само незакритою, як і до фіксу
(§4's «Відкрите» — коренева причина в бриджі/дії, не в клієнтському відборі), **але тепер це
явно ЗАБЛОКОВАНА (quarantined) черга, а не активний liveness outage** — до фіксу вона
блокувала ВЕСЬ цикл назавжди; після фіксу вона ізольована на `QUARANTINE_CYCLES` (10 циклів,
потім одна повторна спроба), а все інше — `Pool`/`BalancesRoot`, і, як щойно доведено, молодші
черги — продовжує йти щоцикл нормально.

### 1. M-G′ — ліквідація без relayer-а (планувальник сам, `CRANK_ENABLED=false`)

`13-liquidation-check.ts` (`npm run devnet:liqcheck`). `CRANK_ENABLED=false` на Railway
(здоров'я підтвердило `crankEnabled:false, schedulerActive:true` за 16 полів здоров'я),
свіжий трейдер відкрив ~10x лонг, `set_params(mmr_bps=9500, imr_bps=9600)` тимчасово зробив
позицію ліквідовною, поллінг **owner-TEE токеном, без будь-якого relayer-виклику**:

**PASS.** Позиція ліквідована за **6.97 с** (3 полли, `liq_ticks` історія `[0,2,0]`,
`reason=liquidated`), `DisclosureQueue.len=1` після. Параметри та `CRANK_ENABLED=true`
відновлено (`restoredParamsOk: true`, healthz підтвердив `crankEnabled:true` за 21 полл).
Планувальник у TEE (без relayer'а взагалі) реально ліквідовує, не лише рухає `mark` — сильніший
результат за тиждень-4 знахідку («scheduler mark-only, не ліквідаційний backstop»), бо тут
позицію ліквідував саме планувальник (не `crank_tick` relayer-а, вимкненого на час тесту).

### 2. M-H — one-cycle reveal (delay=0, `COMMIT_INTERVAL_TICKS=60`)

`14-close-reopen.ts` (`npm run devnet:reopen`), окремий гаманець `devnet-mh-*` (НЕ той самий,
що M-J нижче — окремі власники, окремі черги). Перший прогін (`14-run.log`) впав на
`init_permissions` з `Custom 6002 = InvalidInput` (transient — не відтворено на повторі,
`errors.rs`: `6000=MathOverflow, 6001=DivisionByZero, 6002=InvalidInput`). Другий прогін
(`14-run2.log`): `set_disclosure_delay(0)` (сиг `2Aj4Apsx…`/`5tgiKQoWhCQs6rzc…` — двічі, бо
перший прогін не дійшов до відновлення), `open_position` → `close_position`
(`29MKQ9vRnym6e8yYydy71dvp7dyxgZk5ZrDYKsBEi5H6xEWsPL6KwN2bKYfMbQsn5A9jHwNVPLyV2DmCr93Q83Zz`),
`DisclosureQueue.len=1`, `Commitment` PDA `tYkzxv5ZS7GnT1Dm2AEEbK8qcbL3wpy8Ct7zmJYhHvA`,
`Disclosure` PDA `2aVzPtRd8co3soCfXYvf1frHyghKWZb8FQrbek8LeKN3`.

Скрипт-поллінг (≤100 с, без ручного `commit_aggregate`) **сам по собі впав** —
`mhLanded: false`, `mhCloseToDisclosureSeconds: 103.762` (тайм-аут поллінгу, **не** підтверджений
момент landing-у). **Пряма перевірка вже під час цього завдання підтвердила обидва PDA існують
на L1** (`getAccountInfo` — `exists: true` для обох) — реєстрація й розкриття таки landed, але
**точний момент landing-у невідомий, відомо лише що > 103.8 с** (перевірка робилась значно
пізніше, у процесі fix round 1's дослідження — жодного проміжного таймстампа між 103.8 с і
моментом перевірки не знято). **Висновок: M-H PASS по суті (комміт+розкриття одним бандлом,
delay=0, підтверджено post-hoc на L1), час landing-у — «unknown (> 103.8 с)», FAIL по
жорсткому 100-секундному вікну скрипта** — вузьке вікно скрипта, не регресія; ця черга не
пов'язана з `HgvCy4r2…` (окремий власник, окрема черга — див. §0/§4).
`COMMIT_INTERVAL_TICKS`: рішення лишити **60** для демо не приймалось цим завданням — поза
скоупом Task 7 (питання з week-4/5 Task 6 лишається відкритим).

### 3. M-J — close→reopen той самий слот, QueueFull, відновлення

Той самий прогін (`14-run2.log`), два окремі власники:

**Частина 1 (`devnet-reopen-*`):** `open #1` → `close #1` → **`open #2` (reopen) у наступній
tx, без очікування** — `Position.state == Open` одразу після (1.7 с) — **PASS**.

**Частина 2 (`devnet-overflow-*`, `set_disclosure_delay(12000)` тимчасово — щоб жоден з 8
записів не встиг стати due до кінця циклу):** 8 close→open циклів заповнили кільце
(`dq.len` 1→8, 33.6 с на всі 8), **9-те закриття FAILED як очікувалося** — `Custom 6023 =
QueueFull` (`2aanJKPqLzmyNMEq1N5HSKpDEcyp5DDmWJzKvUydbzeQXKgg6AZiMF2N8MSWjsPGJTmanS6NvevLY1vNv2kXmhgj`),
`Position` лишилась `Open` (транзакція відкотилась) — **PASS**. `set_disclosure_delay(0)`
відновлено (`41LogbRToBLteRTL5xKrfT6zfh1y1mX6M8pwimX6J2xAb8Le6euSLubGRkDueQNrKcxc2dczzzZgyrKa3QroXuWu`,
`finalDisclosureDelaySlots: "0"` підтверджено). **«Черга звільнить слот» — не підтверджено
в межах скрипта** (`overflowFreedAfterSeconds: null`, тайм-аут 360 с) — і **лишається
незакритою й на кінець цього завдання** (§0's поганий бандл — саме ця черга; після fix
round 1 вона на карантині, не активно блокує решту циклу, але сама так і не drain'ялась).

### 4. M-I — онбординг/exit на 0-SOL гаманцях

`15-exit-debt.ts` (`npm run devnet:exitdebt`). Прогін прерваного агента (`15-run.log`) довів
обидва гаманці до `undelegate_user` (partial — `dq.len=1` лишено) і зупинився на власному
240-секундному тайм-ауті (`w1DqDrainedAfterSeconds: null`, janitor не встиг у вікні скрипта).
**Це завдання довело обидва гаманці до кінця, тим самим фіксом §0:**

| Гаманець | Owner | 0 SOL протягом усього циклу? | L1a/L1b (sponsored) | ER-леґ (init_permissions+set_session, 0 SOL) | trade+close+withdraw | `undelegate_user` |
| --- | --- | --- | --- | --- | --- | --- |
| wallet1 | `8HQxfsyyGaQLhW3Xah6VSC5xXUmUkAhnkfYmpqYsAFBP` | так (виміряно: 0 lamports до і після) | OK | OK, `erLegZeroSolError: null`, `topUpLamports: 0` | OK | partial, `dq.len=1` |
| wallet2 | `5s8739QeTJnpSxbfmuVsTVEX4k15aMKBabohVkTZuELh` | так | OK | OK, 0 SOL | OK | partial, `dq.len=1` |

**Ручний одноразовий `commit_aggregate` (той самий білдер, поза автовідбором — обидві черги
цільово в `remaining_accounts`, минаючи oldest-debt-first, бо той завжди першою бере
«отруєну» чергу §0) прогнав обидві черги до `len=0` одним бандлом** (2 записи,
`commitmentWritten=false→write_commitment→due(delay=0)→write_disclosure`, разом 4 реальні дії
— це і є контрольний позитивний вимір §0): sig
`2poYVpWqZLvjv4wh9TbeTtuKtRx6uwSrLpymaBTdJsurfsr6JeDcT2iM6B56sDAK9BWrztvVAZFMsnKtAXUwVuA7`.

Далі — janitor (той самий Railway relayer, живий, `COMMIT_INTERVAL_TICKS=60`): протягом
наступних циклів обидва власники пройшли ER-прохід (`close_orphan_queue`) і базовий прохід
(`close_exited_user`) без ручного втручання — **перевірено напряму** (`pdas.userAccount`/
`pdas.position`/`pdas.disclosureQueue`, коректно похідні від owner, а не від помилково
підставленої адреси — перша спроба перевірки помилково використала owner-адресу як PDA черги
й хибно «підтвердила» закриття завчасно, виправлено до write-up): усі три PDA обох гаманців
**відсутні на L1** (`getAccountInfo` → `null`) — повний trio-reclaim, **PASS** для «disclosure
drain → orphan ER pass → base pass».

**Re-onboard wallet1:** оригінальний `owner`-ключпейр перерваного агента був
`Keypair.generate()`, ніколи не збережений (`15-exit-debt.ts` навмисно ephemeral) — той самий
власник фізично не відновлюваний новим процесом. Виконано ідентичний L1a-леґ (ATA+faucet_init+
init_user, sponsored, 0 SOL) для **нового** ключа як заміну (чесно позначено): sig
`2VADpHhRczNHF9UKtLVqAcotexk82VMbGws8CHYv8Shp37aah5dQoHa1kRyJafmQCN4d1vBw7RM4XjWpnX2nNobi`,
`UserAccount` існує, `exited=false` — **PASS** (система здорова одразу після повного reclaim
циклу; той самий owner pubkey відтворити не можна, дублюючий факт про ephemeral-ключі —
залишок для наступного разу: скрипт має персистити тестові ключі, якщо повторюваність важлива).

**wallet2 `init_user_reuse_queue`-гонка:** перша спроба (одразу після `undelegate_user`,
черга ще делегована) — очікувано FAILED `Custom 3007`
(`6vBvpLdYbkXtSRYWpxBecWwHh8vB3peMcE8VxdDHMf4i4VTDZ3gwr7LLrZCMuckr3Q2N1AY3KZoL93FP8eCW4M1`).
Вікно «ER-прохід сів, базовий — ще ні» — **не спіймано**: на момент, коли це завдання
перевірило стан, обидва проходи (ER + база) для wallet2 вже landed. При `COMMIT_INTERVAL_TICKS=60`
обидва проходи виконуються в ОДНОМУ циклі одного вантажу (`runOrphanCycle` — обидва паси
послідовно, без затримки між ними), тож вікно, якщо воно взагалі відкрите, — набагато
коротше за час одного зовнішнього RPC-круговороту цього процесу. **Чесний висновок:
`init_user_reuse_queue` лишається перевіреним лише в LiteSVM** (як і зазначав бриф — вікно
або задовге, або ніколи не відкрите за 60-тикового janitor-а в один прохід).

**SOL-таблиця (адреси й фінальний стан, підтверджено свіжим читанням наприкінці завдання):**

| Ключ | Адреса | Баланс наприкінці |
| --- | --- | --- |
| `devnet-admin` | `8L4EyWLc6yGH4c3zrVWLCoJqRbgWGtUf9sYyqnMPkVtH` | 0.800648 SOL (не рухався цим завданням) |
| `devnet-fee-payer` | `3HgDNwQPnHRRK6Sy5MXTN18zEYpGMJZioiGV3dD3Chnt` | 0.191982024 SOL |
| `devnet-crank` | `2w7Xvd4GtS4rTE86tG51LMa9ZvLckDMFizb6XZDQerFA` | 0.1 SOL |

`fee_payer` **не ізольований** — Railway обслуговує живий продовий `/sponsor`-трафік
одночасно з цим виміром (`sponsor.count_today` зросло з 19→20 незалежно від дій цього
завдання, і саме ця одна стороння дія — не M-I — пояснює проміжний стрибок
0.204383616→0.191982024 після редеплою: дельта 0.012401592 SOL точно збігається з
`sponsor.today_sol`'s 0.107454344→0.119855936). Чисто ізолювати ренту, повернену конкретно
за wallet1/wallet2, від решти живого трафіка на спільному `fee_payer` — неможливо без
виділеного тестового ключа; рекомендація в «Відкрите» нижче.

### 5. M-K — нагадування користувачу (ручний прогін на Phantom/AVD)

Агенти емулятор не запускають (правило з тижня 2/3, знято лише для верифікації з тижня 5+, не
для повного мобільного UX-прогону з реальним гаманцем — Phantom sideload не автоматизований
у цій сесії). **Чек-лист для користувача:**

1. Підняти AVD з `-dns-server 8.8.8.8,8.8.4.4` (DNS-блипи `rpc.magicblock.app` без цього —
   знахідка тижня 2, `week2-results.md`).
2. Sideload Phantom (devnet mode), відкрити застосунок Dexxer.
3. Онбординг → SIWS-промпт має показувати **«Dexxer»** (не generic origin).
4. Онбординг-батч → `signTransactions` з **усіма 3 payload одним екраном** (не 3 окремі
   промпти).
5. ER-леґ (init_permissions+set_session) підписується з **TEE-blockhash** (не base) — якщо
   Phantom показує помилку про застарілий blockhash, це регресія.
6. Результат (PASS/нюанси кожного пункту) — дописати сюди або в окремий feedback-файл пам'яті.

### Відкрите після Task 7

1. ~~**Черга `HgvCy4r2W5W3q4JmkEDYCQ3rSXbNNXMAypdb9zYuVHEY` (власник `devnet-overflow`'s
   `DsTSr…`) лишається застряглою**~~ — **ЗАКРИТО 24.09.2026, фінальна фікс-хвиля (C1).**
   Стан на момент закриття був `len=8, uncommitted=2, due=6`. Висновок Task 7 «дефект не про
   кількість дій у бандлі» був **хибним**: дефект був саме про кількість, просто клієнтський
   бюджет ніколи не долітав до програми. `commit_aggregate` не мав аргументів — `room` брався
   з `MAX_ACTIONS_PER_COMMIT = 8`, тож ця одна черга емітила всі 8 дій на кожному виклику,
   незалежно від `COMMIT_MAX_ACTIONS`; 8 реальних дій = виміряний FAIL бриджу. Це ж пояснює,
   чому halve-and-retry не допомагав: з однією чергою `selectCandidates(pending, 4)` і
   `(pending, 2)` повертали той самий `[queue]`, тобто «зменшений» ретрай був байт-у-байт та
   сама транзакція. Карантин (fix round 1) лишається в коді як defence in depth, але більше
   не є єдиною відповіддю. Доказ дренажу — §«Фінальна фікс-хвиля» нижче.
2. **`init_user_reuse_queue`-вікно не зловлене на devnet** — при 60-тиковому janitor-і обидва
   проходи (ER+база) виконуються в одному циклі без паузи між ними; шлях лишається
   верифікованим лише в LiteSVM. Якщо вікно принципово важливе для продукту (а не лише
   теоретична можливість), варто або штучно розсунути два паси в часі для тестування, або
   прийняти, що на практиці воно ніколи не відкривається достатньо довго для зовнішнього
   клієнта.
3. **`fee_payer` ділить один ключ із живим `/sponsor`-трафіком** — будь-який майбутній
   точний cost-accounting вимір (рента за цикл, вартість onboarding) буде зашумлений чужими
   викликами. Рекомендація: виділений тестовий `fee_payer` для вимірювань, або читання
   `sponsor.today_sol`/`count_today` до і після як контроль (зроблено тут post-hoc, спрацювало
   — див. §4).
4. **`COMMIT_INTERVAL_TICKS=60` vs `300`** — рішення для демо не прийнято в межах Task 7
   (успадковано відкритим з Task 6/week-4).
5. **M-H/M-J скрипти — окремі однопрогонні бюджети таймаутів (100 с / 360 с) занадто тісні**
   для реальної живої мережі під навантаженням §0's дефекту — обидва тести технічно «FAIL»
   за власним вердиктом скрипта, хоча M-H своєю метою досяг (post-hoc підтверджено), а M-J's
   overflow-recovery — ні (черга й досі стоїть). Наступного разу — або довший бюджет, або
   окрема post-hoc перевірка як зроблено тут.
6. **M-K** — не виконано агентом (правило), чек-лист вище чекає на користувача.

---

## Фінальна фікс-хвиля (24.09.2026) — C1 і мінори фінального ревʼю

Ревʼю гілки: `.superpowers/sdd/2026-09-23-week5-reliability/final-review-report.md`
(вердикт «Ready to merge — with fixes»). Звіт про виконання:
`.superpowers/sdd/2026-09-23-week5-reliability/final-fix-report.md`.

### C1 — механізм застряглої черги і його фікс

**Що було.** `commit_aggregate` не приймав аргументів: `process_disclosure_queue_candidate`
рахував `room = MAX_ACTIONS_PER_COMMIT.saturating_sub(actions.len())`, тобто бюджет дій був
**програмною константою**, а єдиним важелем клієнта лишався набір черг у `remaining_accounts`.
Для ОДНІЄЇ черги програма планувала всі її pending-дії, до 8, незалежно від
`COMMIT_MAX_ACTIONS`. 8 реальних дій = виміряний бридж-FAIL `0xA0000002` (Task 7), 4 = PASS.

**Наслідки, усі з яких збігалися зі спостереженим дефектом:**

1. черга, що набрала ≥5 pending-дій між циклами, більше ніколи не комітилася;
2. halve-and-retry був no-op для такої черги — `selectCandidates` з бюджетом 4 і 2 повертав той
   самий `[queue]`, тобто ретрай був байт-у-байт та сама транзакція (звідси «FAIL на кожному
   бюджеті 8→1» з Task 7 — вимірювалося не те, що впливало);
3. для трейдера це не косметика: `DQ_CAPACITY`-повне кільце робить `close_position` хардфейлом
   `QueueFull`, а `liquidate_now` — скіпом, тобто позицію **ні закрити, ні ліквідувати**.

**Фікс.** `commit_aggregate(max_actions: u8)`, `budget = max_actions.clamp(1,
MAX_ACTIONS_PER_COMMIT as u8)`, `room` рахується від `budget`. `MAX_ACTIONS_PER_COMMIT = 8`
лишається жорсткою СТЕЛЕЮ. Relayer передає `COMMIT_MAX_ACTIONS` як аргумент і халвить його ж
(а не лише бюджет вибірки) на `0xA0000002`. Коментар константи в `state/mod.rs` виправлено на
виміряну правду (8 FAIL / 4 PASS на реальній формі; фігура тижня 3 «28/29» стосувалася дешевого
спайку і цю форму не описує).

**Тести.** LiteSVM 87 → **89**: `single_queue_never_exceeds_requested_budget` (одна черга,
5 незакомічених записів = 10 потенційних дій; `max_actions=4` → `actions=4`, усі 4 пішли на
commitments, нічого не popped; другий виклик → `actions=4`, `len` 5→2; третій → `actions=2`,
`len`→0 — кільце реально дренується) і
`max_actions_is_clamped_to_one_and_to_the_program_cap` (`0`→`actions=1`, `200`→`actions=8`).
Relayer 100 → **102** (два нові — M2, нижче). Unit — **61**, без змін.

### Апгрейд #3 і живий доказ дренажу

| | |
| --- | --- |
| Підпис деплою | `eXAtUAVtzb66Hk5sRkYaLE4afAKXtM2VXUqcNg5qMfLvBee5GSjCJwA3Hjmu39LdvdnzTuUUndp9xUjJ2CemBpg` |
| Слот | `503324217` |
| SOL payer-а до / після | `6.944625579` → `6.938610579` (**0.006015 SOL**; рента буфера ≈6.2 SOL повернулася) |
| `extend`? | не потрібен — `.so` 1 213 904 B ≤ `Data Length` 1 310 416 B |
| Верифікація | `solana program dump` == локальний `.so`: `93b258298ac351555b06a9c6ff8049136a7e0884a3dcfea16ac6f32a7a848eb0`; `cmp target/idl/dexxer_core.json app/src/idl/dexxer_core.json` — байт-у-байт |
| Relayer | `railway up --service relayer --ci` (`COMMIT_MAX_ACTIONS=4` вже стояв), `/healthz` → `commitMaxActions:4`, `crankEnabled:true` |

**Дренаж отруєної черги `HgvCy4r2W5W3q4JmkEDYCQ3rSXbNNXMAypdb9zYuVHEY` (власник
`DsTSrhSCHtCCcnyhqcuki8w34YQujfv1xs2mYhdE1fPg`)** — поллінг `len` через TEE з crank-ключем
(`tests/er/.keys/devnet-crank.json`), `COMMIT_INTERVAL_TICKS=60`:

| UTC | ER-слот | `len` | Що сталося |
| --- | --- | --- | --- |
| 05:54:49 | 347 541 664 | **8** | до апгрейду relayer-а: 6 due (`cw=true`) + 2 незакомічені |
| 05:56:29 | 347 551 739 | 8 | — |
| 05:57:43 | 347 559 101 | 8 | — |
| 05:58:56 | 347 566 436 | **6** | цикл 1: 2 `write_commitment` (записи 7–8) + 2 `write_disclosure` = **4 дії** |
| 06:00:10 | 347 573 816 | 6 | — |
| 06:01:33 | 347 582 106 | **2** | цикл 2: 4 `write_disclosure` = **4 дії** |
| 06:02:47 | 347 589 457 | 2 | — |
| 06:04:00 | 347 596 781 | **0** | цикл 3: 2 `write_disclosure` = **2 дії** — кільце порожнє |
| 06:05:13 / 06:06:26 | — | 0 | стабільно порожня |

**Підписи L1-дій (`Disclosure`-PDA, зчитані `getSignaturesForAddress` на базі):**

| Цикл | Підпис (L1) | blockTime | Записи (nonce → `Disclosure` PDA) |
| --- | --- | --- | --- |
| 1 | `5azQNpo8Gtye9R8Wi5Gu63hPPhmvrfs9eNJ7ZTPr1zgt5GMBdVt5vQVMC2AZXMJX5AmEuCba1VfKVPaXnvvCXVyd` | 05:58:36Z | 1 → `8mLMfGDZ5ZxjVnEEqfzDtikJhUZimvattdRh54GhP9hi`, 2 → `FZUs9d4tJz84VJ8eAfiqcH4mfpQeVybgjaP5P3PCr7MY` |
| 2 | `5TNUKiAXkQxSPkwq6gyMEUgTsYBdw7EqqexGgb9g2DWnC492CFHkhgsZeukejHHrHh3JFgdx6ZvBrcwUBJtxtg5X` | 06:00:49Z | 3 → `J9Sq4mJJh24jDj2gFnZKzt7RtGhJ6acbVB5rCmXVBP8y`, 4 → `257BUEU5zXMuVhz3JXEVa1RWNLjUSsLAkkAcuB4azVDY`, 5 → `87bM42QarePTPV1S8n3MQSFucTPQ1eRHiuPr57dAkoM7`, 6 → `6JpeZ2GSUfQ1emzJWT4BqzugfNYNFLR4Gpe4zC246YK7` |
| 3 | `1pVBYBrLrWPjVL9E9XBhZBBuJTXK6hWu1yAKpbF4yurbBAgznkEod86nGs5AVjSuYBxajEst9T4jYnN7t4heqV9` | 06:03:01Z | 7 → `GJ5z8YewxK4qDqE7bTQaGRBVvFhyjtk2kSypqxivHS65`, 8 → `GyRNRkWyL5ijZQ7yHdNToiexntsCsc6hCZj8WU3Ycjy8` |

Усі 8 записів черги, що «застрягла назавжди», розкриті на L1 за **три цикли ≈ 5 хвилин**, без
жодного ручного `commit_aggregate` — рівно те, що прогнозував C1. Ризик #26 закрито.

### Мінори тієї ж хвилі

| # | Що | Де |
| --- | --- | --- |
| I2 | Коментар на `MAX_ACTIONS_PER_COMMIT` казав «far under the bridge cap 28/29» — та фігура з тижня 3 знята на дешевому спайку. Тепер: 8 FAIL / 4 PASS на реальній формі, і що кількість у бандлі обирає викликач | `state/mod.rs` |
| M1 | Твердження «`nonce` не скидається / рухається лише вперед» було хибним — скраб `undelegate_user` виставляє `nonce = 0`. Виправлено в коді й у CLAUDE.md/спеці: колізій немає, бо salt — `keccak(owner, nonce, slot)`, а слот завжди вперед | `instructions/user.rs`, CLAUDE.md, spec §4.2 |
| M2 | `/sponsor`'s `ATA_SHAPE` пінить `mint`@3 до `Config.dusdcMint` (читається з бази на старті relayer-а); fail-closed, якщо мінт невідомий. Раніше власник міг змусити `fee_payer` профінансувати ATA довільного мінта й закрити його заради ренти | `services/relayer/src/{sponsor,index}.ts` + 2 тести |
| M3 | `liquidation_check` більше не приймає `Config.scheduler_signer` (market-schedule identity не має що робити на per-position шляху), і порівняння зі `liq_crank_signer` стоїть ПЕРШИМ — на нормальному (запланованому) тіку це економить два `find_program_address` | `instructions/liquidation.rs` |
| M4 | `open_registers_task_idempotently` → `open_skips_task_registration_without_magic_program`; повідомлення асертів прямо кажуть, що LiteSVM не має Magic-програми і ідемпотентність тут НЕ перевіряється (це devnet-вимір Task 0) | `tests/litesvm/tests/liquidation.rs` |
| M5 | Мертві хелпери `buildInitPermissionsIx`/`buildSetSessionIx` видалено; контракт `readErUserAccount` (`null` = «нема», undecodable = `{exited:false}` = «вважати живим») задокументований на інтерфейсі, не лише в catch | `services/relayer/{test/sponsor.test.ts,src/orphan.ts}` |
| M6 | `delegate_user`'s ручний `try_deserialize` — пояснено, чому явна перевірка власника не потрібна (адресу виводить `#[delegate]`-макрос із seeds) | `instructions/user.rs` |
| I1/I3/I4 | Код не змінювався — заведені як ризики #37/#38/#39 у спеці §7.1 + політичний рядок біля `close_exited_user` у §4.2 | spec |
