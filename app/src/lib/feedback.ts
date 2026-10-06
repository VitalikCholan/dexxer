// app/src/lib/feedback.ts
//
// Closed beta: bug, idea and crash reports to the relayer's `POST /feedback`
// (services/relayer/src/feedback.ts). The report is built here, shown to the
// tester in full before sending, and contains: their description, an
// optional contact, build/device info, the screen and market they were on,
// and — if they keep "include diagnostics" on — the scrubbed event log
// (`diagnostics.ts`). Never balances, positions, orders or keys. The wallet
// address is attached only when the tester ticks it, by sending the relayer
// session header (the relayer takes the owner from the session, never from
// the body).
import { RELAYER_URL } from './solana'
import type { AppInfo } from './appInfo'

export const FEEDBACK_KINDS = ['bug', 'idea', 'crash'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]
export const FEEDBACK_CATEGORIES = ['trading', 'onboarding', 'funds', 'charts', 'other'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  trading: 'Trading',
  onboarding: 'Wallet / onboarding',
  funds: 'Deposit / withdraw',
  charts: 'Charts / prices',
  other: 'Other',
}
export const MAX_MESSAGE = 4000
export const MAX_CONTACT = 200

export interface FeedbackEvent {
  t: number
  level: 'info' | 'warn' | 'error'
  tag: string
  msg: string
}

export interface FeedbackBody {
  kind: FeedbackKind
  category: FeedbackCategory
  message: string
  contact: string | null
  app: AppInfo
  context: { screen: string | null; market: string | null }
  events: FeedbackEvent[]
}

export interface ReportDraft {
  kind: FeedbackKind
  category: FeedbackCategory
  message: string
  contact: string
  includeDiagnostics: boolean
  screen: string | null
  market: string | null
}

/** `null` when the draft can be sent, else what to fix. */
export function validateDraft(d: Pick<ReportDraft, 'message' | 'contact'>): string | null {
  const m = d.message.trim()
  if (m.length === 0) return 'Describe what happened'
  if (m.length > MAX_MESSAGE) return `Keep it under ${MAX_MESSAGE} characters`
  if (d.contact.trim().length > MAX_CONTACT) return `Contact is longer than ${MAX_CONTACT} characters`
  return null
}

/** Pure: the exact body that will be sent (and previewed). */
export function buildReport(d: ReportDraft, app: AppInfo, events: FeedbackEvent[]): FeedbackBody {
  return {
    kind: d.kind,
    category: d.category,
    message: d.message.trim(),
    contact: d.contact.trim() || null,
    app,
    context: d.includeDiagnostics ? { screen: d.screen, market: d.market } : { screen: null, market: null },
    events: d.includeDiagnostics ? events : [],
  }
}

export class FeedbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'FeedbackError'
  }
}

/** POST the report; resolves to the relayer's report id. `headers` carries the session only when the tester chose to attach their wallet. */
export async function sendReport(
  body: FeedbackBody,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let res: Response
  try {
    res = await fetchImpl(`${RELAYER_URL}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new FeedbackError(`Could not reach the Dexxer server: ${e instanceof Error ? e.message : String(e)}`, 0)
  }
  const out = (await res.json().catch(() => ({}))) as { id?: number; error?: string }
  if (res.status === 429) throw new FeedbackError('Too many reports from this device — try again in a while', 429)
  if (!res.ok || typeof out.id !== 'number')
    throw new FeedbackError(out.error ?? `Report not accepted (HTTP ${res.status})`, res.status)
  return out.id
}
