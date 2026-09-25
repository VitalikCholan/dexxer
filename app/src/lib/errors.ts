// app/src/lib/errors.ts
//
// Program error codes -> user-facing messages, generated from the IDL. Split
// out of `program.ts` (week 6); `test/errors.test.ts` pins the invariants.
import idlJson from '../idl/dexxer_core.json'

// --- program error codes -> short messages ---
//
// Source of truth is the IDL's `errors` array (`src/idl/dexxer_core.json`,
// CI-verified identical to `anchor build`'s output): every code the program
// can return gets its on-chain `msg` here automatically, so a new
// `#[error_code]` variant never again ships as a raw `custom program error:
// 0x…` on screen (before this, 13 of 44 codes — the whole exit flow among
// them — were missing from a hand-copied map). `ERROR_MESSAGE_OVERRIDES` is
// the one place to keep user-facing copy that says more than the terse
// on-chain message; `test/errors.test.ts` pins both invariants.
const ERROR_MESSAGE_OVERRIDES: Record<number, string> = {
  6015: 'slippage exceeded — price moved past your limit',
  6016: 'position already open',
  6017: 'no open position',
  6020: 'session key expired — redo onboarding to refresh it',
  6021: 'no actions left on this session key — redo onboarding to refresh it',
}

export const DEXXER_ERROR_MESSAGES: Record<number, string> = Object.fromEntries(
  (idlJson as unknown as { errors: { code: number; msg: string }[] }).errors.map((e) => [
    e.code,
    ERROR_MESSAGE_OVERRIDES[e.code] ?? e.msg,
  ]),
)

/** Map a thrown tx error to a short, readable message via `DEXXER_ERROR_MESSAGES` where the error carries a recognizable Anchor custom-error code; falls back to the raw error message. */
export function describeTxError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const hex = msg.match(/custom program error: 0x([0-9a-fA-F]+)/)
  const dec = msg.match(/"Custom":\s*(\d+)/i)
  const code = hex ? parseInt(hex[1], 16) : dec ? parseInt(dec[1], 10) : null
  if (code !== null && DEXXER_ERROR_MESSAGES[code]) {
    return `${DEXXER_ERROR_MESSAGES[code]} (${code})`
  }
  return msg
}
