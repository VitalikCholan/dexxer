// app/src/ui/styles.ts
//
// Shared style helpers for app/src/ui/*, so no primitive hand-computes
// fontFamily/letterSpacing/textTransform on its own. All values come from
// app/src/theme tokens — see CLAUDE.md's "no hex literals in any component"
// rule (this file is the one place a color/size constant is allowed to be
// looked up, never invented).
import type { TextStyle } from 'react-native'
import { useFontsLoaded, useTheme } from '@/src/theme'
import { fontFamilyFor } from '@/src/theme/fonts'
import type { TypeToken } from '@/src/theme/tokens'

/** RN `TextStyle` for one `tokens.type` entry, with the right IBM Plex weight (or the system fallback while fonts load). */
export function useTextStyle(key: TypeToken, opts: { mono?: boolean } = {}): TextStyle {
  const { type } = useTheme()
  const fontsLoaded = useFontsLoaded()
  const entry: Record<string, unknown> = type[key]
  const style: TextStyle = {
    fontSize: entry.size as number,
    lineHeight: entry.lineHeight as number,
    fontWeight: String(entry.weight) as TextStyle['fontWeight'],
    fontFamily: fontFamilyFor(entry.weight as number, { mono: opts.mono, fontsLoaded }),
  }
  if ('letterSpacing' in entry) style.letterSpacing = entry.letterSpacing as number
  if ('textTransform' in entry) style.textTransform = entry.textTransform as TextStyle['textTransform']
  return style
}

/** Tone → text/fill color, shared by Badge/Row/Toast so tone names stay in one place. */
export type Tone = 'neutral' | 'pending' | 'success' | 'warning' | 'danger'

export function useToneColors(): Record<Tone, { fg: string; bg: string }> {
  const { colors } = useTheme()
  return {
    neutral: { fg: colors.textSecondary, bg: colors.surfaceAlt },
    // No dedicated "pending" token in docs/design/tokens.json — derived from
    // `accent` (the app's one in-flight/active-state color) rather than
    // invented; see task-8 report.
    pending: { fg: colors.accent, bg: colors.accentSubtle },
    success: { fg: colors.long, bg: colors.longSubtle },
    warning: { fg: colors.warning, bg: colors.warningSubtle },
    danger: { fg: colors.short, bg: colors.shortSubtle },
  }
}

/**
 * `hitSlop` that grows a one-line text link (MAX, Hide, Show more) to `control.minHitTarget`
 * vertically, plus `space.sm` on each side — the text itself stays small.
 */
export function useTextLinkHitSlop(text: TextStyle): { top: number; bottom: number; left: number; right: number } {
  const { control, space } = useTheme()
  const v = Math.max(0, (control.minHitTarget - (text.lineHeight ?? 0)) / 2)
  return { top: v, bottom: v, left: space.sm, right: space.sm }
}

/** Instant press feedback for a text link: dim while held. */
export const linkPressStyle = ({ pressed }: { pressed: boolean }) => ({ opacity: pressed ? 0.6 : 1 })
