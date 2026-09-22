-- services/relayer/migrations/001_indexer.sql
--
-- Task 5: public-data indexer tables — oracle price ticks, Pool snapshots,
-- Disclosure feed, BalancesRoot snapshots. All amount/slot columns are
-- `bigint` (signed 64-bit, same range as the on-chain u64 fields they
-- mirror) — `pg`'s default type parsing returns `bigint` columns as JS
-- strings, so `store.ts` never coerces them to `number` where they could
-- exceed 2^53 (see README's "Numbers" note).

CREATE TABLE IF NOT EXISTS ticks (
  ts bigint PRIMARY KEY,
  price bigint NOT NULL,
  slot bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ticks_ts_idx ON ticks (ts);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  slot bigint PRIMARY KEY,
  ts bigint NOT NULL,
  capital_total bigint NOT NULL,
  protocol_liquidity bigint NOT NULL,
  locked_total bigint NOT NULL,
  fees_accrued bigint NOT NULL,
  insurance bigint NOT NULL,
  bad_debt_total bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS disclosures (
  pubkey text PRIMARY KEY,
  side text NOT NULL,
  size bigint NOT NULL,
  entry bigint NOT NULL,
  exit bigint NOT NULL,
  pnl bigint NOT NULL,
  fees bigint NOT NULL,
  reason text NOT NULL,
  opened_slot bigint NOT NULL,
  closed_slot bigint NOT NULL,
  nonce bigint NOT NULL,
  ts bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS disclosures_closed_slot_idx ON disclosures (closed_slot DESC);

CREATE TABLE IF NOT EXISTS roots (
  root_slot bigint PRIMARY KEY,
  ts bigint NOT NULL,
  filled int NOT NULL,
  leaves_hex jsonb NOT NULL
);
