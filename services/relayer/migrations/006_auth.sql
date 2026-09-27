-- services/relayer/migrations/006_auth.sql
--
-- Week 6 (spec §2.7, risk #27 partial): SIWS sign-in challenges and relayer
-- API sessions. `auth_challenges.nonce` is single-use (`used_at`); sessions
-- store only sha256(token), never the token itself. Expired rows are
-- garbage-collected inline by `pgAuthStore` (no background job).
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_challenges_expires_idx ON auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  owner text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);
