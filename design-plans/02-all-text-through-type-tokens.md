# Route every text string through the type tokens

Written against: a842d52ee3869eef3d340cddc024bdd1d45cb64b

## Evidence chain

- Surface: mobile app (`app/`) — History tab, Account tab, Onboarding screen.
- Problem: a few `<Text>` elements bypass `useTextStyle`, so they render in the Android system font (Roboto, default 14 px) instead of IBM Plex, or at the wrong weight:
  - `app/src/features/history/HistoryScreen.tsx` ~44: error `<Text selectable style={{ color: colors.short }}>` — no type style.
  - `app/src/features/history/HistoryScreen.tsx` ~55: card title `style={[body, { …, fontWeight: '600' }]}` — `body` resolves to the family `IBMPlexSans-Regular`; the inline `fontWeight` does not switch family on Android, so the title renders Regular, not SemiBold.
  - `app/src/features/account/AccountScreen.tsx` ~147: error `<Text style={{ color: colors.short }}>` — no type style.
  - `app/src/features/account/AccountScreen.tsx` ~183: Exit card description `<Text style={{ color: colors.textSecondary }}>` — no type style.
  - `app/src/features/onboard/OnboardScreen.tsx` ~124: error `<Text style={{ color: colors.short }}>` — no type style.
- Design evidence:
  - `docs/design/tokens.json`: `font.sans = IBM Plex Sans`, type scale `display … micro`; `docs/design/README.md`: "app components read only tokens".
  - `app/src/ui/styles.ts` header: `useTextStyle` exists "so no primitive hand-computes fontFamily/letterSpacing/textTransform on its own".
  - `app/src/theme/fonts.ts` header: "Custom fonts on Android ignore `fontWeight` on a shared family name, so each weight gets its own registered family string" — i.e. weight must come from the type token, not from `fontWeight`.
- Owner: `app/src/ui/styles.ts` (`useTextStyle`).
- Scope and affected surfaces: the three files above.
- Uncertainty: none.

## Design decision

Every user-visible string uses a `useTextStyle(<token>)` style. Error lines use `caption` + `colors.short`; secondary explanatory copy inside a card uses `caption` + `colors.textSecondary`; an emphasised card title uses `bodyStrong`. These are the patterns other screens already follow, so the fix aligns the stragglers rather than introducing anything new.

## Reuse

- `useTextStyle('caption')`, `useTextStyle('bodyStrong')` from `app/src/ui/styles.ts`.
- Exemplar (error line): `app/src/features/trade/TradeScreen.tsx` — `<Text style={[caption, { color: colors.short }]}>` (error under the banners).
- Exemplar (error line): `app/src/features/receipt/ReceiptSection.tsx` — `<Text style={[caption, { color: colors.short }]}>`.
- Exemplar (card description): `app/src/features/receipt/ReceiptSection.tsx` — `<Text style={[caption, { color: colors.textSecondary }]}>Proof that the protocol owes you …</Text>`.

No new primitive.

## Changes

1. `app/src/features/history/HistoryScreen.tsx`
   - Change: error text → `style={[caption, { color: colors.short }]}` (keep `selectable`). Card title → `const title = useTextStyle('bodyStrong')` (or rename appropriately) and `style={[title, { color: colors.textPrimary }]}`, removing the inline `fontWeight: '600'`. The existing `body` style becomes unused — delete it if so.
   - Preserve: `selectable` on the error; the screen heading (`useTextStyle('title')`) unchanged.
   - Verify: on Android, the card title is visibly SemiBold Plex; the error is 13 px Plex.
2. `app/src/features/account/AccountScreen.tsx`
   - Change: add `const caption = useTextStyle('caption')`; error text → `[caption, { color: colors.short }]`; Exit card description → `[caption, { color: colors.textSecondary }]`.
   - Preserve: copy text unchanged.
3. `app/src/features/onboard/OnboardScreen.tsx`
   - Change: error text → `[caption, { color: colors.short }]` (`caption` is already declared in this component).

## Scope

- Inherit: History, Account, Onboarding.
- Verify: `grep -rnE "<Text( selectable)? style=\{\{" app/src` afterwards lists only the two glyph cells below.
- Exclude: icon glyph cells `app/src/features/onboard/StepsList.tsx` ~82 (`STATUS_ICON`) and `app/src/features/account/ExitSheet.tsx` ~35 (`✓`/`○`) — they are symbols, not copy; leave them. Do not change any colors or copy.

## Validation

- Product: trigger an error state on History (e.g. airplane mode, pull to refresh) and Account; text reads in Plex at caption size like the Trade screen's error.
- Interface: History list with ≥ 1 record (title weight), History error, Account error, Account → Exit card, Onboarding error after a rejected wallet prompt. Android AVD, 390-ish dp width.
- System: no new style helpers; every changed line uses an existing token.
- Repository: `cd app && npm test && npx tsc --noEmit && npm run lint:check && npm run format:check` → all pass (Node 24.18; prefix `PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH` if needed).

## Stop conditions

- Stop if a global default font is introduced elsewhere (e.g. `Text.defaultProps`) in the meantime — the problem would then be partly solved by a different owner; re-scope to the weight issue only.

## Design documentation

- None (the rule is already documented in `docs/design/README.md` and `app/src/ui/styles.ts`).
