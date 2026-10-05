# Set every numeric value in the numeric face (Plex Mono)

Written against: a842d52ee3869eef3d340cddc024bdd1d45cb64b

## Evidence chain

- Surface: mobile app (`app/`) — Trade header, Trade ticket, Trade → Close tab, Trade activity, market info, Positions card and sheets, History, Account → Pool snapshot.
- Problem: numbers on the same card switch between IBM Plex Mono and IBM Plex Sans. `Row` (`app/src/ui/Row.tsx`) renders its value in Mono only when the caller passes `mono`, and callers pass it inconsistently:
  - `PositionCard.tsx`: Entry / Mark are `mono` (~131–132); Size (~130), Unrealized PnL (~133), Margin (~142), Liq. price (~143) are not.
  - `HistoryScreen.tsx`: Entry → Exit and Fees are `mono` (~62, ~68); PnL (~63) is not.
  - `TradeActivity.tsx`: Entry / Mark `mono` (~94–95); Unrealized PnL (~96), Liq. price (~101) not.
  - `CloseTab.tsx`: Exit ≈ `mono` (~111); Unrealized PnL (~86), Realized PnL ≈ (~112), Close fee (~117), Margin released (~118) not.
  - `TradeTicket.tsx` preview rows (~342 Entry, ~346 Liq. price, ~347 Fee, ~348 Slippage limit): none `mono`.
  - `PoolSnapshotCard.tsx` (~34–36), `AddMarginSheet.tsx` (~84–86), `DecreaseSheet.tsx` (~56), `IncreaseSheet.tsx` (~72), `MarketInfoCard.tsx` (~35, ~36, ~40, ~41): none `mono`.
  - `TradeHeader.tsx`: the mark price is `display, { mono: true }` and High/Low/Pool are `caption, { mono: true }`, but the 24h change next to the mark uses `useTextStyle('body')` (Sans).
- Design evidence:
  - `docs/design/tokens.json`: `font.numeric = { fontFamily: "IBM Plex Mono", fontVariantNumeric: "tabular-nums" }`.
  - `docs/design/Dexxer App.dc.html` (inspiration): "IBM Plex Mono with tabular figures for every number and address"; `+1.8%` and every Row value are set in Mono.
  - In-app exemplar of the intended pattern: Account → Balances passes `mono` on every row (`AccountScreen.tsx` ~157–160).
- Owner: `app/src/ui/Row.tsx` (`mono` prop) and `useTextStyle(…, { mono: true })`.
- Scope and affected surfaces: the files listed in Changes.
- Uncertainty: none for pure numbers. Rows whose value mixes words and numbers are excluded (see Scope).

## Design decision

A `Row` whose value is a number, an amount, a price, a percentage or a leverage (including `—` placeholders and `a → b` transitions of numbers) passes `mono`. Rows whose value is prose (`Pyth Lazer, mark = EMA`, `Protocol pool`) or mixes side words with numbers (`Long 0.1000 SOL @ $117.28`) stay Sans. Standalone numeric `Text` uses `useTextStyle(<token>, { mono: true })`. Do **not** make `mono` the default in `Row` — prose rows exist and would regress.

## Reuse

- `Row`'s existing `mono` prop; `useTextStyle(key, { mono: true })`.
- Exemplar: `app/src/features/account/AccountScreen.tsx` Balances card (~157–160).

No new primitive.

## Changes

1. `app/src/features/trade/TradeHeader.tsx`
   - Change: the `pctChange` text uses `useTextStyle('body', { mono: true })` instead of `body`. If `body` is then unused, remove it.
   - Preserve: color logic (`long` / `short`), `+` prefix, one decimal.
2. `app/src/features/positions/PositionCard.tsx` — add `mono` to Size, Unrealized PnL, Margin, Liq. price.
3. `app/src/features/history/HistoryScreen.tsx` — add `mono` to PnL.
4. `app/src/features/trade/TradeActivity.tsx` — add `mono` to Unrealized PnL and Liq. price. Leave the `${symbol}-PERP` row (~89, `Long 0.1 SOL`) Sans.
5. `app/src/features/trade/CloseTab.tsx` — add `mono` to Unrealized PnL, Realized PnL ≈, Close fee, Margin released. Leave the `Position` row (~81) Sans.
6. `app/src/features/trade/TradeTicket.tsx` — add `mono` to Entry ≈ / Entry at, Liq. price, Fee, Slippage limit.
7. `app/src/features/receipt/PoolSnapshotCard.tsx` — add `mono` to Liquidity, Locked, Fees.
8. `app/src/features/positions/AddMarginSheet.tsx` — add `mono` to Margin, Leverage, Liq. price.
9. `app/src/features/positions/DecreaseSheet.tsx` — add `mono` to Realized PnL ≈.
10. `app/src/features/positions/IncreaseSheet.tsx` — add `mono` to New liq. price ≈.
11. `app/src/features/trade/MarketInfoCard.tsx` — add `mono` to Max leverage, Open / close fee, Maintenance margin, Liquidation fee. Leave Price and Counterparty Sans.

For each: Preserve label, value string and tone; Verify the value renders in Plex Mono.

## Scope

- Inherit: all Rows listed above.
- Verify: `app/src/features/trade/TradingRulesPanel.tsx` (~33) renders generic `r.value` — inspect the values it is given (`tradingRules.ts`); add `mono` only if every value is numeric, otherwise leave it and note it. `app/src/features/trade/TokenInfoPanel.tsx` numeric rows (~105, ~120–127) — apply the same rule (Rank, Market cap, FDV, 24h volume, dominance, supplies, circulating rate are numeric → `mono`; `Launched` date is numeric too → `mono`).
- Exclude: Row label typography; `Input` (already Mono); chart WebView; any copy changes; the dUSDC/`$` unit change (separate plan `01-money-amounts-in-dusdc.md` — the two plans touch the same lines, apply either order and keep both edits).

## Validation

- Product: on the Positions card, all six value cells align as tabular Mono; while the mark updates live, the PnL width no longer jitters.
- Interface: Trade (header, Open tab preview, Close tab, activity, market info, token info, trading rules), Positions card + Increase / Decrease / Add margin sheets, History, Account → Pool snapshot. Check a long value (e.g. `$103,456.78 → $104,000.00` in Add margin) still fits on one line at ~390 dp; if it wraps, report rather than shrinking the type.
- System: `grep -rn "<Row\|<UiRow" app/src | grep -v mono` afterwards lists only prose/mixed rows (Price, Counterparty, `Position`, `${symbol}-PERP`, and TradingRulesPanel if excluded).
- Repository: `cd app && npm test && npx tsc --noEmit && npm run lint:check && npm run format:check` → all pass (Node 24.18; prefix `PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH` if needed).

## Stop conditions

- Stop if Mono widens a value enough to wrap or truncate in a half-width or 390 dp layout — report the screen instead of changing type size.
- Stop if `Row` gains a different numeric API in the meantime (then route through it instead of `mono`).

## Design documentation

- After acceptance and validation: add to `docs/design/README.md`: "Numbers, amounts, prices, percentages and addresses use `font.numeric` (Plex Mono, tabular). In `Row`, pass `mono` for any numeric value."
