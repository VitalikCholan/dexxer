-- services/relayer/migrations/009_candles.sql
--
-- Spec §2.10.2: materialised candle tiers. `tf` is one of the three STORED
-- tiers (1m/1h/1d); the other 13 timeframes are merged from these at read
-- time (indexer/http.ts `/prices`). `source` says who wrote the bucket first:
-- 'oracle' (our tick stream) or 'pyth_pro' (backfill.ts). A later oracle
-- tick on a pyth_pro bucket flips it to 'oracle' (store.ts upsert); the
-- backfill never overwrites anything (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS candles (
  market text NOT NULL,
  tf text NOT NULL CHECK (tf IN ('1m', '1h', '1d')),
  t bigint NOT NULL,
  o bigint NOT NULL,
  h bigint NOT NULL,
  l bigint NOT NULL,
  c bigint NOT NULL,
  source text NOT NULL CHECK (source IN ('oracle', 'pyth_pro')),
  PRIMARY KEY (market, tf, t)
);

-- One-off roll-up of every tick already stored (SOL since 22.09.2026, the
-- other markets since 29.09) into the three tiers, so no own history is
-- lost when retention (indexer/retention.ts) starts deleting old ticks.
-- bigint / bigint is integer division in Postgres, so (ts / ms) * ms is the
-- bucket start — the same arithmetic timeframes.ts uses for fixed widths.
INSERT INTO candles (market, tf, t, o, h, l, c, source)
SELECT
  k.market,
  w.tf,
  (k.ts / w.ms) * w.ms AS t,
  (array_agg(k.price ORDER BY k.ts ASC))[1] AS o,
  MAX(k.price) AS h,
  MIN(k.price) AS l,
  (array_agg(k.price ORDER BY k.ts DESC))[1] AS c,
  'oracle'
FROM ticks k
CROSS JOIN (VALUES ('1m', 60000::bigint), ('1h', 3600000::bigint), ('1d', 86400000::bigint)) AS w(tf, ms)
GROUP BY k.market, w.tf, (k.ts / w.ms) * w.ms
ON CONFLICT DO NOTHING;
