// app/src/lib/diagnostics.ts
//
// Closed beta: a small in-memory log of what the app did lately, attached to
// bug and crash reports (`feedback.ts`). It exists to answer "what happened
// right before?" without ever carrying private trading state to the relayer —
// the relayer must never learn a trader's positions (CLAUDE.md, «Архітектура»).
//
// Two rules keep it that way:
//   1. Only call sites that log non-private facts call `record`: navigation
//      paths, relayer/WS connectivity, app start, crashes, and that an error
//      toast was shown — with its error code only, never its text
//      (`toastLogLine`): toast texts name trades and orders ("Position opened,
//      but TakeProfit was not set"), and next to the report's market they
//      would tell the relayer what the tester traded. Success toasts
//      ("Opened Long 0.1 SOL") are not logged at all.
//   2. Every message goes through `scrub`, which masks what could still slip
//      through: every number (amounts with or without decimals — "250 dUSDC" —
//      prices, raw u64 amounts, slots), dollar figures, base58 keys and
//      signatures (first 4 characters kept for correlation), bearer tokens and
//      URL query strings. Only a 4-digit error code in parentheses, as
//      `describeTxError` writes it ("(6015)"), and an HTTP status after
//      "HTTP " ("HTTP 429") stay readable.
// The tester sees the exact events in the report preview before sending.
import { type FeedbackEvent } from './feedback'

export const MAX_EVENTS = 200
const MAX_MSG = 500

const events: FeedbackEvent[] = []

/** Mask anything that could identify amounts, accounts or credentials (see the file header). */
export function scrub(msg: string): string {
  return (
    msg
      .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
      .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1?<query>')
      // base58 keys and signatures: 32–88 chars from the base58 alphabet
      .replace(/\b([1-9A-HJ-NP-Za-km-z]{4})[1-9A-HJ-NP-Za-km-z]{28,84}\b/g, '<$1…>')
      .replace(/\$\s?\d[\d,]*(\.\d+)?/g, '$#')
      .replace(/\b\d+\.\d+\b/g, '#.#')
      // Every other run of digits not glued to a word ("5x" and "250dUSDC" are
      // masked, "screen2" and a masked key's "<7xKX…>" are not), except an
      // error code "(6015)" and an HTTP status "HTTP 429". No lookbehind: the
      // character before the digits is captured and put back.
      .replace(/HTTP \d{3}\b|\(\d{4}\)|(^|[^A-Za-z0-9_<])\d+/g, (m, pre?: string) =>
        pre === undefined ? m : `${pre}#`,
      )
      .slice(0, MAX_MSG)
  )
}

/** The log line for a shown error/warning toast: its error code and HTTP status, never its text (see the file header). */
export function toastLogLine(text: string): string {
  const code = text.match(/\(\d{4}\)/g)?.pop()
  const http = text.match(/HTTP \d{3}\b/)?.[0]
  return [code, http].filter(Boolean).join(' ') || 'no code'
}

export function record(level: FeedbackEvent['level'], tag: string, msg: string, now: number = Date.now()): void {
  events.push({ t: now, level, tag: tag.slice(0, 40), msg: scrub(msg) })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

/** A copy, oldest first. */
export function recentEvents(): FeedbackEvent[] {
  return events.slice()
}

export function clearEvents(): void {
  events.length = 0
}
