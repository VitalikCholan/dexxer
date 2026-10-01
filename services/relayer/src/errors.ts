// services/relayer/src/errors.ts
//
// The one error classifier of the crank, the candidate sender and the janitor
// (final review m2; three classes since fix round 2, R1), decided by the
// error text:
//
// - ON-CHAIN: the transaction landed and the program rejected it
//   (`confirmSignature`'s "transaction <sig> failed: <err>", tests/er/lib/env.ts).
//   Only this can be the fault of what was IN the transaction (a pair, an
//   owner), so only this justifies retrying candidates one by one or putting
//   one owner on a cooldown.
// - SHARED: plausibly hits every market alike — auth (401/unauthorized), the
//   network (`fetch failed`, ECONN*, ETIMEDOUT, socket hang up), 429 / rate
//   limit, 5xx, and our own `freshBlockhash timeout`. The caller stops (the
//   loop, the janitor pass) and reconnects: the next send would most likely
//   fail the same way.
// - MARKET-LOCAL: everything else, INCLUDING `confirmSignature timeout
//   waiting for …` — a client-side throw while building one market's
//   instruction, a send-time rejection specific to it, a transaction of one
//   market that is always dropped. Recorded, that market counts as failed,
//   the other markets go on; no reconnect. Treating these as shared would let
//   one market's deterministic failure starve every market after it forever.
//
// No imports on purpose.

export type ErrorClass = "on-chain" | "shared" | "market-local";

export function errorMessage(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

const AUTH = /\b401\b|unauthori[sz]ed/i;
const NETWORK = /fetch failed|\bECONN[A-Z]*\b|\bETIMEDOUT\b|socket hang up/i;
const RATE_LIMIT = /\b429\b|too many requests|rate limit/i;
// "502 Bad Gateway", "HTTP 503", "503 Service Unavailable: …" — a 5xx status
// as its own token, not digits inside a signature or a number.
const SERVER = /(?:^|[\s(:])5\d\d(?=$|[\s:)])/;
const BLOCKHASH = /freshBlockhash timeout/;

/** The transaction landed and the program rejected it. */
export function looksLikeOnChainFailure(e: unknown): boolean {
  return /\btransaction \S+ failed:/.test(errorMessage(e));
}

export function classifyError(e: unknown): ErrorClass {
  if (looksLikeOnChainFailure(e)) return "on-chain";
  const msg = errorMessage(e);
  if (AUTH.test(msg) || NETWORK.test(msg) || RATE_LIMIT.test(msg) || SERVER.test(msg) || BLOCKHASH.test(msg)) return "shared";
  return "market-local";
}

/** Plausibly affects every market: stop the loop / the janitor pass and reconnect. */
export function isSharedError(e: unknown): boolean {
  return classifyError(e) === "shared";
}

/** A stale or rejected TEE token (devnet-tee answers 401) — fixed only by a reconnect. */
export function looksLikeAuthError(e: unknown): boolean {
  return AUTH.test(errorMessage(e));
}

/**
 * A failed candidate discovery reconnects only for auth or network trouble
 * (a fresh token or connection can fix those) — not for a 429/5xx, and not
 * for anything market-local (R1.4).
 */
export function shouldReconnectOnDiscoveryError(e: unknown): boolean {
  if (looksLikeOnChainFailure(e)) return false;
  const msg = errorMessage(e);
  return AUTH.test(msg) || NETWORK.test(msg);
}

/**
 * The same failure repeated with a new signature each time must dedupe
 * (`shouldRecordError`, m5): the signature in "transaction <sig> failed:" and
 * "confirmSignature timeout waiting for <sig>" is replaced by `<sig>`.
 */
export function normalizeErrorMessage(msg: string): string {
  return msg.replace(/\btransaction \S+ failed:/g, "transaction <sig> failed:").replace(/(timeout waiting for )\S+/g, "$1<sig>");
}
