# Тиждень 6 — бек-лог (узгоджено 24.09.2026)

Джерела: фінальне ревʼю тижня 5 (`week5-results.md`, ризики #37–39), виміри Task 7, smoke-тест із реальним
Phantom (24.09), доки MagicBlock (fees, runtime limits, magic actions), джерела `magicblock-validator`
(committor `TaskStrategist`). Пріоритет: **надійність → безпека/міграція → продукт**. Спека — новий §2.7
(brainstorming → writing-plans → SDD), як у тижнях 3–5.

**Статус (02.10.2026, після PR #12 «графік C.5, частина 2»; змерджено в `main` 03.10, `e70bcbe`):** C.5 ✅ — 16 таймфреймів
і свічки `1m/1h/1d` у Postgres задеплоєно на devnet (деплоймент `0968a8e6`), бекфіл історії — Hyperliquid без ключа
(Pyth Pro відкинуто), атрибуція TradingView увімкнена, smoke апки на AVD PASS; лишились release-APK і Postgres-тести
локально. Поза бек-логом: ✅ ретеншн `ticks` (7 діб); ✅ стейл-тіки оракула більше не пишуться в БД. Виміри —
`week6-results.md` «Графік C.5, частина 2»; правила — CLAUDE.md «Правила тижня 6: графік…». Решта зведення — як на 01.10.

**Статус (04.10.2026, після ревʼю PR #13 «умовні ордери» колеги → PR #14):** C.5 ✅ змерджено (PR #12, 02.10).
Пункт 6.B «умовні ордери» 🟡 — Limit/Stop-market/TP/SL/Trailing у PR #14 (гілка `feat/conditional-orders-rebased`,
не змерджено, на devnet не деплоєно); два блокери ревʼю виправлено 04.10 (невалідований `feed` у `place_order`;
опційний хвіст ордерів замість зростання `Positions`, legacy-акаунти не цегляться); 6.B Margin mode Isolated/Cross ⬜,
6.B Borrow Rate ⬜; stop-limit і виконання ордерів кранком relayer-а — не зроблено. Коміти #14: `564c10f` злиття,
`8093519` feed, `732928b` опційний хвіст, `15faede`/`266146f` документи; CI на #14 — див. PR. Перший вимір на devnet —
smoke-гаманець `2TQe…` (3184 Б) після апгрейду: ордери мають дати `OrdersUnsupported`, решта працювати. Виміри/ревʼю —
`week6-results.md` «Умовні ордери»; правила — CLAUDE.md «Правила умовних ордерів».

**Статус (01.10.2026, після PR #11 «позиції-слоти», плани 1–4; PR відкритий, CI зелений, не змерджений):**
✅ — зроблено (у `main` або в PR #11); 🟡 — частково; ⬜ — не почато; ⛔ — знято редизайном.
Зведення: A.1 ⛔ (розкриття скасовано), A.2 ✅, A.3 ✅, A.4 ✅, A.5 ✅ виміряно, A.6 ⛔, A.7 🟡;
B.1 ✅ (+ `SIWS_DOMAIN` на prod 01.10), B.2 ⛔ → чистий старт на новій програмі, B.3 ✅, B.4 ✅;
C.1 ✅ (мульти-маркет на devnet: SOL/BTC/ETH/HYPE/ZEC), C.2 🟡, C.3 ⬜, C.4 🟡, C.5 🟡, C.6-A 🟡, C.6-B ⬜, C.7 🟡.
Поза бек-логом: ⛔ `/disclosures`, `/stats` видалено разом із розкриттям (план 2); ✅ `GET /markets`,
`?market=`, `/ws?markets=*`; ✅ рефакторинг `app/` (PR #7); ✅ прапорці фіч (PR #9; `ledger`/`commitReveal`
прибрано в плані 3). Виміри плану 4 — `week6-results.md`; правила — CLAUDE.md «Правила тижня 6: позиції-слоти…».

**Статус (29.09.2026, історично):** A — ⬜ усе; B.1 ✅ (PR #8), B.2 ⬜, B.3 ✅ (M-K тижня 5), B.4 ✅ (PR #7);
C.1 🟡 програма (PR #10), C.2 🟡 відео, C.3 ⬜, C.4 🟡 / C.5 🟡 / C.6-A 🟡 / C.7 🟡 Trading rules (PR #9), C.6-B ⬜.

## A. Надійність (обовʼязково, ~60%)

1. ⛔ **Ризик #37 — запис губиться, якщо L1-дія впаде після pop.** **Знято 30.09.2026 (spec §2.9):** угоди більше не розкриваються — `DisclosureQueue`, `write_commitment`/`write_disclosure` і Base Actions з програми видалено; губити нічого. Історія трейдера — приватне кільце на 16 записів у `Positions` + архів на пристрої (план 3). `due_reveals` знімає запис із черги в тій
   самій ER-tx, що планує `write_disclosure`; якщо міст скине дію (`0xA0000002`, або `Commitment`
   відсутній), 13F-обіцянка для цієї угоди мовчки провалюється. Фікс: прапорець «reveal scheduled» на
   записі, зняття лише після того, як crank побачив `Disclosure` на L1 (crank-асертований, як колишній
   `mark_committed`, але для видалення, а не для запису). Програмна зміна + LiteSVM + апгрейд.
2. ✅ **Ризик #38 — гістерезис без per-sample guard.** **Зроблено (план 1) і виміряно (план 4):** семпл = новий прийнятий принт оракула (`Market.last_print`/`sample_seq`, `PositionSlot.last_liq_sample`), дефолт гістерезису 2; на devnet `posted_slot` Pyth Lazer змінюється на кожному принті (5 ринків × 47 принтів, 0 повторів), ліквідація лише планувальником 8.5–10.2 с, relayer-ом 2.9 с. `liq_ticks` інкрементується на кожен виклик
   (`crank_tick` + `liquidation_check`), три виклики в одному слоті ліквідують за одним семплом ціни.
   Фікс: поле `last_liq_mark_slot` у `Position` (зміна лейауту → міграція, див. B.2), інкремент лише при
   новому `Market.mark_slot`; дефолт `liq_hysteresis_ticks` повернути до 2.
3. ✅ **Ризик #39 — `close_exited_user` віддає рент `fee_payer` беззастережно.** **Зроблено (план 1) і виміряно (план 4):** `UserAccount.rent_payer`, janitor повертає ренту власнику повністю (18 541 288 лам. за `UserAccount`+`Positions`, ≈50 с після виходу). Для акаунтів до тижня 5 рент
   платив власник. Фікс: `rent_payer: Pubkey` в `UserAccount` (та сама міграція), рент → `rent_payer`.
4. ✅ **Ліквідація трейдера з повним кільцем.** **Зроблено (план 1):** черги нема; `finalize_close` пише в кільце історії й ніколи не падає через заповненість (17-те закриття перезаписує найстаріше). Стеля — 16 одночасних позицій (`NoFreeSlot`), це інше обмеження. Зараз `liquidate_now` пропускає кандидата з `dq.len == 8` →
   поганий борг накопичується, поки черга не дренується. Варіанти: зарезервований слот під ліквідацію;
   витіснення найстарішого записаного (`commitment_written`) запису; окремий `bad_debt`-запис поза чергою.
   Обрати у brainstorming; тест LiteSVM «повне кільце + underwater → ліквідовано».
5. ✅ **Економіка `commit_aggregate` (виміряно з доків MagicBlock).** **Виміряно на devnet (план 4):** дій у бандлі більше нема, `commit_aggregate()` = 48 376 CU і **200 000 лам.** з `FeeEscrow` на коміт (перші коміти нової програми — 0, ймовірно безкоштовна квота, не перевірено); relayer повернуто на `COMMIT_INTERVAL_MS=300000` (≈0.058 SOL/добу; 60 с спорожнив би 0.2 SOL за ≈16 год). Ціна Base Action =
   `CU_requested × 50 000 / 1 000 000` лампортів: наші 100k/120k CU → 5–6k за дію (~22k за бандл із 4).
   Виміряти реальні CU `write_commitment`/`write_disclosure` і знизити `compute_units` у `CallHandler`.
   З 26-го коміту — 100 000 лампортів за кожен закомічений акаунт (`Pool`+`BalancesRoot` = 200k/цикл):
   при `COMMIT_INTERVAL_TICKS=60` це ≈0.29 SOL/добу з `fee_payer` → для продукту повернути **300**.
6. ⛔ **Бридж-ліміт дій — питання до MagicBlock.** **Знято:** Base Actions у бандлі більше немає (A.1), `COMMIT_MAX_ACTIONS`/карантин видалено з relayer-а (план 2). Committor вміщує коміт + дії в одну L1-tx ≤ 1232 B
   (`TaskStrategist`, ALT/буфери стискають лише коміти, не аргументи дій); при провалі — `remove_actions`
   для всієї стратегії. Запит: multi-tx finalize / ALT для args дій. До відповіді — `COMMIT_MAX_ACTIONS=4`,
   `write_disclosure` полегшити (передавати менше байтів), карантин лишається як запобіжник.
7. 🟡 **Невиміряне з тижня 5** (виміряти, не чинити наосліп): ⬜ стійкість scheduler-задач до рестарту
   devnet-tee; ✅ задачі над вийшовшим акаунтом — за 10 хв простою списань, крім комітів, не видно (план 4);
   ⬜ чи ER шанує `ComputeBudget` 1.4M (`crank_tick` з 12 парами не виміряно — трейдерів замало, максимум 2 кандидати);
   ⛔ `init_user_reuse_queue` видалено — ре-онбординг = стан `Exited` в апці → janitor закриває → звичайний
   `init_user` (smoke-крок 9 ще не пройдено з гаманця).

## B. Безпека / міграція (~25%)

1. ✅ **#27 — SIWS-гейт `/sponsor`** (+ L1-гейт або invite): без нього спонсорування можна злити.
   Верифікація SIWS-підпису на relayer, звʼязка owner ↔ sponsor-слоти, денний бюджет уже є.
   **Зроблено (PR #8, spec §2.7):** `/sponsor` і `/nonce` лише із SIWS-сесією власника. Відкрито:
   Sybil (свіжі ключі безкоштовні — invite / Genesis Token / per-IP). ~~`SIWS_DOMAIN` на prod не
   виставлено~~ **виставлено 01.10.2026 (план 4)** — `/sponsor`/`/nonce` змонтовані, спонсорований онбординг
   з апки пройшов на новій програмі.
2. ⛔ **Міграція лейауту акаунтів.** **Знято рішенням 30.09.2026 (spec §2.9.5):** замість міграції — чистий старт на новій програмі `Fyg2…UfCY` (01.10.2026); стара `G2ok…` з legacy-акаунтами не закрита (незворотне рішення власника, повертає ≈4.6 SOL ренти). Міграція знадобиться лише перед мейннетом. **04.10.2026:** перше розширення лейауту після чистого старту (хвіст ордерів, PR #14) зроблено без міграції — опційний хвіст після незмінної структури, читання за довжиною акаунта; realloc делегованого акаунта в ER не виміряно, у референсах MagicBlock resize є лише для Ephemeral Accounts. `UserAccount` v1 (тижні 1–2) нечитабельний усіма типізованими
   інструкціями; 4 legacy Open-позиції на devnet — перманентний skew `oi_long`/`locked`. Для A.2/A.3 теж
   потрібна зміна лейауту → одна `migrate_user_account` (realloc + версія) + `admin_force_close_stranded`
   для devnet-сміття (або wipe devnet-стану перед мейннет-планом).
3. ✅ **MWA identity verification (Phantom).** Smoke 24.09: Phantom відхиляє `reauthorize` —
   `dApp identity is not verified (mwaIdentityVerified !== true)`. Треба власний домен як `identity.uri`
   з `/.well-known/assetlinks.json` (Digital Asset Links, package `com.dexxer.app` + SHA-256 signing cert).
   До того — один промпт авторизації на сесію підпису (hotfix `withAuthRetry`, тиждень 5). Upstream-баг
   `mobile-wallet-adapter-protocol@2.3.0` `index.native.js` (`return invoke(...)` без `await` →
   retry wallet-ui не спрацьовує) — зарепортити. Phantom Connect SDK (`@phantom/react-native-sdk`,
   deeplink) — лише як Phantom-only fallback після перевірки co-sign `fee_payer`; MWA лишається основним
   (Seeker).
   **✅ Зроблено (M-K, 24–25.09):** relayer віддає `/.well-known/assetlinks.json`, `identity.uri` =
   origin relayer-а; патч `protocol@2.3.0` через patch-package, upstream PR
   solana-mobile/mobile-wallet-adapter#1680; durable nonces і self-fund для Phantom. Верифікацію
   підтверджено на fakewallet, на Phantom — ні. Release-APK мусить виставити свій SHA-256 відбиток.
4. ✅ **Шаблонні залишки в app:** root-гейт `/sign-in` («app» + placeholder-іконка), `AppConfig.uri`
   був `https://example.com` (виправлено hotfix-ом) — привести до брендингу Dexxer; `WalletUiDropdown`
   у хедері Account. **Зроблено (PR #7):** `/sign-in` = продуктовий `ConnectScreen`, спайки видалено,
   оболонка на токенах `src/ui`.

## C. Продукт (~15%, якщо A/B вкладуться)

1. ✅ **Мульти-маркет** (уточнено 27.09): додати **BTC-PERP, ETH-PERP, HYPE-PERP, ZEC-PERP** до
   SOL-PERP, кілька одночасних позицій на трейдера (`Position` per market — сіди
   `[b"position", owner, market]` уже це дозволяють). Це друга половина перп-ядра, не UI-фіча;
   відкриті питання перед дизайном (brainstorming → spec): (а) чи публікує оракул MagicBlock
   фіди Pyth Lazer для HYPE і ZEC — перевірити першим; (б) крос-маржа vs ізольована —
   `UserAccount` зараз тримає одну маржу під одну позицію; (в) ліквідація на рівні акаунта
   при крос-маржі — `liquidation_check` per position недостатньо; (г) `BalancesRoot`/`Pool`-знімок
   і `SNAPSHOT_STEP` для кількох ринків; (д) стейлнес окремо на кожен фід; (е) UI — вибір ринку
   на Trade, список позицій замість однієї картки, колонка ринку в History; (є) міграція лейауту
   devnet-акаунтів (перетинається з B).
   **🟡 Програма — PR #10 (план 1 з 3, spec §2.8):** ринок = символ (`init_market(symbol)`), позиція
   на кожному ринку створюється разом, не при угоді (`init_position`/`delegate_position`/
   `init_position_permission`, вихід — `undelegate_position`/`close_exited_position`), маржа
   ізольована (б), ліквідація per position (в), `set_session` оновлює permissions усіх ринків;
   LiteSVM 107, unit 64. ~~Лишилось: план 2 (relayer, admin-TS, `add-market`), план 3 (апка: вибір ринку,
   список позицій, колонка ринку в History), апгрейд на devnet і додавання BTC/ETH/HYPE/ZEC.~~
   **✅ Зроблено 30.09–01.10.2026 (PR #11, редизайн «позиції-слоти», spec §2.9, плани 1–4):** замість
   `Position` на ринок — один zero-copy `Positions` на трейдера з 16 слотами (ринок у даних слота) і
   кільцем історії; новий ринок = одна адмін-tx (`add-market --schedule`), нуль дій на трейдера;
   relayer — реєстр ринків, `GET /markets`, `?market=`, `/ws?markets=*`, пари `[Positions, UserAccount]`;
   апка — перемикач ринку, торгівля на обраному, список позицій зі слотів, History з кільця + архів;
   devnet — SOL/BTC/ETH/HYPE/ZEC живі з кранками (гейт (а) закрито: Lazer-фіди HYPE 110 і ZEC 66 є),
   ліквідація лише одного ринку підтверджена (16). Лишилось: smoke-кроки 8–9 з гаманця, Phantom.
2. 🟡 Відео/пітч, тег `v0.4-mvp`. Launch-відео 21 с зроблено (/brag, 27.09, `brag-output/`); тегу ще нема.
3. ⬜ Тех-борг тижня 5 (Task 9): `permissions.rs`-модуль, `Toast`/`Sheet` таймери, WS ping/pong,
   `listBaseOwners` O(n) → індекс по `exited`.
4. 🟡 **UX торгового екрана (додано 27.09 за ревʼю «три опори» трейдинг-апок):**
   - пресети суми (10 / 50 / 100 dUSDC) і плеча (2× / 5× / 10×) кнопками замість полів вводу;
   - фандинг і сумарний OI пулу на Trade — OI є в `Pool`-знімку (огрублений `SNAPSHOT_STEP`),
     фандингу в програмі немає взагалі — спершу вирішити, чи він потрібен у MVP;
   - add/remove margin на картці позиції — `increase/decrease_position` є, окремої кнопки під
     заставу немає;
   - плашка TP/SL під перемикачем «Advanced» як «скоро» (функції ще нема, трейдер має бачити напрям);
   - алерт «Approaching liquidation» → одразу на Add margin: серверний push неможливий
     (сервер не бачить приватну позицію) — лише локальні нотифікації з апки у фоні через
     `accountSubscribe`.

   **🟡 PR #9:** зроблено Add margin на картці позиції (`add_margin`; remove margin у програмі нема).
   **PR #11 (план 4, `b276769`):** слайдер плеча й MAX обмежені `max_lev_bps` ринку (HYPE/ZEC 5×) — дефект
   smoke. Не зроблено: пресети суми/плеча, плашка TP/SL «скоро», локальний алерт ліквідації; фандинг —
   рішення разом із Borrow Rate (C.6-B).
5. ✅ **Графік як у TradingView** — **статус (02.10.2026, PR #12):** ✅ 16 таймфреймів (relayer задеплоєно 02.10, деплоймент `0968a8e6`: `/prices` на 16 tf × 5 ринків, свічки `1m/1h/1d` у Postgres, ретеншн тіків 7 діб; app — smoke на AVD PASS, дві знахідки виправлено `e8f7947`); ✅ бекфіл історії — Hyperliquid `candleSnapshot` без ключа (`1d` з 2023 для SOL/BTC/ETH/ZEC, HYPE з 12.2024; Pyth Pro відкинуто: trial-ключ, далі $500/міс; Binance — `HYPEUSDT` лістнуто лише 24.09); ✅ атрибуція (`attributionLogo: true`, клік → tradingview.com); ⛔ обсяг/VWAP (свідомо — обсяг приватний); ⬜ лише release-APK (smoke на dev-client) і Postgres-тести локально. **Опис (додано 27.09):** замість власного `PriceChart` — повноцінний
   свічковий графік з масштабуванням/прокруткою, crosshair із ціною і часом, лініями
   entry/liq-price/mark поверх свічок, обсягом і базовими індикаторами (EMA, VWAP).
   **Таймфрейми (уточнено 27.09):** 1s, 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 24h, 2D, 5D,
   1W, 1M. Наслідок для indexer-а relayer-а: свічки зараз агрегуються з тіків оракула в памʼяті
   (зараз 1m/5m/15m) — 1s потребує зберігати сирі тіки, а 1W/1M — довгострокове сховище
   (Postgres уже є) і бекфіл історії, бо оракул не віддає минуле; ці два краї — окремі задачі.
   **Типи графіка (уточнено 27.09, як у TradingView):** Bars, Candles, Hollow candles, Line,
   Line with markers, Step line, Area, HLC area, Baseline, Columns, High-low, Heikin Ashi —
   перемикач у тулбарі поряд із таймфреймами, обрані типи можна «зірочкою» винести в швидкий
   доступ. Також з референсу: панель обсягу під ціною, лінія останньої ціни з ярликом на осі,
   ярлики High/Low за видимий діапазон, OHLC-рядок над графіком, перемикач A/L (auto/log
   шкала), чекбокс «Positions on chart» (entry/liq поверх свічок) і Close All. Усі 12 типів —
   лише різні рендери одних OHLCV-свічок, тож даних більше не потрібно; `lightweight-charts`
   покриває Bars/Candles/Line/Area/Baseline/Histogram нативно, решта — обчислювані серії
   (Heikin Ashi, HLC area, Step line) або кастомний рендер. Кандидат — `lightweight-charts` (TradingView, Apache-2.0) у
   WebView або `react-native-wagmi-charts`/Skia-порт; дані — з indexer-а relayer-а
   (`/prices`, свічки вже агрегуються). Рішення про бібліотеку — окремий спайк.
   **🟡 PR #9:** обрано `lightweight-charts` 5.2.1 у WebView (вшито в APK через `scripts/gen-lwc.ts`,
   без CDN); 12 типів зі «зірочкою», A/L, EMA 20, лінії entry/liq, pinch-зум, налаштування в
   AsyncStorage. Не зроблено: таймфрейми крім 1m/5m/15m (потрібен relayer), панель обсягу і VWAP
   (обсяг приватний, в оракула його нема — свідомо), атрибуція TradingView (логотип вимкнено —
   потрібна за ліцензією).
6. 🟡 **Торговий термінал — фічі з референсів (додано 27.09; Jupiter-подібний хедер, Telegram
   Wallet mini-app, CEX-тикет).** Dexxer — оракульний перп із пулом-контрагентом і виконанням
   за mark, без стакана, тому кожну фічу перекладено на нашу модель:

   **A. Лише UI, дані вже є (черга після C.4):** 🟡 PR #9 — зроблено хедер (значок, бейдж макс.
   плеча, ціна, зміна, High/Low зі свічок, Available liq. з `/pool/latest`), вкладки Open / Close
   (частковий `decrease_position`), згортуваний графік, Positions (n) / Open Orders (0), About +
   Perpetuals + Risk disclosure. OI свідомо не показано (приватний `MarketRisk`), 24H Vol — теж.
   Не зроблено: +/− і SOL ↔ dUSDC, слайдер плеча, Max Long / Max Short, «Avail.» → Deposit,
   кнопки Long / Short унизу.
   - Хедер ринку: тікер + значок, макс. плече (`250x`-бейдж), ціна великим і зміна за 24h;
     рядок статистики **24H High / 24H Low** (індексер зі свічок), **Available Liq.** (вільна
     ліквідність пулу на сторону з публічного `Pool`-знімка), **Open interest** (з того самого
     знімка, огрублений). **24H Vol** — обсяг приватних угод; віддавати лише огрублено з 5-хв
     знімка або не показувати (витік при малій кількості трейдерів — те саме, що агрегат пулу).
   - Тикет: вкладки **Open / Close** (Close = частковий `decrease_position` за сумою, зараз є
     лише «закрити все»); **Avail.** з іконкою переказу → Deposit; поле суми з **+/−** і
     перемикачем одиниці **SOL ↔ dUSDC**; слайдер плеча з фіксованими кроками; **Max Long /
     Max Short** із маржею під ними (free margin × плече, обрізано лімітом OI з `MarketRisk`).
   - Під тикетом: вкладки **Positions (n) / Open Orders (n)**, згортуваний графік
     («Perpetual Chart · Show»).
   - **Info / About / Risk disclosure** як у Telegram Wallet: блок Info (24h volume, OI,
     ставка), текст «Trade SOL price movements … up to N× leverage», посилання «Learn more
     about Perpetuals» і «View risk disclosure» — потрібно для dApp Store і для новачків.
   - Кнопки **Long / Short** унизу екрана ринку (Telegram-стиль) як альтернатива тикету.

   **B. Потрібна робота в програмі (умовні ордери — один механізм на все):** 🟡 (ордери — PR #14; margin mode, borrow rate — ⬜)
   - **Limit** (виконати, коли mark ≤/≥ ціни), **Trigger / Stop** (умовний market/limit),
     **TP/SL** (чекбокс у тикеті + на картці позиції), **Trailing Stop** (тригер, що crank
     підтягує за ціною). Усе це — записи умовних ордерів у приватному per-user акаунті
     (новий `OrderQueue` або поле в `UserAccount`), які виконує crank / scheduler-задача при
     перетині ціни оракула — вкладається в модель `[owner, session, crank]`, як
     `liquidation_check`. Спека: окремий дизайн (brainstorming), торкається `Trade`-акаунтів.
   - **Margin mode Isolated / Cross** з описами як у референсі + «Apply to all futures»:
     зараз фактично isolated (маржа блокується на позицію, add/remove — C.4); Cross =
     ліквідація на рівні акаунта — це питання (б)/(в) з C.1, вирішувати разом із мульти-маркетом.
   - **Ставка утримання**: замість Funding/Countdown (біржова модель довгих/коротких) —
     **Borrow Rate %/hr** за утилізацією пулу (як у Jupiter; хедер референсу показує саме
     його). Це природно для пулу-контрагента і закриває питання «фандинг» із C.4.

   **🟡 PR #13 → #14 (колега, 03–04.10.2026):** ордери як опційний хвіст `Orders = [OrderSlot; 8]` (704 Б) після
   `Positions`, виконує той самий per-(трейдер, ринок) `liquidation_check` → `run_orders`; `place_order`/`cancel_order`
   на `Trade` (12 акаунтів); у апці Market/Limit/Stop + TP/SL у тикеті, Open Orders, «Add TP / SL» на картці.
   Зроблено: Limit, Stop-market, TP/SL, Trailing (підтягує планувальник раз на 5 с, не crank relayer-а). Не зроблено:
   stop-limit, ордери в `crank_tick` relayer-а, частковий TP/SL, резервування маржі, Margin mode, Borrow Rate.
   Ревʼю 04.10: блокери — злиття видалило `docs/android-install-options.md` (виправлено PR #14), невалідований `feed`
   при перереєстрації задачі (виправлено), зростання `Positions` 3184 → 3888 Б без міграції (виправлено опційним
   хвостом). Відкриті середні: повторне відкриття на тіку ліквідації через вхідний ордер; `attach_exits` мовчки губить
   SL без вільного слота; вхідні ордери приймаються вже спрацьованими; TP/SL не перевіряються проти ціни виконання;
   «SOL» у підписі ордера. На devnet не виміряно нічого (реєстрація задачі з `place_order` — scheduler застосовує оновлення
   асинхронно, міряти за фактом виконання, не за успіхом tx; планове виконання вхідного ордера; CU `run_orders`; legacy-акаунт
   `2TQe…` після апгрейду). Розкатка: програма + relayer разом (новий декодер приймає обидві довжини).

   **C. Не застосовно до нашої моделі (не робити):**
   - Стакан ціна/обсяг, співвідношення B/S 57 % / 43 %, розмір тіку `0.01` — немає order book;
     ціна одна (mark з оракула). Замість стакана — «Available Liq.» і Max Long/Short.
   - **Post Only**, **Chase Limit Order** — концепції мейкера в стакані.
   - «AI Strategy», сторонні лістинги в тикеті (реклама OURA), вкладки Stocks/TradFi/Metals.
   - «MTL» у референсі — призначення неясне; не переносити без пояснення.

   Порядок: A після C.4 (один спринт UI), B.Borrow Rate разом із C.4-«фандинг», ~~B.умовні
   ордери — окремий тиждень після мульти-маркету або замість нього (продуктове рішення)~~ — зроблено
   колегою після мульти-маркету (PR #13 → #14, 03–04.10). Далі: Margin mode потребує окремого дизайну
   (формула equity акаунта з кількох фідів, задача планувальника на трейдера, правило закриття слотів).
7. 🟡 **Інформація по активу — вкладка «Token information» (додано 27.09; референс — Aster).**
   На екрані ринку три вкладки: **Chart / Token information / Trading rules**; хедер із
   значком активу, тікером, бейджем `Perp`, кнопками share / alert / favorite.
   Зміст Token information:
   - назва, тікер, ранг (`#1`), дата запуску;
   - Overview / Utility and Mechanics / Ecosystem — короткий опис зі згортанням («Show less»);
   - картки **All-time high / All-time low** з датами;
   - таблиця: Market cap, Fully diluted market cap, 24h volume (спотовий, ринковий — не наш),
     Market dominance, Circulating supply, Max. supply, Total supply, Circulating rate;
   - кнопки-посилання Website / Whitepaper / Explorer / GitHub;
   - дисклеймер про джерело даних («sourced from CoinMarketCap … as is»).
   **Trading rules** (третя вкладка) — параметри саме нашого ринку: макс. плече, IMR/MMR,
   мін./макс. розмір позиції, крок ціни, комісія відкриття, ліміт OI, borrow rate, поріг
   стейлнесу оракула, `SNAPSHOT_STEP`; усе це вже є в `Market`/`MarketRisk`/`Config`.
   **Реалізація:** relayer — новий публічний ендпоінт `/assets/:symbol` (кеш 5–15 хв) поверх
   CoinGecko (безкоштовний, без ключа) або CoinMarketCap (ключ, як у референсі); статичні
   описи/посилання — JSON у репо (`docs/design/assets.json` або в relayer-і), щоб не залежати
   від зовнішнього API для тексту. Апка — екран `AssetInfoScreen` із трьома вкладками,
   Long/Short знизу. Дані ринкові й публічні, приватності не торкаються. Залежить від C.1
   (список активів BTC/ETH/HYPE/ZEC), для SOL можна зробити одразу.
   **🟡 PR #9:** вкладка Trading rules (перемикач Chart / Trading rules; параметри публічного `Market`
   за фіксованими офсетами, OI cap за замовчуванням — 30 % знімка пулу).
   **✅ Token information (04.10.2026, гілка `feat/token-information`, лише тести — на devnet/пристрої НЕ виміряно):**
   relayer `GET /assets/:symbol` (`services/relayer/src/assets/`: `staticAssets.ts` + `assets/assets.json` — текст і https-посилання
   в репо для SOL/BTC/ETH/HYPE/ZEC; `coingecko.ts` — `coins/{id}` + `global`; `service.ts` — кеш у памʼяті `ASSETS_CACHE_MS`
   (10 хв), single flight, при збої — останні числа з `stale: true` або `market: null` з текстом; `http.ts`). CoinGecko без ключа
   (`COINGECKO_API_KEY` — лише demo-ключ для ліміту). Апка: третя вкладка **Token info** у `ChartSection` (`TokenInfoPanel`,
   `lib/assets.ts`, `assetFormat.ts`) замість окремого `AssetInfoScreen` з Long/Short знизу — тікет уже під графіком на тому ж
   екрані. Не зроблено: share / alert / favorite у хедері, значок активу, CoinMarketCap, ранг/ринкові числа для ринків поза
   п'ятьма в `assets.json` (вкладка показує «not available»).

## Не робимо (без нової причини)
Seeker Connect (web-only), ZK-знімок, iOS.
