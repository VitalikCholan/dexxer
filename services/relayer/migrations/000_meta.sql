-- services/relayer/migrations/000_meta.sql
--
-- Generic key/value store for relayer state that must survive a restart.
-- Task 4 (index.ts) uses it for "lastTickAt"/"lastCommitAt" so /healthz's
-- history doesn't reset to null on every redeploy. Indexer/sponsor tables
-- land in Tasks 5/6 as further numbered migration files.

CREATE TABLE IF NOT EXISTS relayer_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
