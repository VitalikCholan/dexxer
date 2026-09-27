// services/relayer/src/indexer/store.ts
//
// Postgres read/write helpers for the four indexer tables (migration
// `001_indexer.sql`). Every writer is a plain upsert (`ON CONFLICT`) so a
// resubscribe/reconnect in `accounts.ts` re-processing the same account
// state never crashes on a duplicate primary key.
//
// Numbers: `pg` returns `bigint` columns as JS strings by default (no
// custom type parser is installed) — every reader below keeps that string
// (or promotes to a real `bigint`/`number` only where the brief's REST
// shapes call for it), never `Number(...)`-coercing a value that could
// exceed 2^53 (capital_total etc, as USDC volume grows). See README.

import type { DbPool } from "../db.js";
import type { DisclosureQuery, PoolHistoryQuery, StatsQuery } from "./query.js";

export interface TickRow {
  ts: number;
  price: bigint;
  slot: number;
  /** Week-5 Task 5: the ORACLE's own `publish_time`, in epoch ms (`prices.ts::publishTimeMs`) — what staleness is measured against. `null` only for rows written before migration 005. */
  publishTime: number | null;
}

export interface PoolSnapshotRow {
  slot: number;
  ts: number;
  capitalTotal: bigint;
  protocolLiquidity: bigint;
  lockedTotal: bigint;
  feesAccrued: bigint;
  insurance: bigint;
  badDebtTotal: bigint;
}

export interface DisclosureRow {
  pubkey: string;
  /** L1 `Disclosure.market` (base58). The trader is never disclosed (`Disclosure.owner` is always zero). */
  market: string;
  side: string;
  size: bigint;
  entry: bigint;
  exit: bigint;
  pnl: bigint;
  fees: bigint;
  reason: string;
  openedSlot: bigint;
  closedSlot: bigint;
  nonce: bigint;
  ts: number;
}

export interface RootRow {
  rootSlot: number;
  ts: number;
  filled: number;
  leavesHex: string[];
}

export async function insertTick(pool: DbPool, row: TickRow): Promise<void> {
  await pool.query(
    "INSERT INTO ticks (ts, price, slot, publish_time) VALUES ($1, $2, $3, $4) ON CONFLICT (ts) DO UPDATE SET price = EXCLUDED.price, slot = EXCLUDED.slot, publish_time = EXCLUDED.publish_time",
    [row.ts, row.price.toString(), row.slot, row.publishTime],
  );
}

export async function listTicks(pool: DbPool, sinceTs: number): Promise<{ ts: number; price: bigint }[]> {
  const { rows } = await pool.query<{ ts: string; price: string }>("SELECT ts, price FROM ticks WHERE ts >= $1 ORDER BY ts ASC", [
    sinceTs,
  ]);
  return rows.map((r) => ({ ts: Number(r.ts), price: BigInt(r.price) }));
}

export async function latestTick(pool: DbPool): Promise<TickRow | null> {
  const { rows } = await pool.query<{ ts: string; price: string; slot: string; publish_time: string | null }>(
    "SELECT ts, price, slot, publish_time FROM ticks ORDER BY ts DESC LIMIT 1",
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ts: Number(r.ts),
    price: BigInt(r.price),
    slot: Number(r.slot),
    publishTime: r.publish_time === null ? null : Number(r.publish_time),
  };
}

export async function insertPoolSnapshot(pool: DbPool, row: PoolSnapshotRow): Promise<void> {
  await pool.query(
    `INSERT INTO pool_snapshots (slot, ts, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (slot) DO UPDATE SET
       ts = EXCLUDED.ts, capital_total = EXCLUDED.capital_total, protocol_liquidity = EXCLUDED.protocol_liquidity,
       locked_total = EXCLUDED.locked_total, fees_accrued = EXCLUDED.fees_accrued, insurance = EXCLUDED.insurance,
       bad_debt_total = EXCLUDED.bad_debt_total`,
    [
      row.slot,
      row.ts,
      row.capitalTotal.toString(),
      row.protocolLiquidity.toString(),
      row.lockedTotal.toString(),
      row.feesAccrued.toString(),
      row.insurance.toString(),
      row.badDebtTotal.toString(),
    ],
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function poolRowToJson(r: any): Record<string, unknown> {
  return {
    slot: Number(r.slot),
    ts: Number(r.ts),
    capital_total: r.capital_total,
    protocol_liquidity: r.protocol_liquidity,
    locked_total: r.locked_total,
    fees_accrued: r.fees_accrued,
    insurance: r.insurance,
    bad_debt_total: r.bad_debt_total,
  };
}

/** The `q.limit` snapshots newest-first by slot (strictly older than `q.cursor` when set), returned oldest-first. */
export async function listPoolSnapshots(pool: DbPool, q: PoolHistoryQuery): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const where = q.cursor === null ? "" : `WHERE slot < $${params.push(q.cursor.toString())}`;
  const { rows } = await pool.query(
    `SELECT slot, ts, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total FROM pool_snapshots ${where} ORDER BY slot DESC LIMIT $${params.push(q.limit)}`,
    params,
  );
  return rows.reverse().map(poolRowToJson);
}

export async function latestPoolSnapshot(pool: DbPool): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    "SELECT slot, ts, capital_total, protocol_liquidity, locked_total, fees_accrued, insurance, bad_debt_total FROM pool_snapshots ORDER BY slot DESC LIMIT 1",
  );
  return rows[0] ? poolRowToJson(rows[0]) : null;
}

