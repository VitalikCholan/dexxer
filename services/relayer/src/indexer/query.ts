// services/relayer/src/indexer/query.ts
//
// Query-string parsing for the indexer's paginated/filtered public endpoints
// (`/disclosures`, `/pool/history`, `/stats`). Pure — no Postgres — so the
// validation rules are unit-tested in CI; store.ts turns the parsed values
// into SQL.
//
// Pagination is keyset, newest-first, and backward compatible: responses stay
// plain arrays; a client continues with `?cursor=` taken from the
// `X-Next-Cursor` header (or built from the last item itself).
//   /disclosures  cursor = `<closed_slot>.<pubkey>` — closed_slot alone is
//                 not unique (several traders can close in one ER slot)
//   /pool/history cursor = `<slot>` (the table's primary key)
//
// Time filters and `/stats` windows are on `ts` — when THIS indexer ingested
// the Disclosure (≈ reveal time), not when the trade closed: `closed_slot` is
// an ER slot with no reliable wall-clock mapping (see accounts.ts).
import { PublicKey } from "@solana/web3.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type Side = "long" | "short";
export type Reason = "user" | "liquidated";

export interface DisclosureCursor {
  closedSlot: bigint;
  pubkey: string;
}

export interface DisclosureQuery {
  limit: number;
  cursor: DisclosureCursor | null;
  side: Side | null;
  reason: Reason | null;
  market: string | null;
  /** Inclusive lower bound on `ts` (ms since epoch). */
  from: number | null;
  /** Inclusive upper bound on `ts` (ms since epoch). */
  to: number | null;
}

export interface PoolHistoryQuery {
  limit: number;
  /** Return snapshots strictly older than this slot. */
  cursor: bigint | null;
}

export const STATS_WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];

export interface StatsQuery {
  window: StatsWindow;
  market: string | null;
  from: number;
  to: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const HOUR_MS = 3_600_000;
const WINDOW_MS: Record<Exclude<StatsWindow, "all">, number> = { "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, "30d": 30 * 24 * HOUR_MS };
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

function isPubkey(s: string): boolean {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

function parseMs(name: string, s: string): number | { error: string } {
  if (!UINT.test(s)) return { error: `${name} must be a non-negative integer (ms since epoch)` };
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : { error: `${name} is out of range` };
}

export function parseDisclosureQuery(q: RawQuery): Parsed<DisclosureQuery> {
  const value: DisclosureQuery = { limit: parseLimit(q.limit), cursor: null, side: null, reason: null, market: null, from: null, to: null };

  const cursor = single(q, "cursor");
  if (typeof cursor === "object") return { ok: false, error: cursor.error };
  if (cursor !== undefined) {
    const dot = cursor.indexOf(".");
    const slot = cursor.slice(0, dot);
    const pubkey = cursor.slice(dot + 1);
    if (dot < 0 || !UINT.test(slot) || !isPubkey(pubkey)) {
      return { ok: false, error: "cursor must be `<closed_slot>.<pubkey>` as returned in X-Next-Cursor" };
    }
    value.cursor = { closedSlot: BigInt(slot), pubkey };
  }

  const side = single(q, "side");
  if (typeof side === "object") return { ok: false, error: side.error };
  if (side !== undefined) {
    if (side !== "long" && side !== "short") return { ok: false, error: "side must be long or short" };
    value.side = side;
  }

  const reason = single(q, "reason");
  if (typeof reason === "object") return { ok: false, error: reason.error };
  if (reason !== undefined) {
    if (reason !== "user" && reason !== "liquidated") return { ok: false, error: "reason must be user or liquidated" };
    value.reason = reason;
  }

  const market = single(q, "market");
  if (typeof market === "object") return { ok: false, error: market.error };
  if (market !== undefined) {
    if (!isPubkey(market)) return { ok: false, error: "market must be a base58 public key" };
    value.market = market;
  }

  for (const name of ["from", "to"] as const) {
    const raw = single(q, name);
    if (typeof raw === "object") return { ok: false, error: raw.error };
    if (raw === undefined) continue;
    const ms = parseMs(name, raw);
    if (typeof ms === "object") return { ok: false, error: ms.error };
    value[name] = ms;
  }
  if (value.from !== null && value.to !== null && value.from > value.to) {
    return { ok: false, error: "from must not be after to" };
  }

  return { ok: true, value };
}

/** The cursor that continues past `row` (a `/disclosures` item). */
export function disclosureCursor(row: Record<string, unknown>): string {
  return `${String(row.closed_slot)}.${String(row.pubkey)}`;
}

export function parsePoolHistoryQuery(q: RawQuery): Parsed<PoolHistoryQuery> {
  const cursor = single(q, "cursor");
  if (typeof cursor === "object") return { ok: false, error: cursor.error };
  if (cursor !== undefined && !UINT.test(cursor)) return { ok: false, error: "cursor must be a slot as returned in X-Next-Cursor" };
  return { ok: true, value: { limit: parseLimit(q.limit), cursor: cursor === undefined ? null : BigInt(cursor) } };
}

export function parseStatsQuery(q: RawQuery, now: number): Parsed<StatsQuery> {
  const rawWindow = single(q, "window");
  if (typeof rawWindow === "object") return { ok: false, error: rawWindow.error };
  const window = (rawWindow ?? "24h") as StatsWindow;
  if (!STATS_WINDOWS.includes(window)) return { ok: false, error: `window must be one of ${STATS_WINDOWS.join(", ")}` };

  const market = single(q, "market");
  if (typeof market === "object") return { ok: false, error: market.error };
  if (market !== undefined && !isPubkey(market)) return { ok: false, error: "market must be a base58 public key" };

  const from = window === "all" ? 0 : now - WINDOW_MS[window];
  return { ok: true, value: { window, market: market ?? null, from, to: now } };
}
