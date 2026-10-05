// app/src/ui/assetIcons.ts — which assets ship a brand SVG (AssetIcon.tsx draws them).
//
// Only marks taken from a project's official brand kit go here — never a
// traced or redrawn logo. Everything else renders a letter avatar (spec
// 2026-10-05 market selector, §5.3). Sources are listed in AssetIcon.tsx.
/** Keep in sync with the `GLYPHS` map in AssetIcon.tsx. */
export const BRAND_ICON_SYMBOLS: readonly string[] = ['SOL', 'BTC', 'ETH', 'HYPE', 'ZEC']

export function hasBrandIcon(symbol: string): boolean {
  return BRAND_ICON_SYMBOLS.includes(symbol)
}

export function fallbackLetter(symbol: string): string {
  return symbol.charAt(0) || '?'
}
