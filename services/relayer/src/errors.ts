// services/relayer/src/errors.ts
//
// The one error classifier of the crank, the candidate sender and the janitor
// (final review m2). Two classes, decided by the error text:
//
// - ON-CHAIN: the transaction landed and the program rejected it
//   (`confirmSignature`'s "transaction <sig> failed: <err>", tests/er/lib/env.ts).
//   Only this can be the fault of what was IN the transaction (a pair, an
//   owner), so only this justifies retrying candidates one by one or putting
//   one owner on a cooldown.
// - CONNECTION-CLASS: everything else — 401/auth, timeouts (`confirmSignature
//   timeout`, a blockhash that never refreshes), `fetch failed`, 429, 5xx and
//   any other RPC error. It says nothing about the content of the
//   transaction; the next send would most likely fail the same way, so the
//   caller stops (the market, the loop, the janitor pass) and reconnects.
//
// No imports on purpose.

export function errorMessage(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

/** The transaction landed and the program rejected it. */
export function looksLikeOnChainFailure(e: unknown): boolean {
  return /\btransaction \S+ failed:/.test(errorMessage(e));
}

/** Not an on-chain failure: the connection, the RPC or the clock — never the content of the transaction. */
export function isConnectionClass(e: unknown): boolean {
  return !looksLikeOnChainFailure(e);
}

/** A stale or rejected TEE token (devnet-tee answers 401) — fixed only by a reconnect. */
export function looksLikeAuthError(e: unknown): boolean {
  return /\b401\b|unauthori[sz]ed/i.test(errorMessage(e));
}

/**
 * The same failure repeated with a new signature each time must dedupe
 * (`shouldRecordError`, m5): the signature in "transaction <sig> failed:" and
 * "confirmSignature timeout waiting for <sig>" is replaced by `<sig>`.
 */
export function normalizeErrorMessage(msg: string): string {
  return msg.replace(/\btransaction \S+ failed:/g, "transaction <sig> failed:").replace(/(timeout waiting for )\S+/g, "$1<sig>");
}
