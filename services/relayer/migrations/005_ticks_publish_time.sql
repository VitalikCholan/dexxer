-- services/relayer/migrations/005_ticks_publish_time.sql
--
-- Week-5 Task 5: staleness moves from "when did this process last receive an
-- account notification" to the oracle's OWN `publish_time` (see
-- `src/indexer/prices.ts::isStale`). The TEE pushes a notification on every
-- ER slot whether or not the feed's bytes changed, so arrival time cannot
-- tell a live publisher from a frozen one; `publish_time` can.
--
-- Stored in epoch MILLISECONDS (the feed carries unix seconds; `publishTimeMs`
-- converts), same unit as `ts`, so `/mark` can compare the two directly.
-- Nullable so rows written before this migration stay readable — `/mark`
-- reports `publishTime: null` + `stale: true` for those, which is the honest
-- answer for a tick whose publish time was never recorded.

ALTER TABLE ticks ADD COLUMN IF NOT EXISTS publish_time bigint;
