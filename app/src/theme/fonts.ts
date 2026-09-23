// app/src/theme/fonts.ts
//
// IBM Plex Sans/Mono (Google Fonts via @expo-google-fonts) loaded through
// expo-font. Custom fonts on Android ignore `fontWeight` on a shared family
// name, so each weight gets its own registered family string
// (`IBMPlexSans-Regular` / `-Medium` / `-SemiBold`, mirrored for Mono) rather
// than relying on `fontWeight` to pick a variant. `useThemeFonts()` reports
// whether the load finished; callers fall back to the platform system font
// (and `Platform.select({ios:'Menlo', android:'monospace'})` for mono) until
// then, so the app never blocks on a splash screen for this.
import { useFonts } from 'expo-font'
import { Platform } from 'react-native'
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
} from '@expo-google-fonts/ibm-plex-sans'
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from '@expo-google-fonts/ibm-plex-mono'

const FAMILY = {
  sans: { 400: 'IBMPlexSans-Regular', 500: 'IBMPlexSans-Medium', 600: 'IBMPlexSans-SemiBold' },
  mono: { 400: 'IBMPlexMono-Regular', 500: 'IBMPlexMono-Medium', 600: 'IBMPlexMono-SemiBold' },
} as const

type Weight = keyof typeof FAMILY.sans

const monoSystemFallback = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

/** Loads the IBM Plex weights this app uses. Call once, at the theme root. */
export function useThemeFonts(): boolean {
  const [loaded] = useFonts({
    [FAMILY.sans[400]]: IBMPlexSans_400Regular,
    [FAMILY.sans[500]]: IBMPlexSans_500Medium,
    [FAMILY.sans[600]]: IBMPlexSans_600SemiBold,
    [FAMILY.mono[400]]: IBMPlexMono_400Regular,
    [FAMILY.mono[500]]: IBMPlexMono_500Medium,
    [FAMILY.mono[600]]: IBMPlexMono_600SemiBold,
  })
  return loaded
}

function nearestWeight(weight: number): Weight {
  if (weight >= 600) return 600
  if (weight >= 500) return 500
  return 400
}

/** Resolves a tokens.type weight to a concrete `fontFamily`, or the system fallback while fonts are still loading. */
export function fontFamilyFor(weight: number, opts: { mono?: boolean; fontsLoaded: boolean }): string | undefined {
  if (!opts.fontsLoaded) return opts.mono ? monoSystemFallback : undefined
  const w = nearestWeight(weight)
  return opts.mono ? FAMILY.mono[w] : FAMILY.sans[w]
}
