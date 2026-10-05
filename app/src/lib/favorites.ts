// app/src/lib/favorites.ts
//
// Favourite markets (spec 2026-10-05 market selector, §4.3): an ordered list
// of symbols kept only on this device. Pure; storage is favoritesStore.tsx.
const SYMBOL = /^[A-Z0-9]{1,8}$/

/** Stored JSON → symbols. Anything malformed is an empty list; invalid or repeated entries are dropped. */
export function parseFavorites(raw: string | null): string[] {
  if (raw === null) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const s of v) if (typeof s === 'string' && SYMBOL.test(s) && !out.includes(s)) out.push(s)
  return out
}

/**
 * Whether the stored value may be overwritten: nothing stored yet, or a JSON
 * array. Malformed data is kept as it is (never written back), like a read error.
 */
export function favoritesWritable(raw: string | null): boolean {
  if (raw === null) return true
  try {
    return Array.isArray(JSON.parse(raw))
  } catch {
    return false
  }
}

export function toggleFavorite(list: readonly string[], symbol: string): string[] {
  return list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol]
}
