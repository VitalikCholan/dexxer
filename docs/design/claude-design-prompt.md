# Dexxer — промт для Claude Design (тиждень 4, UI §5.5)

Скопіювати цілком у Claude Design. Референси стилю (Paradex/Aster) — у тебе; цей промт задає структуру, реальні дані й обмеження, щоб макети лягли на код без переробки.

---# Dexxer — промт для Claude Design (тиждень 4, UI §5.5)

Скопіювати цілком у Claude Design. Референси стилю (Paradex/Aster) — у тебе; цей промт задає структуру, реальні дані й обмеження, щоб макети лягли на код без переробки.

---

## Контекст продукту

Dexxer — приватний perpetual DEX для Android (Solana Seeker). Позиція трейдера видима лише йому: розмір, сторона, вхід, ліквідаційна ціна живуть у приватному TEE-ролапі (MagicBlock PER); на публічний L1 виходить лише агрегат пулу раз на 5 хвилин, публічна «квитанція балансів» (BalancesRoot) і відкладене розкриття закритих угод без власника (13F-стиль, затримка — параметр). Торгівля йде проти пулу ліквідності за ціною оракула; стакана й лімітних ордерів немає — і не буде. Один ринок: SOL-PERP, маржа в dUSDC.

Тон: спокійний, «фінансовий», без гейміфікації. Головна емоція — контроль і приватність: користувач має відчувати, що бачить своє, а світ — лише агрегат.

## Технічні рамки (важливо для реалізації)

- Мобільний застосунок React Native / Expo, Android-first. Розмір кадру 390×844 (портрет), safe-area зверху/знизу.
- Темна тема за замовчуванням; світла — не потрібна.
- Усе має бути реалізовним стандартними RN-компонентами: View/Text/Pressable/ScrollView/FlatList, `react-native-svg` для графіка та іконок. Без блюрів, складних тіней, паралаксу, відео-фонів.
- Одна system-шрифтова пара (наприклад Inter для тексту + моноширинний JetBrains Mono для чисел/адрес). Числа — табличні цифри.
- Експорт: для кожного екрана HTML-превʼю + окремий файл токенів (кольори, типографічна шкала, відступи 4/8/12/16/24/32, радіуси, тіні) — я перенесу токени в `app/src/theme` і компоненти читатимуть лише їх.
- Нижня навігація: 5 табів — Trade · Positions · History · Ledger · Account. (Developer-екрани сховані в Account → Settings.)
- Мова інтерфейсу — англійська.

## Спільні компоненти (потрібні як окремі превʼю)

- Кнопки: primary / secondary / destructive / ghost; стани default, pressed, disabled, loading.
- Поля вводу з підписом і підказкою; числове поле з суфіксом (SOL, dUSDC, ×).
- Сегментний перемикач (Long/Short; 1m/5m/15m).
- Слайдер плеча з мітками 1× 2× 5× 10× і превʼю значення.
- Картка (surface) з заголовком і рядками «label — value».
- Бейдж статусу: neutral / pending (годинник) / success (✓) / warning / danger.
- Рядок списку з двома рівнями тексту й правим значенням.
- Bottom sheet (модалка знизу) для Deposit / Withdraw / Confirm.
- Toast: success / error.
- Skeleton-рядки для завантаження; порожній стан з іконкою і однією фразою; стан помилки з кнопкою Retry.
- Адреса/підпис: скорочена (`45Ej…rWnM`) моноширинним, з іконкою copy та зовнішнього посилання (explorer).

## Екрани

### 0. Connect + Onboarding (одне підтвердження)
- Стартовий екран: логотип, одна фраза цінності («Your position is yours alone. The world sees only the pool.»), кнопка **Connect wallet** (відкриває системний вибір MWA-гаманця — Phantom/Solflare/Backpack; малювати не треба).
- Після підключення: екран **Set up private account** — список із 3 кроків з іконками стану: «Create private accounts (L1)», «Move them into the private enclave (L1)», «Activate session key (enclave)». Одна кнопка **Confirm in wallet** — усі кроки підписуються одним екраном гаманця. Підпис: «No SOL needed — we sponsor account rent».
- Стани кроків: waiting / signing / confirming / done / failed (з Retry — процес ідемпотентний, добудовується).
- Успіх: «You're set. Session key active for 24h» → кнопка **Go to Trade**.
- Дані для макета: owner `45EjKMAowbX77Xu2NfmbHdHvvVHf8DRa1vFFS1JgrWnM`, session key `D1jmuNYQJurLnk1mt3MTCqAnfd1VrhjwG8g4xcSRS5Lz`.