/**
 * Returns `true` only the first time this `pubkey` is inserted — `accounts.ts` uses that to decide whether to broadcast over WS (a resubscribe/re-poll re-seeing an already-known Disclosure must not re-broadcast it).
 * A re-seen row still missing `market` (ingested before migration 007) gets it backfilled, silently.
 */
export async function insertDisclosure(pool: DbPool, row: DisclosureRow): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO disclosures (pubkey, side, size, entry, exit, pnl, fees, reason, opened_slot, closed_slot, nonce, ts, market)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (pubkey) DO NOTHING`,
    [
      row.pubkey,
      row.side,
      row.size.toString(),
      row.entry.toString(),
      row.exit.toString(),
      row.pnl.toString(),
      row.fees.toString(),
      row.reason,
      row.openedSlot.toString(),
      row.closedSlot.toString(),
      row.nonce.toString(),
      row.ts,
      row.market,
    ],
  );
  if ((rowCount ?? 0) > 0) return true;
  await pool.query("UPDATE disclosures SET market = $2 WHERE pubkey = $1 AND market IS NULL", [row.pubkey, row.market]);
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function disclosureRowToJson(r: any): Record<string, unknown> {
  return {
    pubkey: r.pubkey,
    market: r.market,
    side: r.side,
    size: r.size,
    entry: r.entry,
    exit: r.exit,
    pnl: r.pnl,
    fees: r.fees,
    reason: r.reason,
    opened_slot: r.opened_slot,
    closed_slot: r.closed_slot,
    nonce: r.nonce,
    ts: Number(r.ts),
  };
}

/** Newest `closed_slot` first (ties by `pubkey`), after `q.cursor` when set, narrowed by `q`'s filters. */
export async function listDisclosures(pool: DbPool, q: DisclosureQuery): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (q.cursor) where.push(`(closed_slot, pubkey) < (${p(q.cursor.closedSlot.toString())}::bigint, ${p(q.cursor.pubkey)})`);
  if (q.side) where.push(`side = ${p(q.side)}`);
  if (q.reason) where.push(`reason = ${p(q.reason)}`);
  if (q.market) where.push(`market = ${p(q.market)}`);
  if (q.from !== null) where.push(`ts >= ${p(q.from)}`);
  if (q.to !== null) where.push(`ts <= ${p(q.to)}`);
  const { rows } = await pool.query(
    `SELECT pubkey, market, side, size, entry, exit, pnl, fees, reason, opened_slot, closed_slot, nonce, ts FROM disclosures
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY closed_slot DESC, pubkey DESC LIMIT ${p(q.limit)}`,
    params,
  );
  return rows.map(disclosureRowToJson);
}

export interface DisclosureStats {
  trades: number;
  longs: number;
  shorts: number;
  liquidations: number;
  /** Trades with `pnl > 0`. */
  wins: number;
  /** `wins / trades`; `null` when there are no trades in the window. */
  win_rate: number | null;
  /** Σ opening notional in quote base units — `ceil(size · entry / 1e9)` per trade, the same rounding as `math.rs::notional`. */
  volume_quote: string;
  pnl_total: string;
  fees_total: string;
}

/** Aggregates over the public disclosure feed only — never the private `MarketRisk`/`PoolLive` (CLAUDE.md: servers read only public accounts). */
export async function disclosureStats(pool: DbPool, q: StatsQuery): Promise<DisclosureStats> {
  const { rows } = await pool.query<{
    trades: number;
    longs: number;
    shorts: number;
    liquidations: number;
    wins: number;
    volume_quote: string;
    pnl_total: string;
    fees_total: string;
  }>(
    `SELECT COUNT(*)::int AS trades,
            COUNT(*) FILTER (WHERE side = 'long')::int AS longs,
            COUNT(*) FILTER (WHERE side = 'short')::int AS shorts,
            COUNT(*) FILTER (WHERE reason = 'liquidated')::int AS liquidations,
            COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
            COALESCE(SUM(CEIL(size::numeric * entry / 1000000000)), 0)::text AS volume_quote,
            COALESCE(SUM(pnl::numeric), 0)::text AS pnl_total,
            COALESCE(SUM(fees::numeric), 0)::text AS fees_total
     FROM disclosures
     WHERE ts >= $1 AND ts <= $2 AND ($3::text IS NULL OR market = $3)`,
    [q.from, q.to, q.market],
  );
  const r = rows[0];
  return { ...r, win_rate: r.trades > 0 ? r.wins / r.trades : null };
}

export async function insertRoot(pool: DbPool, row: RootRow): Promise<void> {
  await pool.query(
    "INSERT INTO roots (root_slot, ts, filled, leaves_hex) VALUES ($1, $2, $3, $4) ON CONFLICT (root_slot) DO UPDATE SET ts = EXCLUDED.ts, filled = EXCLUDED.filled, leaves_hex = EXCLUDED.leaves_hex",
    [row.rootSlot, row.ts, row.filled, JSON.stringify(row.leavesHex)],
  );
}

export async function latestRoot(pool: DbPool): Promise<{ rootSlot: number; filled: number; leavesHex: string[] } | null> {
  const { rows } = await pool.query<{ root_slot: string; filled: number; leaves_hex: string[] }>(
    "SELECT root_slot, filled, leaves_hex FROM roots ORDER BY root_slot DESC LIMIT 1",
  );
  const r = rows[0];
  if (!r) return null;
  return { rootSlot: Number(r.root_slot), filled: r.filled, leavesHex: r.leaves_hex };
}
