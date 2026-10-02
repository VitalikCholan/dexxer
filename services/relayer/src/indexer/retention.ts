// services/relayer/src/indexer/retention.ts
//
// Spec §2.10.2: raw `ticks` serve only `1s` candles and `/mark`; the 1m/1h/1d
// candles (migration 009) hold the history, so ticks older than
// TICKS_RETENTION_MS are deleted every `intervalMs` (index.ts passes
// COMMIT_INTERVAL_MS — same cadence as the commit cycle, on its own timer
// because crank.ts's cycle has no Postgres handle). A failed DELETE is
// logged and retried next interval; it never affects ticks or commits.
import type { DbPool } from "../db.js";
import { envNum } from "../env.js";
import { deleteTicksBefore } from "./store.js";

/** Default 7 days; floor 1 hour (a `1s` chart of 1000 candles needs ~17 minutes). */
export const TICKS_RETENTION_MS = envNum("TICKS_RETENTION_MS", 7 * 24 * 3_600_000, 3_600_000);

export function retentionCutoff(now: number, retentionMs: number): number {
  return now - retentionMs;
}

export interface RetentionOpts {
  intervalMs: number;
  retentionMs?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function startRetention(pool: DbPool, opts: RetentionOpts): () => void {
  const retentionMs = opts.retentionMs ?? TICKS_RETENTION_MS;
  const now = opts.now ?? Date.now;
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const run = async (): Promise<void> => {
    try {
      const n = await deleteTicksBefore(pool, retentionCutoff(now(), retentionMs));
      if (n > 0) console.log(`retention: deleted ${n} ticks older than ${retentionMs} ms`);
    } catch (e) {
      console.error("retention: delete failed", String(e));
    }
  };
  const timer = si(() => { void run(); }, opts.intervalMs);
  timer.unref?.();
  return () => ci(timer);
}