### 1. Trade
- Верх: пара **SOL-PERP**, mark-ціна крупно (`$117.28`), зміна за 24h (`+1.8%`), маленький бейдж «Oracle · Pyth Lazer» з крапкою свіжості (зелена/жовта).
- Графік: лінія mark, висота ~200, перемикач 1m / 5m / 15m; без свічок, без стакана, без обʼємів. Легкий градієнт під лінією допустимий. Хрестик-курсор із значенням — опційно.
- Тікет: сегмент **Long / Short**; поле **Size (SOL)**; поле **Margin (dUSDC)** з підказкою «Available: 980.00 dUSDC» і кнопкою Max; слайдер **Leverage** (1–10×, поточне `2.0×`); рядок превʼю: Entry ≈ `$117.28`, Liq. price `$60.12`, Fee `0.05 dUSDC`, Slippage limit `mark × 1.01`.
- Кнопка **Open Long** (зелена) / **Open Short** (червона), стан loading «Signing with session key…», підпис «No wallet prompt — signed by your session key».
- Якщо позиція вже відкрита: тікет заблоковано з поясненням «One position per market. Close it in Positions.» — це реальне обмеження MVP.
- Стани: mark stale (жовтий банер «Oracle price is stale — trading paused»), session expired (банер «Session expired — re-authorize» з кнопкою).

### 2. Positions
- Одна картка відкритої позиції: `SOL-PERP · Long · 2.0×`; Size `1.00 SOL`; Entry `$117.28`; Mark `$118.05`; **Unrealized PnL `+0.77 dUSDC (+3.9%)`** (зелений/червоний, оновлюється живо); Margin `20.00 dUSDC`; Liq. price `$60.12` з індикатором відстані до ліквідації (смужка).
- Дії: **Close**, **Increase**, **Decrease** (Increase/Decrease відкривають bottom sheet із полем розміру/маржі та превʼю нової liq-ціни).
- Порожній стан: «No open position» + кнопка Go to Trade.
- Стан «Closed, awaiting commitment»: після Close картка на 5 хв показує бейдж pending «Recording commitment on-chain (≤5 min)» — позиція вже закрита, PnL зафіксований.

### 3. History
- Список закритих угод, новіші зверху. Рядок: `Long 1.00 SOL`, `117.28 → 118.05`, PnL `+0.77 dUSDC`, дата/час; правий бейдж статусу розкриття:
  - pending «Committing…» (одразу після Close),
  - pending «Reveals in 2h 14m» (commitment записано, чекає затримку),
  - success «Revealed ✓» з іконкою посилання на публічний запис.
- Пояснювальний рядок вгорі (можна згорнути): «Your trades become public only after the delay — without your address.»
- Порожній стан: «No closed trades yet».

### 4. Ledger (публічний екран — те, що бачить світ)
- Вкладки/секції: **Disclosures** (лента угод: side, size, entry→exit, PnL, час розкриття — **без власника**, підпис «Trader: hidden by design»), **Pool** (знімок: Liquidity `1,250,000 dUSDC`, Locked `48,200`, Fees `1,930`, `Updated at slot 332472270 · every 5 min`, дрібним: «Values rounded to 100 dUSDC»), **Balances root** (останній `root_slot`, `64 leaves`, короткий хеш, іконка explorer).
- Цей екран доступний і без гаманця — це вітрина приватності для пітчу.

### 5. Account
- Верх: адреса власника (скорочена, copy), бейдж «Session active · 23h left».
- Баланси: **Available `980.00 dUSDC`**, Locked `20.00 dUSDC`, кнопки **Deposit** / **Withdraw** (bottom sheets; Withdraw показує правило «Min 1 dUSDC · one withdrawal per ~2 min»).
- Секція **Receipt**: «Your balance is attested in the public root» — success «Attested at slot 332472270 ✓» або pending «Not yet included — next commit ≤5 min». Одна фраза пояснення: «Proof that the protocol owes you — without revealing how much».
- Секція **Exit**: кнопка **Exit private account** (destructive) з чек-листом умов: No open position · History queue empty · Balance withdrawn. Підтвердження в bottom sheet з поясненням «Your accounts return to L1 with private fields erased».
- Settings (шестерня): Network (Devnet), Developer tools (сховані екрани), Re-authorize session, Disconnect.

## Чого НЕ малювати
Стакан/order book, лімітні/стоп-ордери, funding-ставки, TP/SL, кілька ринків, соціальні/лідерборди, онбординг-казуслайди, світлу тему, чат/підтримку.

