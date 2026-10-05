# Open Long submit button uses the Long side color

Written against: a842d52ee3869eef3d340cddc024bdd1d45cb64b

## Evidence chain

- Surface: mobile app (`app/`), Trade tab → ticket → Open tab (`app/src/features/trade/TradeTicket.tsx`, `OpenForm`).
- Problem: the submit button colors Short by its side color but not Long. `TradeTicket.tsx` ~379: `variant={side === 'long' ? 'primary' : 'destructive'}` → Long renders `colors.accent` (purple `#7A5CFF`), Short renders `colors.short` (red). The Long/Short `Segment` right above it (`tone="long-short"`, ~286) colors the selected Long side `colors.long` (green) — so on one ticket Long is green in the toggle and purple on the button, while Short is red in both.
- Design evidence:
  - `docs/design/tokens.json`: `color.long = #2FBF7F`, `color.short = #E85B6B`, `color.textInverse = #05060A`.
  - `docs/design/Dexxer App.dc.html` (inspiration), Trade screen: the Open Long button is `background: #2FBF7F` (= `long`), `color: #05060A` (= `textInverse`), height 52, radius 10.
  - `app/src/ui/Segment.tsx`: `tone="long-short"` is the in-app owner of side coloring (`long` / `short`).
- Owner: `app/src/ui/Button.tsx` (`ButtonVariant`, `variantColors`).
- Scope and affected surfaces: `Button.tsx`, `TradeTicket.tsx`, `app/app/(tabs)/settings/ui-gallery.tsx`.
- Uncertainty: the mockup has no Open Short state, so the Short button's text color (`textPrimary` today) is not changed by this plan.

## Design decision

Add a `long` button variant whose fill is `colors.long` and text is `colors.textInverse`, and use it for the Long side of the ticket's submit button (both "Open Long" and "Place Limit/Stop Long"). Short keeps `destructive` (already `colors.short`). The side's color is then the same in the toggle and on the action that executes it.

## Reuse

- Tokens: `colors.long`, `colors.textInverse`; disabled state via the existing `disabledBg` / `disabledText` branch.
- Exemplar: the `destructive` branch of `variantColors` in `app/src/ui/Button.tsx` (solid side-color fill, no separate pressed token).

A new variant is required: `Button` offers `primary` (accent), `secondary`, `destructive` (short) and `ghost` — none can express a `long` fill. It belongs in `app/src/ui/Button.tsx`. Consumers: `TradeTicket.tsx` now; any future "buy/long" action may share it.

## Changes

1. `app/src/ui/Button.tsx`
   - Change: `export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost' | 'long'`; in `variantColors` add `case 'long': return { bg: colors.long, fg: colors.textInverse }`.
   - Preserve: disabled branch first (disabled Long still renders `disabledBg` / `disabledText`); other variants untouched; no pressed-state change (matches `destructive`).
   - Verify: TypeScript exhaustiveness — the `switch` still returns for every variant.
2. `app/src/features/trade/TradeTicket.tsx` (~379)
   - Change: `variant={side === 'long' ? 'long' : 'destructive'}`.
   - Preserve: label logic (`Open Long` / `Place Limit Long` / `Signing with session key…`), `disabled={!canSubmit}`.
   - Verify: Long → green button with near-black text; Short → red button as before.
3. `app/app/(tabs)/settings/ui-gallery.tsx` (~57–74, the Button section)
   - Change: add one `<Button variant="long" …>` sample next to the existing variants.
   - Preserve: everything else in the gallery.

## Scope

- Inherit: Trade → Open tab submit button (market, limit and stop entries).
- Verify: Trade → Close tab (`CloseTab.tsx` ~122, `destructive`) — unchanged; it closes rather than opens a side. Positions card `Close` (`destructive`) — unchanged.
- Exclude: `primary` usage elsewhere (Deposit, Withdraw, Increase, Add margin, onboarding) — accent stays the app's primary action color; Short button text color; the `Segment` component.

## Validation

- Product: on Trade, toggle Long → the submit button turns green with dark text; toggle Short → red; with trading paused (stale oracle) or insufficient margin, the Long button shows the disabled gray, not green.
- Interface: Trade → Open tab with Market / Limit / Stop, Long and Short, enabled / disabled / busy ("Signing with session key…") states; Settings → UI gallery shows the new variant. Check contrast of `textInverse` on `long` is legible on device.
- System: `variantColors` is the only place the new colors are referenced; no hex literals added.
- Repository: `cd app && npm test && npx tsc --noEmit && npm run lint:check && npm run format:check` → all pass (Node 24.18; prefix `PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH` if needed).

## Stop conditions

- Stop if the product owner states that the primary entry action is intentionally brand-accent (purple) for Long — then the fix is the opposite (Short should not be red either) and needs a decision.
- Stop if `ButtonVariant` is consumed by code outside `app/src` that switches exhaustively on it.

## Design documentation

- After acceptance and validation: add to `docs/design/README.md`: "Actions that open a side use that side's color: Long → `Button variant="long"` (`long` / `textInverse`), Short → `destructive` (`short`)."
