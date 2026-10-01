// services/relayer/src/indexer/query.ts
//
// Query-string parsing for the indexer's paginated public endpoints
// (`/pool/history`) and the `?market=` parameter. Pure — no Postgres — so the
// validation rules are unit-tested in CI; store.ts turns the parsed values
// into SQL.
//
// Pagination is keyset, newest-first, and backward compatible: responses stay
// plain arrays; a client continues with `?cursor=` taken from the
// `X-Next-Cursor` header.
//   /pool/history cursor = `<slot>` (the table's primary key)
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PoolHistoryQuery {
  limit: number;
  /** Return snapshots strictly older than this slot. */
  cursor: bigint | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const UINT = /^\d+$/;

type RawQuery = Record<string, unknown>;

/** Same semantics the endpoints always had: default on anything unusable, clamp to MAX_LIMIT. */
function parseLimit(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

/** `undefined` when absent; an error string when repeated (`?x=a&x=b`) or not a string. */
function single(q: RawQuery, name: string): string | undefined | { error: string } {
  const v = q[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") return { error: `${name} must be given once` };
  return v;
}

export function parsePoolHistoryQuery(q: RawQuery): Parsed<PoolHistoryQuery> {
  const cursor = single(q, "cursor");
  if (typeof cursor === "object") return { ok: false, error: cursor.error };
  if (cursor !== undefined && !UINT.test(cursor)) return { ok: false, error: "cursor must be a slot as returned in X-Next-Cursor" };
  return { ok: true, value: { limit: parseLimit(q.limit), cursor: cursor === undefined ? null : BigInt(cursor) } };
}

const SYMBOL_RE = /^[A-Z0-9]{1,8}$/;

/**
 * `?market=` on /mark and /prices — absent means SOL, the only market before
 * plan 2 (old APKs never send it). Bad format → 400, well-formed but not in
 * `known` → 404, so a client can tell "you sent garbage" from "no such market".
 */
export function parseMarketParam(
  raw: unknown,
  known: string[],
): { ok: true; value: string } | { ok: false; error: string; status: 400 | 404 } {
  if (raw === undefined || raw === "") return { ok: true, value: "SOL" };
  const s = String(raw);
  if (!SYMBOL_RE.test(s)) return { ok: false, error: `invalid market: ${s} (1-8 of A-Z0-9)`, status: 400 };
  if (!known.includes(s)) return { ok: false, error: `unknown market: ${s}`, status: 404 };
  return { ok: true, value: s };
}
