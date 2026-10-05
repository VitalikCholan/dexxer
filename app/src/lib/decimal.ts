// Numbers typed into order fields. `Number(text) || 0` reads a comma decimal
// ("0,5" — what a decimal pad produces in many locales) and any typo as 0,
// and 0 means "not set" to every optional order field: a typed part became a
// whole-position order, a typed stop-limit bound became no bound. Here a
// filled field is either a positive number or an explicit error.

const DECIMAL = /^(\d+[.,]?\d*|[.,]\d+)$/

/** One plain non-negative decimal, dot or comma as the separator; `null` for anything else (including empty). */
export function parseDecimal(text: string): number | null {
  const t = text.trim()
  if (!DECIMAL.test(t)) return null
  const n = Number(t.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * An amount field where empty means "not set": `value` is 0 then. A field
 * with text in it must be a number above zero — otherwise `invalid`, and the
 * form must not submit.
 */
export function parseAmount(text: string): { value: number; invalid: boolean } {
  if (text.trim() === '') return { value: 0, invalid: false }
  const n = parseDecimal(text)
  return n !== null && n > 0 ? { value: n, invalid: false } : { value: 0, invalid: true }
}
