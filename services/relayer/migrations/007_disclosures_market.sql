-- services/relayer/migrations/007_disclosures_market.sql
--
-- Week 6: paginated/filtered /disclosures and /stats (indexer/query.ts).
-- `market` is the L1 `Disclosure.market` the indexer used to drop; rows
-- ingested before this migration are NULL until the next 30-s poll re-sees
-- them — `insertDisclosure` backfills it then without re-broadcasting.
-- Keyset pagination orders by (closed_slot DESC, pubkey DESC); /stats and the
-- from/to filters range over `ts`.
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS market text;
CREATE INDEX IF NOT EXISTS disclosures_closed_slot_pubkey_idx ON disclosures (closed_slot DESC, pubkey DESC);
CREATE INDEX IF NOT EXISTS disclosures_ts_idx ON disclosures (ts);
CREATE INDEX IF NOT EXISTS disclosures_market_idx ON disclosures (market);