## Формат результату
Для кожного екрана — HTML-превʼю 390×844 у темній темі з реальними даними з цього промту; окремо — превʼю спільних компонентів зі станами; окремо — файл токенів. Назви файлів: `screens/00-onboarding.html`, `screens/01-trade.html`, `screens/02-positions.html`, `screens/03-history.html`, `screens/04-ledger.html`, `screens/05-account.html`, `components/*.html`, `tokens.json`.


## Контекст продукту

Dexxer — приватний perpetual DEX для Android (Solana Seeker). Позиція трейдера видима лише йому: розмір, сторона, вхід, ліквідаційна ціна живуть у приватному TEE-ролапі (MagicBlock PER); на публічний L1 виходить лише агрегат пулу раз на 5 хвилин, публічна «квитанція балансів» (BalancesRoot) і відкладене розкриття закритих угод без власника (13F-стиль, затримка — параметр). Торгівля йде проти пулу ліквідності за ціною оракула; стакана й лімітних ордерів немає — і не буде. Один ринок: SOL-PERP, маржа в dUSDC.

Тон: спокійний, «фінансовий», без гейміфікації. Головна емоція — контроль і приватність: користувач має відчувати, що бачить своє, а світ — лише агрегат.

## Технічні рамки (важливо для реалізації)

- Мобільний застосунок React Native / Expo, Android-first. Розмір кадру 390×844 (портрет), safe-area зверху/знизу.
- Темна тема за замовчуванням; світла — не потрібна.
- Усе має бути реалізовним стандартними RN-компонентами: View/Text/Pressable/ScrollView/FlatList, `react-native-svg` для графіка та іконок. Без блюрів, складних тіней, паралаксу, відео-фонів.
- Одна system-шрифтова пара (наприклад Inter для тексту + моноширинний JetBrains Mono для чисел/адрес). Числа — табличні цифри.
- Експорт: для кожного екрана HTML-превʼю + окремий файл токенів (кольори, типографічна шкала, відступи 4/8/12/16/24/32, радіуси, тіні) — я перенесу токени в `app/src/theme` і компоненти читатимуть лише їх.
- Нижня навігація: 5 табів — Trade · Positions · History · Ledger · Account. (Developer-екрани сховані в Account → Settings.)
- Мова інтерфейсу — англійська.

## Спільні компоненти (потрібні як окремі превʼю)

- Кнопки: primary / secondary / destructive / ghost; стани default, pressed, disabled, loading.
- Поля вводу з підписом і підказкою; числове поле з суфіксом (SOL, dUSDC, ×).
- Сегментний перемикач (Long/Short; 1m/5m/15m).
- Слайдер плеча з мітками 1× 2× 5× 10× і превʼю значення.
- Картка (surface) з заголовком і рядками «label — value».
- Бейдж статусу: neutral / pending (годинник) / success (✓) / warning / danger.
- Рядок списку з двома рівнями тексту й правим значенням.
- Bottom sheet (модалка знизу) для Deposit / Withdraw / Confirm.
- Toast: success / error.
- Skeleton-рядки для завантаження; порожній стан з іконкою і однією фразою; стан помилки з кнопкою Retry.
- Адреса/підпис: скорочена (`45Ej…rWnM`) моноширинним, з іконкою copy та зовнішнього посилання (explorer).

## Екрани

### 0. Connect + Onboarding (одне підтвердження)
- Стартовий екран: логотип, одна фраза цінності («Your position is yours alone. The world sees only the pool.»), кнопка **Connect wallet** (відкриває системний вибір MWA-гаманця — Phantom/Solflare/Backpack; малювати не треба).
- Після підключення: екран **Set up private account** — список із 3 кроків з іконками стану: «Create private accounts (L1)», «Move them into the private enclave (L1)», «Activate session key (enclave)». Одна кнопка **Confirm in wallet** — усі кроки підписуються одним екраном гаманця. Підпис: «No SOL needed — we sponsor account rent».
- Стани кроків: waiting / signing / confirming / done / failed (з Retry — процес ідемпотентний, добудовується).
- Успіх: «You're set. Session key active for 24h» → кнопка **Go to Trade**.
- Дані для макета: owner `45EjKMAowbX77Xu2NfmbHdHvvVHf8DRa1vFFS1JgrWnM`, session key `D1jmuNYQJurLnk1mt3MTCqAnfd1VrhjwG8g4xcSRS5Lz`.

