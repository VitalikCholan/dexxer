# Market selector — design specification

**Date:** 5 October 2026 · **Status:** implemented (plan `docs/superpowers/plans/2026-10-05-market-selector.md`)
**Goal:** replace the five-symbol row on the Trade tab with a market selector that stays comfortable on a phone as the market list grows from 5 to several dozen.
**Depends on:** PR #22 (`fix/ui-design-plans-01-04`) merged first — this design uses its tokens (`accentText`, `control.minHitTarget = 48`, `radius.xl`), the `long` button variant and the dUSDC/`$` formatting rule.

## 1. Problem and success criteria

Today `MarketPicker` (`app/src/features/trade/MarketPicker.tsx`) renders every listed market as one compact `Segment` (`SOL BTC ETH HYPE ZEC`) in a horizontal `ScrollView`. With 5 markets it fits; from about 7 it scrolls off-screen, each button shows only a ticker (no price, no 24h change, no sign of an open position), and there is no search or favourites.

The trader switches markets in two ways, and both matter (brainstorming answer **C**):

1. **Quick switching** between the 2–3 markets they trade.
2. **Browsing** to find what is moving, then picking.

Success criteria:

- Any market is reachable in at most two taps, with 30+ listed markets.
- The trader always sees which market the ticket will trade.
- Opening a position on the wrong market takes a deliberate action, not a slip.
- No new private data leaves the device: the server never learns which market a trader looks at or favourites.

Assumptions (confirmed): markets are added one at a time by the admin; a few dozen within a year; no categories yet; favourites live only on the device.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Sorting of the full list | **A–Z (SOL first) · 24h ▲ · 24h ▼**, client-side. No volume sort: trades are private, the protocol has no public per-market volume. |
| D2 | Source of the 24h change for all markets | **New relayer endpoint `GET /tickers`**, one response for all markets. |
| D3 | Asset name and icon | **`name` in `GET /markets`** (from `services/relayer/assets/assets.json`); **SVG icons bundled in the app**, letter-avatar fallback. |
| D4 | Quick chips under the header | ~~Favourites only (★), at most 5~~ **Removed 05.10.2026** (owner decision after the first build: the row read as the old five-symbol picker). Favourites live only as the ★ tab on the markets screen. |
| D5 | Where the list lives | **Full-screen modal route** `app/markets.tsx` that looks like a tall sheet — not the existing `Sheet` (sized for short forms, no keyboard handling) and not an inline dropdown. |

A correction from the brainstorming: the code has **no dedicated "swipe switches the market" gesture**. The CLAUDE.md note about the AVD was a tap on the market row during a fast swipe; removing the row removes the problem.

## 3. Relayer (`services/relayer`)

### 3.1 `GET /markets` — add `name`

Each entry gains `name: string | null`, looked up by symbol in `assets/assets.json` (`"ETH" → "Ethereum"`); `null` when the symbol is not there. Purely additive: no existing field changes, the current app ignores it.

### 3.2 `GET /tickers` — new

- No parameters; the same response for every client.
- Response: an array, one entry per market in the registry (SOL always, as in `/markets`):
  ```json
  [{ "symbol": "ETH", "price": "2725880000", "change24h": 0.0083, "high24h": "2739060000", "low24h": "2691770000" }]
  ```
  `price`, `high24h`, `low24h` are 1e6 fixed-point decimal strings, as elsewhere in the indexer. `change24h` is a fraction (`0.0083` = +0.83 %) or `null`.
- Computed from the stored `1h` candle tier for the last 24 hours (the table the chart already uses; stale oracle ticks never reach it): `change24h = (last close − open 24 h ago) / open 24 h ago`; `high24h` / `low24h` over the same window; `price` = last close. Less than 24 h of history (a new market) → `change24h: null`, high/low over what exists; no candles at all → `price`, `high24h`, `low24h`, `change24h` all `null`.
- The computation is a pure function `tickerFrom(candles, now)` in `src/indexer/`, tested on its own.
- In-memory cache for 30 s (`TICKERS_CACHE_MS`, default 30000, min 5000): without it every open of the markets screen by every client costs one query per market.
- Database error: serve the last cached response; with no cache, `503`.
- Not served: anything private (open interest, positions) — same rule as `/markets`.

### 3.3 Tests

- `tickerFrom`: a full 24 h, under 24 h, empty.
- Route `/tickers`: response shape, served from cache within 30 s, `503` with a failing pool and no cache, stale cache served on a failing pool.
- `/markets` includes `name`; `null` for a symbol missing from `assets.json`.

## 4. App — data and state

### 4.1 `app/src/lib/markets.ts`

`MarketInfo` gains `name: string | null`. `parseMarkets` reads it as optional, so a response without it (old relayer) still parses.

### 4.2 `app/src/lib/tickers.ts` — new

- `parseTickers(v)`: strict shape check, throwing `IndexerShapeError` naming the field, like `parseMarkets`.
- `useTickers()`: React Query, `refetchInterval` 60 s, enabled only while the markets screen is mounted.

**Row price:** the live WebSocket mark already in the React Query cache (`QK.mark(symbol)`, fed by `/ws?markets=*`) when present, otherwise `/tickers`' `price`. **No per-market REST request** — opening a list of 30 markets must not issue 30 `/mark?market=X` calls.

### 4.3 `app/src/lib/favorites.tsx` — new

