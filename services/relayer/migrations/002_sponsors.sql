-- services/relayer/migrations/002_sponsors.sql
--
-- Task 6: `/sponsor`'s per-owner rate limit (one success per 60 min) and
-- rolling 24h spend budget.
--
-- Fix round 1, finding C: the rate limit is enforced by a UNIQUE index on
-- (owner, "window") rather than a check-then-insert race in application
-- code — `"window" = floor(ts / RATE_LIMIT_MS)` (60-minute buckets, RATE_LIMIT_MS
-- from sponsor.ts), computed and stored by the app at insert time. A row
-- starts life as a reservation (`sig = ''`, `lamports = 0`) the instant
-- `sponsor.ts::SponsorStore.reserve` succeeds (the `INSERT ... ON CONFLICT
-- (owner, "window") DO NOTHING RETURNING` is the actual race-closer), then
-- either `finalize`s with the real sig/cost or gets deleted by `release` if
-- a later check (the daily budget) rejects the request — see sponsor.ts's
-- `SponsorStore` doc for the full protocol. `"window"` is quoted throughout
-- (SQL reserved word, ANSI window functions).

CREATE TABLE IF NOT EXISTS sponsors (
  owner text NOT NULL,
  ts bigint NOT NULL,
  "window" bigint NOT NULL,
  sig text NOT NULL,
  lamports bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsors_owner_window_uidx ON sponsors (owner, "window");
CREATE INDEX IF NOT EXISTS sponsors_ts_idx ON sponsors (ts);
