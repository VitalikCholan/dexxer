-- services/relayer/migrations/010_candles_source_hyperliquid.sql
--
-- The candle backfill source is Hyperliquid (keyless public API) — Pyth Pro
-- was dropped on 02.10.2026 (trial-only key). 'pyth_pro' stays allowed so any
-- rows a trial run may have written remain readable; nothing writes it anymore.
--
-- The old inline CHECK from 009 is dropped by definition, not by name: every
-- CHECK constraint on `candles` that mentions `source` goes (the `tf` check
-- does not), then the widened one is added under a known name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'candles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE candles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE candles ADD CONSTRAINT candles_source_check CHECK (source IN ('oracle', 'pyth_pro', 'hyperliquid'));
