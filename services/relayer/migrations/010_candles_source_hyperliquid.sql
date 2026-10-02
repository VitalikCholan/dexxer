-- services/relayer/migrations/010_candles_source_hyperliquid.sql
--
-- The candle backfill source is Hyperliquid (keyless public API) — Pyth Pro
-- was dropped on 02.10.2026 (trial-only key). 'pyth_pro' stays allowed so any
-- rows a trial run may have written remain readable; nothing writes it anymore.
ALTER TABLE candles DROP CONSTRAINT IF EXISTS candles_source_check;
ALTER TABLE candles ADD CONSTRAINT candles_source_check CHECK (source IN ('oracle', 'pyth_pro', 'hyperliquid'));
