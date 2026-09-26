import { PropsWithChildren } from 'react'
import { DarkTheme, ThemeProvider } from 'expo-router'
import { colors as tokens } from '@/src/theme/tokens'

// Dark-only by design (docs/design/tokens.json — "390×844 · DARK ONLY").
// Previously picked DefaultTheme (light) when the OS was in light mode,
// which is what made the legacy screens render white — this component now
// always resolves to a dark navigation theme built from design tokens.
const appDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: tokens.bg,
    card: tokens.surface,
    text: tokens.textPrimary,
    primary: tokens.accent,
    border: tokens.border,
  },
}

export function useAppTheme() {
  return {
    colorScheme: 'dark' as const,
    isDark: true,
    theme: appDarkTheme,
  }
}

export function AppTheme({ children }: PropsWithChildren) {
  return <ThemeProvider value={appDarkTheme}>{children}</ThemeProvider>
}
