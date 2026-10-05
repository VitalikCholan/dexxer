// app/src/features/trade/assetFormat.ts
//
// Pure formatting for the «Token information» tab — runs under `npm test`.
// Locale-independent on purpose (no `Intl`/`toLocaleString`: Hermes ships
// partial ICU, and the same number must read the same on every device).

const UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

/** 1_234_567 → "1.23M"; below 1000 the number as-is with up to 2 decimals. */
export function compact(n: number): string {
  const abs = Math.abs(n)
  for (const [size, suffix] of UNITS) {
    if (abs >= size) {
      // Rounding can carry into the next unit (999_999 -> "1000K"): re-check.
      const v = Math.round((abs / size) * 100) / 100
      if (v >= 1000 && size !== 1e12) return compact(Math.sign(n) * v * size)
      return `${n < 0 ? '-' : ''}${v.toFixed(2).replace(/\.?0+$/, '')}${suffix}`
    }
  }
  return `${n < 0 ? '-' : ''}${(Math.round(abs * 100) / 100).toString()}`
}

/** "$80.12B"; "—" when unknown. */
export function formatCompactUsd(n: number | null): string {
  return n === null ? '—' : `$${compact(n)}`
}

/** Supply with its ticker: "500.12M SOL"; "—" when unknown (no max supply = "∞"-ish assets stay "—"). */
export function formatSupply(n: number | null, ticker: string): string {
  return n === null ? '—' : `${compact(n)} ${ticker}`
}

/** "2.01%"; "<0.01%" for dust; "—" when unknown. */
export function formatPercent(n: number | null): string {
  if (n === null) return '—'
  if (n > 0 && n < 0.01) return '<0.01%'
  return `${n.toFixed(2)}%`
}

/** A USD price with sensible precision: $293.31, $0.5123, $64,230.12. */
export function formatPrice(n: number): string {
  const digits = n >= 1 ? 2 : n >= 0.01 ? 4 : 6
  const [int, frac] = n.toFixed(digits).split('.')
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** ISO date or timestamp → "Nov 6, 2021" (UTC); "—" when unparseable. */
export function formatDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const d = new Date(t)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/** "Updated 3 min ago" for the disclaimer; `null` without data. */
export function updatedAgo(updatedAt: number | null, nowMs: number): string | null {
  if (updatedAt === null) return null
  const min = Math.max(0, Math.round((nowMs - updatedAt) / 60_000))
  if (min < 1) return 'Updated just now'
  if (min < 60) return `Updated ${min} min ago`
  return `Updated ${Math.round(min / 60)} h ago`
}

/** Collapsed text: cut at a word boundary near `max` chars with an ellipsis; short text is returned as-is. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return { text: `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true }
}
