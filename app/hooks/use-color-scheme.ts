// Dark-only by design — the mockup frame is "390×844 · DARK ONLY"
// (docs/design/tokens.json has no light palette to switch to; see
// app/src/theme/index.tsx's file header). The legacy Expo template wired
// this to the OS scheme, which made the app render white whenever the
// device was in light mode — this hook is the single point that pins the
// whole app to dark regardless of the system setting.
export const useColorScheme = () => 'dark' as const
