// services/relayer/src/indexer/timeframes.ts
//
// Spec §2.10.1. Pure: the 16 TradingView timeframes, bucket arithmetic
// (`1W` = Monday 00:00 UTC, `1M` = the 1st 00:00 UTC, everything else a
// fixed width from the epoch — `2D`/`5D` included), the stored tier each
// tf is derived from, and merging lower-tier candles into a tf.
//
// A logic twin (formatting differs) lives in app/src/features/chart/timeframes.ts; both
// are pinned by tests/fixtures/timeframes.golden.json. Change one → change
// the other and the fixture.
export const TIMEFRAMES = ["1s", "1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "24h", "2D", "5D", "1W", "1M"] as const;
export type Tf = (typeof TIMEFRAMES)[number];

/** Materialised in Postgres (`candles.tf`). */
export const TIERS = ["1m", "1h", "1d"] as const;
export type StoredTier = (typeof TIERS)[number];
export type Tier = "ticks" | StoredTier;
/** The tf whose bucket width a stored tier has (`1d` rows are `24h` buckets). */
export const TIER_TF: Record<StoredTier, Tf> = { "1m": "1m", "1h": "1h", "1d": "24h" };

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

type FixedTf = Exclude<Tf, "1W" | "1M">;
const FIXED_MS: Record<FixedTf, number> = {
  "1s": S, "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
  "1h": H, "2h": 2 * H, "4h": 4 * H, "6h": 6 * H, "8h": 8 * H, "12h": 12 * H,
  "24h": D, "2D": 2 * D, "5D": 5 * D,
};

export function isTf(v: unknown): v is Tf {
  return typeof v === "string" && (TIMEFRAMES as readonly string[]).includes(v);
}

export function bucketStart(tf: Tf, ms: number): number {
  if (tf === "1W") {
    const day = Math.floor(ms / D) * D;
    const dow = new Date(day).getUTCDay(); // 0 = Sunday … 6 = Saturday
    return day - ((dow + 6) % 7) * D; // back to Monday
  }
  if (tf === "1M") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const w = FIXED_MS[tf];
  return Math.floor(ms / w) * w;
}

/** Start of the bucket before the one starting at `t` (`t` must itself be a bucket start). */
export function prevBucket(tf: Tf, t: number): number {
  if (tf === "1M") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  }
  if (tf === "1W") return t - 7 * D;
  return t - FIXED_MS[tf];
}

export function nthPrevBucket(tf: Tf, t: number, n: number): number {
  let x = t;
  for (let i = 0; i < n; i++) x = prevBucket(tf, x);
  return x;
}

export function tierOf(tf: Tf): Tier {
  switch (tf) {
    case "1s":
      return "ticks";
    case "1m": case "5m": case "15m": case "30m":
      return "1m";
    case "1h": case "2h": case "4h": case "6h": case "8h": case "12h":
      return "1h";
    default:
      return "1d";
  }
}

export interface CandleLike<P> {
  /** Bucket start, unix ms. */
  t: number;
  o: P;
  h: P;
  l: P;
  c: P;
}

/**
 * Merge ascending-by-`t` lower-tier candles into `tf` buckets: o of the
 * first, max h, min l, c of the last. Works for bigint (relayer) and number
 * (app) alike — `<`/`>` compare both.
 */
export function mergeCandles<P extends bigint | number>(lower: readonly CandleLike<P>[], tf: Tf): CandleLike<P>[] {
  const out: CandleLike<P>[] = [];
  for (const c of lower) {
    const t = bucketStart(tf, c.t);
    const last = out[out.length - 1];
    if (!last || last.t !== t) {
      out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c });
      continue;
    }
    if (c.h > last.h) last.h = c.h;
    if (c.l < last.l) last.l = c.l;
    last.c = c.c;
  }
  return out;
}
