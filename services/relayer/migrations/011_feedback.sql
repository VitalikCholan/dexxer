-- services/relayer/migrations/011_feedback.sql
--
-- Closed beta (06.10.2026): bug and crash reports sent from the app
-- (`POST /feedback`, src/feedback.ts). Nothing private lands here by
-- construction: the app sends a free-text description, build/device info and
-- a scrubbed event log (no balances, positions or keys — see
-- app/src/lib/diagnostics.ts). `owner` is set only when the tester chose to
-- attach their wallet address (a relayer session proves it is theirs); the IP
-- is kept only as a salted hash, for rate limiting and spotting duplicates.
CREATE TABLE IF NOT EXISTS feedback_reports (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('bug', 'crash', 'idea')),
  category text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'fixed', 'wontfix', 'duplicate')),
  owner text,
  ip_hash text,
  app_version text,
  app_build text,
  platform text,
  message text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_reports_created_idx ON feedback_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_reports_kind_status_idx ON feedback_reports (kind, status);
