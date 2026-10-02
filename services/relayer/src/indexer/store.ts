// services/relayer/src/indexer/store.ts
//
// Postgres read/write helpers for the indexer tables (migrations
// `001_indexer.sql`, `009_candles.sql`). Every writer is a plain upsert (`ON CONFLICT`) so a
// resubscribe/reconnect in `accounts.ts` re-processing the same account
// state never crashes on a duplicate primary key.
//
// Numbers: `pg` returns `bigint` columns as JS strings by default (no
// custom type parser is installed) — every reader below keeps that string
// (or promotes to a real `bigint`/`number` only where the brief's REST
// shapes call for it), never `Number(...)`-coercing a value that could
// exceed 2^53 (capital_total etc, as USDC volume grows). See README.

import type { DbPool } from "../db.js";
import type { PoolHistoryQuery } from "./query.js";
import { TIER_TF, bucketStart, type StoredTier } from "./timeframes.js";

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

export interface RootRow {
  rootSlot: number;
  ts: number;
  filled: number;
  leavesHex: string[];
}

/** `market` is the registry symbol (`MarketInfo.symbol`, e.g. "SOL") — ticks are keyed `(market, ts)` since migration 008. */
export interface CandleRow {
  /** Bucket start, unix ms. */
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
}

/** 1m / 1h / 1d bucket starts of a tick — the `$6..$8` of `insertTick`'s SQL. Pure (test/candleSql.test.ts). */
export function tickBucketParams(ts: number): [number, number, number] {
  return [bucketStart(TIER_TF["1m"], ts), bucketStart(TIER_TF["1h"], ts), bucketStart(TIER_TF["1d"], ts)];
}

/**
 * `market` is the registry symbol (`MarketInfo.symbol`, e.g. "SOL") — ticks are keyed `(market, ts)` since migration 008.
 * Spec §2.10.2: one round-trip writes the tick AND upserts its 1m/1h/1d
 * candle (o kept, h = GREATEST, l = LEAST, c = this price, source flips to
 * 'oracle'). Ticks arrive in `ts` order per market, so `c` is the latest.
 */
export async function insertTick(pool: DbPool, row: TickRow & { market: string }): Promise<void> {
  const [m1, h1, d1] = tickBucketParams(row.ts);
  await pool.query(
    `WITH tick AS (
       INSERT INTO ticks (market, ts, price, slot, publish_time) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (market, ts) DO UPDATE SET price = EXCLUDED.price, slot = EXCLUDED.slot, publish_time = EXCLUDED.publish_time
     )
     INSERT INTO candles (market, tf, t, o, h, l, c, source) VALUES
       ($1, '1m', $6, $3, $3, $3, $3, 'oracle'),
       ($1, '1h', $7, $3, $3, $3, $3, 'oracle'),
       ($1, '1d', $8, $3, $3, $3, $3, 'oracle')
     ON CONFLICT (market, tf, t) DO UPDATE SET
       h = GREATEST(candles.h, EXCLUDED.h), l = LEAST(candles.l, EXCLUDED.l), c = EXCLUDED.c, source = 'oracle'`,
    [row.market, row.ts, row.price.toString(), row.slot, row.publishTime, m1, h1, d1],
  );
}

export async function listCandles(pool: DbPool, market: string, tier: StoredTier, sinceT: number): Promise<CandleRow[]> {
  const { rows } = await pool.query<{ t: string; o: string; h: string; l: string; c: string }>(
    "SELECT t, o, h, l, c FROM candles WHERE market = $1 AND tf = $2 AND t >= $3 ORDER BY t ASC",
    [market, tier, sinceT],
  );
  return rows.map((r) => ({ t: Number(r.t), o: BigInt(r.o), h: BigInt(r.h), l: BigInt(r.l), c: BigInt(r.c) }));
}

/** Backfill rows (source 'pyth_pro'): never overwrite — an oracle candle, or an earlier backfill, wins. Returns how many were inserted. */
export async function insertBackfillCandles(pool: DbPool, market: string, tier: StoredTier, rows: CandleRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO candles (market, tf, t, o, h, l, c, source)
     SELECT $1, $2, unnest($3::bigint[]), unnest($4::bigint[]), unnest($5::bigint[]), unnest($6::bigint[]), unnest($7::bigint[]), 'pyth_pro'
     ON CONFLICT (market, tf, t) DO NOTHING`,
    [market, tier, rows.map((r) => r.t), rows.map((r) => r.o.toString()), rows.map((r) => r.h.toString()), rows.map((r) => r.l.toString()), rows.map((r) => r.c.toString())],
  );
  return rowCount ?? 0;
}

/** Retention (spec §2.10.2): raw ticks older than `cutoffTs` go; candles keep the history. Returns rows deleted. */
export async function deleteTicksBefore(pool: DbPool, cutoffTs: number): Promise<number> {
  const { rowCount } = await pool.query("DELETE FROM ticks WHERE ts < $1", [cutoffTs]);
  return rowCount ?? 0;
}

export async function listTicks(pool: DbPool, market: string, sinceTs: number): Promise<{ ts: number; price: bigint }[]> {
  const { rows } = await pool.query<{ ts: string; price: string }>(
    "SELECT ts, price FROM ticks WHERE market = $1 AND ts >= $2 ORDER BY ts ASC",
    [market, sinceTs],
  );
  return rows.map((r) => ({ ts: Number(r.ts), price: BigInt(r.price) }));
}

export async function latestTick(pool: DbPool, market: string): Promise<TickRow | null> {
  const { rows } = await pool.query<{ ts: string; price: string; slot: string; publish_time: string | null }>(
    "SELECT ts, price, slot, publish_time FROM ticks WHERE market = $1 ORDER BY ts DESC LIMIT 1",
    [market],
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
