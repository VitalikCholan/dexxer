# Show money amounts in dUSDC, prices in $

Written against: a842d52ee3869eef3d340cddc024bdd1d45cb64b

## Evidence chain

- Surface: mobile app (`app/`), tabs Trade (ticket Close tab, activity panel), Positions (card + Add margin / Decrease sheets), History, Account (Receipt card).
- Problem: the same kind of quantity — margin, PnL, fees, free margin — is labelled `$` in some places and `dUSDC` in others, sometimes inside one sheet:
  - `app/src/features/positions/AddMarginSheet.tsx`: the input has suffix `dUSDC` (line ~72) and hint `Available: … dUSDC` (~74), but the summary row (~84) reads `Margin $20.00 → $25.00`.
  - `app/src/features/trade/CloseTab.tsx`: `Unrealized PnL` / `Realized PnL ≈` use `signedUsd` → `+$1.23` (lines ~38, ~86, ~112), while `Close fee` and `Margin released` (~117–118) read `… dUSDC`.
  - `app/src/features/positions/PositionCard.tsx`: `Unrealized PnL` (~133–140) and `Margin` (~142) use `$`; the Trade ticket's Margin field and Account → Balances show margin in `dUSDC`.
  - `app/src/features/trade/TradeActivity.tsx`: `Unrealized PnL` via a duplicate `signedUsd` (~25, ~96–100) → `$`.
  - `app/src/features/positions/DecreaseSheet.tsx` (~56–60): `Realized PnL ≈` → `+$1.23`, formatted inline with `(Number(x) / 1e6).toFixed(2)`.
  - `app/src/features/history/HistoryScreen.tsx`: `PnL` (~63–67) and `Fees` (~68) use `$`. A negative PnL renders as `$-1.23` (sign after the symbol) because `formatUsd2` keeps the minus.
  - `app/src/features/receipt/ReceiptSection.tsx` (~97): `Free margin` is `$…`, while Account → Balances (`AccountScreen.tsx` ~157) shows the same value as `Available … dUSDC` on the same screen.
- Design evidence:
  - `docs/design/Dexxer App.dc.html` (design inspiration, Claude Design export): Positions card shows `Unrealized PnL +0.77 dUSDC (+3.9%)`, `Margin 20.00 dUSDC`; ticket shows `Fee 0.05 dUSDC`; prices (`Entry`, `Mark`, `Liq. price`) are `$`.
  - Within the app itself, the majority of money amounts are already `dUSDC`: ticket Fee (`TradeTicket.tsx` ~347), Close fee / Margin released (`CloseTab.tsx`), Balances (`AccountScreen.tsx` ~157–160), Pool snapshot (`PoolSnapshotCard.tsx` ~34–36), all margin inputs (`suffix="dUSDC"`).
- Owner: `app/src/lib/status.ts` (`formatUsd2`, the shared 1e6 → 2-decimals formatter).
- Scope and affected surfaces: the seven files above plus `app/src/lib/status.ts` and `app/test/status.test.ts`.
- Uncertainty: none on the rule. The convention "prices in `$`, amounts in `dUSDC`" is not written in any design doc yet (see Design documentation).

## Design decision

Every **amount of collateral** (margin, PnL, fees, margin released, free/locked margin) is shown as `<number> dUSDC`. Every **price** (entry, mark, exit, liq. price, trigger, slippage limit) keeps the `$` prefix. Signed amounts use the sign convention already used by `signedUsd`: `+` for ≥ 0, U+2212 `−` for < 0, followed by the absolute value — e.g. `+0.77 dUSDC`, `−1.20 dUSDC`. This removes the in-sheet contradiction and the `$-1.23` rendering.

## Reuse

- `formatUsd2` in `app/src/lib/status.ts` (number formatting stays there).
- Exemplar for unsigned amounts: `app/src/features/trade/CloseTab.tsx` `Close fee` row (`${formatUsd2(x)} dUSDC`).
- Exemplar for the sign convention: `signedUsd` in `app/src/features/trade/CloseTab.tsx` (~38).

New helpers are justified: the signed formatting is already duplicated (`signedUsd` in `CloseTab.tsx` and `TradeActivity.tsx`) and re-implemented inline in three more places (`PositionCard`, `DecreaseSheet`, `HistoryScreen`). Put two helpers next to `formatUsd2` in `app/src/lib/status.ts`:

- `formatDusdc(raw1e6: bigint): string` → `${formatUsd2(raw)} dUSDC`
- `formatSignedDusdc(raw1e6: bigint): string` → `${raw >= 0n ? '+' : '−'}${formatUsd2(raw >= 0n ? raw : -raw)} dUSDC`

## Changes

