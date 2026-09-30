-- services/relayer/migrations/008_ticks_market.sql
--
-- Week 6, multi-market plan 2: one oracle feed per market. Rows written
-- before this migration are SOL's (the only market then). The primary key
-- moves from (ts) to (market, ts) — two markets' ticks can land in the same
-- millisecond — and it also serves every `WHERE market = $1 AND ts >= $2`.
ALTER TABLE ticks ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'SOL';
ALTER TABLE ticks DROP CONSTRAINT IF EXISTS ticks_pkey;
ALTER TABLE ticks ADD PRIMARY KEY (market, ts);
DROP INDEX IF EXISTS ticks_ts_idx;
