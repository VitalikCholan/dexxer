// app/src/theme/index.tsx
//
// Design-token theme for app/src/ui/*. Dark-only (see docs/design/tokens.json
// — there is no light palette to switch to), so `tokens` is a plain constant
// and `useTheme()` is a thin hook around it — kept as a hook rather than a
// bare import so call sites don't change shape if a light mode ever exists.
// `ThemeProvider` owns the one thing that *is* async here: loading the IBM
// Plex weights (see ./fonts.ts) before components ask for them.
import { createContext, useContext, type PropsWithChildren } from 'react'
import * as tokens from './tokens'
import { useThemeFonts } from './fonts'

export { tokens }
export * from './tokens'

interface ThemeContextValue {
  fontsLoaded: boolean
}

const ThemeContext = createContext<ThemeContextValue>({ fontsLoaded: false })

/** Design tokens (dark-only — see file header). */
export function useTheme() {
  return tokens
}

/** Whether the IBM Plex custom fonts have finished loading — internal to app/src/ui/styles.ts's text-style helper. */
export function useFontsLoaded(): boolean {
  return useContext(ThemeContext).fontsLoaded
}

/** Loads IBM Plex Sans/Mono and makes their load state available to `useFontsLoaded()`. Wrap the whole app once, in the root layout. */
export function ThemeProvider({ children }: PropsWithChildren) {
  const fontsLoaded = useThemeFonts()
  return <ThemeContext.Provider value={{ fontsLoaded }}>{children}</ThemeContext.Provider>
}