### 1. Trade
- Верх: пара **SOL-PERP**, mark-ціна крупно (`$117.28`), зміна за 24h (`+1.8%`), маленький бейдж «Oracle · Pyth Lazer» з крапкою свіжості (зелена/жовта).
- Графік: лінія mark, висота ~200, перемикач 1m / 5m / 15m; без свічок, без стакана, без обʼємів. Легкий градієнт під лінією допустимий. Хрестик-курсор із значенням — опційно.
- Тікет: сегмент **Long / Short**; поле **Size (SOL)**; поле **Margin (dUSDC)** з підказкою «Available: 980.00 dUSDC» і кнопкою Max; слайдер **Leverage** (1–10×, поточне `2.0×`); рядок превʼю: Entry ≈ `$117.28`, Liq. price `$60.12`, Fee `0.05 dUSDC`, Slippage limit `mark × 1.01`.
- Кнопка **Open Long** (зелена) / **Open Short** (червона), стан loading «Signing with session key…», підпис «No wallet prompt — signed by your session key».
- Якщо позиція вже відкрита: тікет заблоковано з поясненням «One position per market. Close it in Positions.» — це реальне обмеження MVP.
- Стани: mark stale (жовтий банер «Oracle price is stale — trading paused»), session expired (банер «Session expired — re-authorize» з кнопкою).

### 2. Positions
- Одна картка відкритої позиції: `SOL-PERP · Long · 2.0×`; Size `1.00 SOL`; Entry `$117.28`; Mark `$118.05`; **Unrealized PnL `+0.77 dUSDC (+3.9%)`** (зелений/червоний, оновлюється живо); Margin `20.00 dUSDC`; Liq. price `$60.12` з індикатором відстані до ліквідації (смужка).
- Дії: **Close**, **Increase**, **Decrease** (Increase/Decrease відкривають bottom sheet із полем розміру/маржі та превʼю нової liq-ціни).
- Порожній стан: «No open position» + кнопка Go to Trade.
- Стан «Closed, awaiting commitment»: після Close картка на 5 хв показує бейдж pending «Recording commitment on-chain (≤5 min)» — позиція вже закрита, PnL зафіксований.

### 3. History
- Список закритих угод, новіші зверху. Рядок: `Long 1.00 SOL`, `117.28 → 118.05`, PnL `+0.77 dUSDC`, дата/час; правий бейдж статусу розкриття:
  - pending «Committing…» (одразу після Close),
  - pending «Reveals in 2h 14m» (commitment записано, чекає затримку),
  - success «Revealed ✓» з іконкою посилання на публічний запис.
- Пояснювальний рядок вгорі (можна згорнути): «Your trades become public only after the delay — without your address.»
- Порожній стан: «No closed trades yet».

### 4. Ledger (публічний екран — те, що бачить світ)
- Вкладки/секції: **Disclosures** (лента угод: side, size, entry→exit, PnL, час розкриття — **без власника**, підпис «Trader: hidden by design»), **Pool** (знімок: Liquidity `1,250,000 dUSDC`, Locked `48,200`, Fees `1,930`, `Updated at slot 332472270 · every 5 min`, дрібним: «Values rounded to 100 dUSDC»), **Balances root** (останній `root_slot`, `64 leaves`, короткий хеш, іконка explorer).
- Цей екран доступний і без гаманця — це вітрина приватності для пітчу.

### 5. Account
- Верх: адреса власника (скорочена, copy), бейдж «Session active · 23h left».
- Баланси: **Available `980.00 dUSDC`**, Locked `20.00 dUSDC`, кнопки **Deposit** / **Withdraw** (bottom sheets; Withdraw показує правило «Min 1 dUSDC · one withdrawal per ~2 min»).
- Секція **Receipt**: «Your balance is attested in the public root» — success «Attested at slot 332472270 ✓» або pending «Not yet included — next commit ≤5 min». Одна фраза пояснення: «Proof that the protocol owes you — without revealing how much».
- Секція **Exit**: кнопка **Exit private account** (destructive) з чек-листом умов: No open position · History queue empty · Balance withdrawn. Підтвердження в bottom sheet з поясненням «Your accounts return to L1 with private fields erased».
- Settings (шестерня): Network (Devnet), Developer tools (сховані екрани), Re-authorize session, Disconnect.

## Чого НЕ малювати
Стакан/order book, лімітні/стоп-ордери, funding-ставки, TP/SL, кілька ринків, соціальні/лідерборди, онбординг-казуслайди, світлу тему, чат/підтримку.

## Формат результату
Для кожного екрана — HTML-превʼю 390×844 у темній темі з реальними даними з цього промту; окремо — превʼю спільних компонентів зі станами; окремо — файл токенів. Назви файлів: `screens/00-onboarding.html`, `screens/01-trade.html`, `screens/02-positions.html`, `screens/03-history.html`, `screens/04-ledger.html`, `screens/05-account.html`, `components/*.html`, `tokens.json`.