1. `app/src/lib/status.ts`
   - Change: add `formatDusdc` and `formatSignedDusdc` as above, with a short doc comment ("collateral amounts; prices keep `$`").
   - Preserve: `formatUsd2` unchanged (many callers format prices with it).
   - Verify: unit tests below.
2. `app/test/status.test.ts`
   - Change: add cases — `formatDusdc(20_000_000n)` → `20.00 dUSDC`; `formatSignedDusdc(770_000n)` → `+0.77 dUSDC`; `formatSignedDusdc(-1_200_000n)` → `−1.20 dUSDC` (U+2212); `formatSignedDusdc(0n)` → `+0.00 dUSDC`.
3. `app/src/features/trade/CloseTab.tsx`
   - Change: delete local `signedUsd`; `Unrealized PnL` and `Realized PnL ≈` use `formatSignedDusdc`; `Close fee` / `Margin released` use `formatDusdc`.
   - Preserve: `Position` row (`… @ $entry`) and `Exit ≈` keep `$` (prices); tones unchanged.
4. `app/src/features/trade/TradeActivity.tsx`
   - Change: delete local `signedUsd`; `Unrealized PnL` uses `formatSignedDusdc`.
   - Preserve: Entry / Mark / Liq. price keep `$`.
5. `app/src/features/positions/PositionCard.tsx`
   - Change: `Unrealized PnL` value = `formatSignedDusdc(upnl)` followed by the existing ` (+x.x%)` suffix; `Margin` = `formatDusdc(p.margin)`.
   - Preserve: percent suffix logic and tone; Entry / Mark / Liq. price keep `$`.
6. `app/src/features/positions/AddMarginSheet.tsx`
   - Change: `Margin` row = `${formatDusdc(position.margin)} → ${formatDusdc(newMargin)}`.
   - Preserve: `Liq. price` row keeps `$`; Leverage row unchanged.
7. `app/src/features/positions/DecreaseSheet.tsx`
   - Change: `Realized PnL ≈` = `formatSignedDusdc(realizedPnl)` (replaces the inline `toFixed(2)`).
8. `app/src/features/history/HistoryScreen.tsx`
   - Change: `PnL` = `formatSignedDusdc(r.pnl)`; `Fees` = `formatDusdc(r.fees)`.
   - Preserve: `Entry → Exit` keeps `$` (prices).
9. `app/src/features/receipt/ReceiptSection.tsx`
   - Change: `Free margin` = `formatDusdc(user.freeMargin)`; delete the now-unused local `fmtUsd` if nothing else uses it.

## Scope

- Inherit: the seven screens/sheets above.
- Verify: `TradeTicket.tsx` (Fee already `dUSDC`; prices `$` — no change expected), `PoolSnapshotCard.tsx` (already `dUSDC`, uses its own `toLocaleString` grouping — leave as is), `AccountScreen.tsx` Balances (already `dUSDC`).
- Exclude: toast texts in `TradeScreen.tsx`/`usePositionActions.ts` (they contain sizes, not amounts); `TokenInfoPanel.tsx` (market cap / volume are spot USD figures of the asset, correctly `$`); `TradeHeader.tsx` (prices and pool liquidity via `formatCompactUsd` — leave).

## Validation

- Product: open a position, open Add margin → the summary row and the input agree on `dUSDC`; a losing position shows `−x.xx dUSDC` in red on the Positions card, Trade activity, Close tab and (after close) History.
- Interface: Positions card, Add margin / Decrease sheets, Trade → Close tab, Trade activity panel, History list (positive, negative, zero PnL), Account → Receipt. Check a long value (e.g. `−12345.67 dUSDC`) still fits on one Row line at 390 px width.
- System: `grep -rn "signedUsd" app/src` → no matches; no `$` left on margin/PnL/fee values (`grep -rnE "\\$\\$\\{formatUsd2\\((upnl|r\\.pnl|r\\.fees|p\\.margin|position\\.margin|newMargin)" app/src` → no matches).
- Repository: `cd app && npm test && npx tsc --noEmit && npm run lint:check && npm run format:check` → all pass (Node 24.18 from `.nvmrc`; if `npm` is not on PATH, prefix with `PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`).

## Stop conditions

- Stop if a product owner states that PnL should be shown in USD rather than in the collateral unit (that would invert the rule, not refine it).
- Stop if any of these strings are asserted by tests outside `status.test.ts` and the assertion encodes `$` deliberately.

## Design documentation

- After acceptance and validation: add one line to `docs/design/README.md` under the rule: "Prices are shown as `$x.xx`; collateral amounts (margin, PnL, fees, balances) as `x.xx dUSDC`, signed with `+` / `−` (U+2212)."
