/**
 * Colors for the legacy `AppView`/`AppText`/`AppPage` template wrappers
 * (`hooks/use-theme-color.ts`). Dark-only by design (see
 * `hooks/use-color-scheme.ts`) — both palettes below derive from
 * `app/src/theme/tokens.ts` (source: docs/design/tokens.json), never a new
 * hex literal. `Colors.light` mirrors `Colors.dark`: there is no light
 * palette in the design tokens, but the shape is kept for any caller that
 * still asks for it explicitly.
 */
import { colors as tokens } from '@/src/theme/tokens'

const dexxerColors = {
  background: tokens.bg,
  border: tokens.border,
  icon: tokens.textSecondary,
  tabIconDefault: tokens.textSecondary,
  tabIconSelected: tokens.accent,
  text: tokens.textPrimary,
  tint: tokens.accent,
}

export const Colors = {
  light: dexxerColors,
  dark: dexxerColors,
}
