# Тиждень 6 — бек-лог (узгоджено 24.09.2026)

Джерела: фінальне ревʼю тижня 5 (`week5-results.md`, ризики #37–39), виміри Task 7, smoke-тест із реальним
Phantom (24.09), доки MagicBlock (fees, runtime limits, magic actions), джерела `magicblock-validator`
(committor `TaskStrategist`). Пріоритет: **надійність → безпека/міграція → продукт**. Спека — новий §2.7
(brainstorming → writing-plans → SDD), як у тижнях 3–5.

## A. Надійність (обовʼязково, ~60%)

1. **Ризик #37 — запис губиться, якщо L1-дія впаде після pop.** `due_reveals` знімає запис із черги в тій
   самій ER-tx, що планує `write_disclosure`; якщо міст скине дію (`0xA0000002`, або `Commitment`
   відсутній), 13F-обіцянка для цієї угоди мовчки провалюється. Фікс: прапорець «reveal scheduled» на
   записі, зняття лише після того, як crank побачив `Disclosure` на L1 (crank-асертований, як колишній
   `mark_committed`, але для видалення, а не для запису). Програмна зміна + LiteSVM + апгрейд.
2. **Ризик #38 — гістерезис без per-sample guard.** `liq_ticks` інкрементується на кожен виклик
   (`crank_tick` + `liquidation_check`), три виклики в одному слоті ліквідують за одним семплом ціни.
   Фікс: поле `last_liq_mark_slot` у `Position` (зміна лейауту → міграція, див. B.2), інкремент лише при
   новому `Market.mark_slot`; дефолт `liq_hysteresis_ticks` повернути до 2.
3. **Ризик #39 — `close_exited_user` віддає рент `fee_payer` беззастережно.** Для акаунтів до тижня 5 рент
   платив власник. Фікс: `rent_payer: Pubkey` в `UserAccount` (та сама міграція), рент → `rent_payer`.
4. **Ліквідація трейдера з повним кільцем.** Зараз `liquidate_now` пропускає кандидата з `dq.len == 8` →
   поганий борг накопичується, поки черга не дренується. Варіанти: зарезервований слот під ліквідацію;
   витіснення найстарішого записаного (`commitment_written`) запису; окремий `bad_debt`-запис поза чергою.
   Обрати у brainstorming; тест LiteSVM «повне кільце + underwater → ліквідовано».
5. **Економіка `commit_aggregate` (виміряно з доків MagicBlock).** Ціна Base Action =
   `CU_requested × 50 000 / 1 000 000` лампортів: наші 100k/120k CU → 5–6k за дію (~22k за бандл із 4).
   Виміряти реальні CU `write_commitment`/`write_disclosure` і знизити `compute_units` у `CallHandler`.
   З 26-го коміту — 100 000 лампортів за кожен закомічений акаунт (`Pool`+`BalancesRoot` = 200k/цикл):
   при `COMMIT_INTERVAL_TICKS=60` це ≈0.29 SOL/добу з `fee_payer` → для продукту повернути **300**.
6. **Бридж-ліміт дій — питання до MagicBlock.** Committor вміщує коміт + дії в одну L1-tx ≤ 1232 B
   (`TaskStrategist`, ALT/буфери стискають лише коміти, не аргументи дій); при провалі — `remove_actions`
   для всієї стратегії. Запит: multi-tx finalize / ALT для args дій. До відповіді — `COMMIT_MAX_ACTIONS=4`,
   `write_disclosure` полегшити (передавати менше байтів), карантин лишається як запобіжник.
7. **Невиміряне з тижня 5** (виміряти, не чинити наосліп): стійкість scheduler-задач до рестарту
   devnet-tee; тік `i64::MAX`-задачі у вже розделегований `Position`; чи ER шанує `ComputeBudget` 1.4M
   (16 ліквідацій за тік = 367k CU); `init_user_reuse_queue` на devnet (вікно між ER-close і base-close).

## B. Безпека / міграція (~25%)

1. **#27 — SIWS-гейт `/sponsor`** (+ L1-гейт або invite): без нього спонсорування можна злити.
   Верифікація SIWS-підпису на relayer, звʼязка owner ↔ sponsor-слоти, денний бюджет уже є.
2. **Міграція лейауту акаунтів.** `UserAccount` v1 (тижні 1–2) нечитабельний усіма типізованими
   інструкціями; 4 legacy Open-позиції на devnet — перманентний skew `oi_long`/`locked`. Для A.2/A.3 теж
   потрібна зміна лейауту → одна `migrate_user_account` (realloc + версія) + `admin_force_close_stranded`
   для devnet-сміття (або wipe devnet-стану перед мейннет-планом).
3. **MWA identity verification (Phantom).** Smoke 24.09: Phantom відхиляє `reauthorize` —
   `dApp identity is not verified (mwaIdentityVerified !== true)`. Треба власний домен як `identity.uri`
   з `/.well-known/assetlinks.json` (Digital Asset Links, package `com.dexxer.app` + SHA-256 signing cert).
   До того — один промпт авторизації на сесію підпису (hotfix `withAuthRetry`, тиждень 5). Upstream-баг
   `mobile-wallet-adapter-protocol@2.3.0` `index.native.js` (`return invoke(...)` без `await` →
   retry wallet-ui не спрацьовує) — зарепортити. Phantom Connect SDK (`@phantom/react-native-sdk`,
   deeplink) — лише як Phantom-only fallback після перевірки co-sign `fee_payer`; MWA лишається основним
   (Seeker).
4. **Шаблонні залишки в app:** root-гейт `/sign-in` («app» + placeholder-іконка), `AppConfig.uri`
   був `https://example.com` (виправлено hotfix-ом) — привести до брендингу Dexxer; `WalletUiDropdown`
   у хедері Account.

## C. Продукт (~15%, якщо A/B вкладуться)

1. **Мульти-маркет** (уточнено 27.09): додати **BTC-PERP, ETH-PERP, HYPE-PERP, ZEC-PERP** до
   SOL-PERP, кілька одночасних позицій на трейдера (`Position` per market — сіди
   `[b"position", owner, market]` уже це дозволяють). Це друга половина перп-ядра, не UI-фіча;
   відкриті питання перед дизайном (brainstorming → spec): (а) чи публікує оракул MagicBlock
   фіди Pyth Lazer для HYPE і ZEC — перевірити першим; (б) крос-маржа vs ізольована —
   `UserAccount` зараз тримає одну маржу під одну позицію; (в) ліквідація на рівні акаунта
   при крос-маржі — `liquidation_check` per position недостатньо; (г) `BalancesRoot`/`Pool`-знімок
   і `SNAPSHOT_STEP` для кількох ринків; (д) стейлнес окремо на кожен фід; (е) UI — вибір ринку
   на Trade, список позицій замість однієї картки, колонка ринку в History; (є) міграція лейауту
   devnet-акаунтів (перетинається з B).
2. Відео/пітч, тег `v0.4-mvp`.
3. Тех-борг тижня 5 (Task 9): `permissions.rs`-модуль, `Toast`/`Sheet` таймери, WS ping/pong,
   `listBaseOwners` O(n) → індекс по `exited`.
4. **UX торгового екрана (додано 27.09 за ревʼю «три опори» трейдинг-апок):**
   - пресети суми (10 / 50 / 100 dUSDC) і плеча (2× / 5× / 10×) кнопками замість полів вводу;
   - фандинг і сумарний OI пулу на Trade — OI є в `Pool`-знімку (огрублений `SNAPSHOT_STEP`),
     фандингу в програмі немає взагалі — спершу вирішити, чи він потрібен у MVP;
   - add/remove margin на картці позиції — `increase/decrease_position` є, окремої кнопки під
     заставу немає;
   - плашка TP/SL під перемикачем «Advanced» як «скоро» (функції ще нема, трейдер має бачити напрям);
   - алерт «Approaching liquidation» → одразу на Add margin: серверний push неможливий
     (сервер не бачить приватну позицію) — лише локальні нотифікації з апки у фоні через
     `accountSubscribe`.
5. **Графік як у TradingView** (додано 27.09): замість власного `PriceChart` — повноцінний
   свічковий графік з масштабуванням/прокруткою, crosshair із ціною і часом, лініями
   entry/liq-price/mark поверх свічок, обсягом і базовими індикаторами (EMA, VWAP).
   **Таймфрейми (уточнено 27.09):** 1s, 1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 24h, 2D, 5D,
   1W, 1M. Наслідок для indexer-а relayer-а: свічки зараз агрегуються з тіків оракула в памʼяті
   (зараз 1m/5m/15m) — 1s потребує зберігати сирі тіки, а 1W/1M — довгострокове сховище
   (Postgres уже є) і бекфіл історії, бо оракул не віддає минуле; ці два краї — окремі задачі. Кандидат — `lightweight-charts` (TradingView, Apache-2.0) у
   WebView або `react-native-wagmi-charts`/Skia-порт; дані — з indexer-а relayer-а
   (`/prices`, свічки вже агрегуються). Рішення про бібліотеку — окремий спайк.

## Не робимо (без нової причини)
Seeker Connect (web-only), ZK-знімок, iOS.
