// app/src/theme/tokens.ts
//
// GENERATED — do not edit by hand. Source: docs/design/tokens.json.
// Regenerate with `npm run gen:tokens` (app/scripts/gen-tokens.ts) after
// changing the source JSON.

export const colors = {
  bg: '#0A0B0F',
  bgElevated: '#12141B',
  surface: '#161922',
  surfaceAlt: '#1C2029',
  border: '#232733',
  borderStrong: '#323847',
  textPrimary: '#EDEFF4',
  textSecondary: '#8A93A5',
  textTertiary: '#7E8798',
  textInverse: '#05060A',
  accent: '#7A5CFF',
  accentText: '#8A71FD',
  accentPressed: '#6A4CEF',
  accentSubtle: 'rgba(122,92,255,0.14)',
  long: '#2FBF7F',
  longSubtle: 'rgba(47,191,127,0.14)',
  short: '#E85B6B',
  shortSubtle: 'rgba(232,91,107,0.14)',
  warning: '#E0A93B',
  warningSubtle: 'rgba(224,169,59,0.14)',
  disabledBg: '#1A1D25',
  disabledText: '#4A5161',
} as const

export const fonts = {
  sans: 'IBM Plex Sans',
  mono: 'IBM Plex Mono',
  numeric: {
    fontFamily: 'IBM Plex Mono',
    fontVariantNumeric: 'tabular-nums',
  },
} as const

export const type = {
  display: {
    size: 34,
    weight: 600,
    lineHeight: 40,
    letterSpacing: -0.6,
  },
  title: {
    size: 22,
    weight: 600,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  heading: {
    size: 17,
    weight: 600,
    lineHeight: 24,
  },
  body: {
    size: 15,
    weight: 400,
    lineHeight: 22,
  },
  bodyStrong: {
    size: 15,
    weight: 600,
    lineHeight: 22,
  },
  caption: {
    size: 13,
    weight: 400,
    lineHeight: 18,
  },
  micro: {
    size: 11,
    weight: 500,
    lineHeight: 14,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 26,
  pill: 999,
} as const

export const border = {
  hairline: 1,
} as const

export const elevation = {
  none: 'none',
  sheet: '0 -1px 0 #232733',
} as const

export const layout = {
  frame: {
    width: 390,
    height: 844,
  },
  safeTop: 44,
  safeBottom: 24,
  tabBar: 72,
  gutter: 16,
} as const

export const control = {
  minHitTarget: 48,
  buttonHeight: 52,
  inputHeight: 52,
  segmentHeight: 40,
} as const

export type ColorToken = keyof typeof colors
export type SpaceToken = keyof typeof space
export type RadiusToken = keyof typeof radius
export type TypeToken = keyof typeof type
