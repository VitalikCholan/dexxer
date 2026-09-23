-- services/relayer/migrations/003_sponsors_window.sql
--
-- Fix round 1, finding C: adds the `"window"` column + UNIQUE index the
-- atomic per-owner rate limit needs, as an ADDITIVE migration — any
-- environment deployed before this fix round already ran `002_sponsors.sql`
-- (tracked as applied in `_migrations`), so editing that file in place
-- (done, for the canonical schema a brand-new environment gets) never
-- re-runs there. Idempotent either way: a fresh environment that runs 002
-- for the first time after this fix round already has the column, and every
-- statement here is an `IF NOT EXISTS`/backfill-then-constrain.
--
-- `3600000` is `RATE_LIMIT_MS` (`services/relayer/src/sponsor.ts`) — a
-- migration is a static, run-once artifact, so the literal is duplicated
-- here rather than imported.

ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS "window" bigint;
UPDATE sponsors SET "window" = ts / 3600000 WHERE "window" IS NULL;
ALTER TABLE sponsors ALTER COLUMN "window" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sponsors_owner_window_uidx ON sponsors (owner, "window");