- React context + `AsyncStorage` key `dexxer.favorites`, following `app/src/lib/marketStore.tsx`.
- Value: an ordered list of symbols, in the order they were starred.
- Favourites are shown on the ★ tab of the markets screen (the header chips were removed 05.10.2026, see D4).
- A starred symbol missing from the registry is skipped in the UI but kept in storage (the market may come back).
- A storage read error or malformed JSON yields an empty list and is **never written back** (the History archive rule).
- Pure read/parse/toggle functions live next to it and are tested without storage.

### 4.4 `app/src/features/markets/marketList.ts` — new, pure, tested

- `marketRows(markets, tickers, marks, positions)` → `MarketRow[]`:
  `{ symbol, name, price, change24h, maxLeverage, paused, hasPosition, hasOrders, favorite, selected }`.
  Positions and orders come from the owner's already-decoded `Positions` (`app/src/lib/positions.ts`), as on Trade.
- `filterRows(rows, query, tab)`: case-insensitive match on ticker or name (`"eth"`, `"Eth"`, `"ethereum"`); tabs `all | favorites | positions` (`positions` = open slot or pending order on the market).
- `sortRows(rows, mode)`: `az` — SOL first, then by symbol (same as `sortMarkets`); `up` / `down` — by `change24h`, `null` always last.
- `slotUsage(positions)` → `{ used, max: 16 }`.
- Without onboarding (no `Positions`): no position markers, no slot counter; the list and selection still work.

## 5. App — interface

### 5.1 Trade header (`app/src/features/trade/TradeHeader.tsx`)

- `MarketPicker` is removed.
- **Market button** in its place: `[icon] ETH-PERP ▾ 10×`; opens `app://markets`. Accessibility label "Market ETH-PERP, change market".
- The "Pyth Lazer" pill stays on the right.
- ~~Favourite chips under the button~~ removed 05.10.2026 (D4): the header has only the market button.
- The "Opening paused on ETH-PERP" badge stays.

### 5.2 Markets screen

Route `app/app/markets.tsx` (root `Stack`, `presentation: 'modal'`, slides from the bottom, styled as a tall sheet with `radius.xl` top corners); the screen component is `app/src/features/markets/MarketsScreen.tsx`.

- **Header:** "Select market" and a ✕ button (label "Close"). Android Back also closes.
- **Search:** the existing `Input`, label "Search", hint "Ticker or name".
- **Tabs** (`Segment`): All · ★ Favorites · With positions.
- **Sort** (compact `Segment`): A–Z · 24h ▲ · 24h ▼. The choice is remembered on the device (`dexxer.marketsSort`).
- **Slot counter:** "Open positions: 3 / 16". At 16/16: "All 16 position slots are in use. Close a position to open on another market." (warning tone).
- **List** (`FlatList`), one `MarketRow` per market:
  ```
  [icon]  ETH          $2,725.88    ☆
          Ethereum     +0.8%
          10×  · Position · Paused
  ```
  - Numbers in the numeric face (Plex Mono); 24h change with sign and colour; "—" when `change24h` is `null`.
  - Badges only when they apply.
  - ★/☆ toggles the favourite; label "Add ETH to favorites" / "Remove ETH from favorites"; touch area ≥ `control.minHitTarget`.
  - The selected market's row has an accent border.
  - Tapping a row selects the market (`useSelectedMarket().setSymbol`) and closes the screen.
- **Empty states:** no search match — `No markets match "xyz"`; empty ★ tab — "Tap ☆ to pin markets here"; empty positions tab — "No open positions".

### 5.3 Icons — `app/src/ui/AssetIcon.tsx` (new)

`AssetIcon({ symbol, size })`: SVG for SOL (the current `SolIcon` moves here), BTC, ETH, HYPE, ZEC, taken from each project's official brand assets, not redrawn. Unknown symbol → a circle with the first letter on `surfaceAlt`. Colours outside the tokens are allowed only inside the brand SVGs.

### 5.4 Wrong-market safety

- The ticket's submit button names the market: "Open Long ETH", "Place Limit Short BTC"; the Close tab's button: "Close ETH".
- The ticket keeps resetting on a market change (`key={symbol}` in `TradeScreen`).

## 6. Errors

| Situation | Behaviour |
|---|---|
| `/markets` unavailable | As today: SOL only (`SOL_FALLBACK`). The markets screen shows one row and "Market list unavailable — showing SOL". |
| `/tickers` unavailable or `503` | The list works; price from the WebSocket when present; 24h shows "—"; 24h sorting puts those rows last. |
| Selected market leaves the registry | As today: falls back to SOL (`useSelectedMarket`). |
| Favourites storage unreadable / malformed | Empty list; storage is not overwritten. |

## 7. Testing

- **Relayer:** §3.3.
- **App (`node --test`, pure functions):** `parseMarkets` with and without `name`; `parseTickers`; `marketRows`; `filterRows` (case, name match, tabs); `sortRows` (SOL first, `null` last); `slotUsage`; favourites parse/toggle; the submit-button label with the symbol.
- **Emulator (Phantom AVD):** open the markets screen from the header; search "eth"; star BTC and see it on the ★ tab; select through a row; Back closes the screen; font scale 1.3×. Position markers and the 16/16 state need an onboarded account — they go to the live-run checklist.
- App gate: `npm test`, `tsc --noEmit`, `lint:check`, `format:check`. Relayer: its test suite on Node 24.18 with `DEXXER_IDL_DIR`.

## 8. Rollout

1. Relayer (`name`, `/tickers`): deploy to Railway (`railway up`). The current app is unaffected.
2. App: new build/APK. Against an old relayer it shows tickers instead of names and "—" for 24h.

## 9. Out of scope

Market categories; volume sorting (no public per-market volume exists); "new markets" with a listing date; syncing favourites across devices; icons fetched from the network; any change to the on-chain program.
