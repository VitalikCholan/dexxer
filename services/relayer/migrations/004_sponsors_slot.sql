-- services/relayer/migrations/004_sponsors_slot.sql
--
-- Fix round 1, post-verification finding: a single onboarding attempt needs
-- up to MAX_SPONSOR_CALLS_PER_OWNER_WINDOW sponsored legs (L1a, L1b, the ER
-- leg, plus retries for an expired blockhash — finding D), so the original
-- "one sponsored tx per owner per 60 min" (enforced by the UNIQUE (owner,
-- "window") index from `003_sponsors_window.sql`) made a real onboarding
-- literally impossible to finish: leg 2 always got a 429 from leg 1's own
-- reservation. Caught only once this fix round actually drove a fresh
-- wallet through the full batch against the live relayer (see
-- task-6-report.md "fix round 1").
--
-- Adds a `slot` column (0..MAX_SPONSOR_CALLS_PER_OWNER_WINDOW-1,
-- `services/relayer/src/sponsor.ts`) and widens the UNIQUE index to
-- (owner, "window", slot) — `sponsor.ts::SponsorStore.reserve` tries each
-- slot's own unique index entry in turn, so the atomicity guarantee (fix
-- round 1, finding C) is unchanged, just applied N times per owner+window
-- instead of once. Existing rows (all pre-dating this migration) get
-- `slot = 0`, which is always unique per (owner, window) already (the old
-- constraint guaranteed that), so the backfill can never collide.

ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS slot smallint;
UPDATE sponsors SET slot = 0 WHERE slot IS NULL;
ALTER TABLE sponsors ALTER COLUMN slot SET NOT NULL;
DROP INDEX IF EXISTS sponsors_owner_window_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS sponsors_owner_window_slot_uidx ON sponsors (owner, "window", slot);
