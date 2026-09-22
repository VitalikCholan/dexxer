-- services/relayer/migrations/002_sponsors.sql
--
-- Task 6: `/sponsor`'s per-owner rate limit (one success per 60 min) and
-- rolling 24h spend budget. One row per successful sponsor call;
-- `lamports` is the fee_payer balance delta `sponsor.ts::simulateCostEstimator`
-- measured for that transaction (see sponsor.ts's header comment for why
-- that is currently just the flat network fee under the program's
-- `payer = owner` account-creation wiring, not PDA rent).

CREATE TABLE IF NOT EXISTS sponsors (
  owner text NOT NULL,
  ts bigint NOT NULL,
  sig text NOT NULL,
  lamports bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sponsors_owner_ts_idx ON sponsors (owner, ts DESC);
CREATE INDEX IF NOT EXISTS sponsors_ts_idx ON sponsors (ts);
