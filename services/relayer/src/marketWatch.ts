// services/relayer/src/marketWatch.ts
//
// Task 7 (scheduler backstop): watches the public `Market` account so
// `/healthz` can report `schedulerActive` (health.ts's
// `computeSchedulerActive`) — proof that the MagicBlock scheduler's own
// `crank_tick` (registered by `scripts/admin/schedule-eternal.ts`) keeps
// `Market.mark`/`mark_slot` advancing even when THIS relayer's crank loop
// is disabled (`CRANK_ENABLED=false`).
//
// Read is unauthenticated — same public-account pattern
// `indexer/accounts.ts` already uses for the oracle feed connection
// (`new Connection(erRpc, ...)` with no owner/session/crank token): `Market`
// is delegated to the ER and stays public (`delegate_market` never calls
// `init_permissions` on it, same as before). `MarketRisk` is DIFFERENT as of
// week 4 Task 2/3 — `init_market_permissions` now makes it (+`PoolLive`)
// permissioned `[crank, admin]` (CLAUDE.md's week-4 rules, risk #24 closed);
// this module watches `Market` only, so that change doesn't affect it. So
// this watcher deliberately does NOT reuse `cfg.crank`'s `teeConn` (that
// would tie "is the scheduler ticking" to our own crank identity's auth
// token, defeating the point) — it opens its own throwaway, unauthenticated
// connection to the same ER endpoint (still fine since `Market` is public).
//
// Runs regardless of `CRANK_ENABLED`: this module only tracks "did `Market`
// change", never "who changed it" — `index.ts` decides what that means via
// `computeSchedulerActive(crankEnabled, ...)`. When our own crank loop is
// ALSO running, its ticks show up here too, which is exactly why
// `computeSchedulerActive` returns `null` (not attributable) in that mode.
//
// Change detection: raw byte comparison of the account's data, not a
// decoded field — cheap, and every `crank_tick` (whichever identity sent
// it) mutates `Market` (`mark`/`mark_slot`/`ema` at minimum per
// `programs/dexxer_core/src/instructions/crank.rs`), so any byte diff is
// equivalent to "a tick landed" for this purpose.

import { Connection, PublicKey } from "@solana/web3.js";

const POLL_MS = 2000;

/** Starts polling; returns a stop function. `onChange` fires with `Date.now()` each time `market`'s account data differs from the previous read. */
export function startMarketWatch(erRpc: string, market: PublicKey, onChange: (now: number) => void): () => void {
  const conn = new Connection(erRpc, "confirmed"); // no auth token — public read, see header comment
  let lastData: Buffer | null = null;
  let stopped = false;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const info = await conn.getAccountInfo(market, "confirmed");
      if (info && (lastData === null || !info.data.equals(lastData))) {
        lastData = Buffer.from(info.data);
        onChange(Date.now());
      }
    } catch (e) {
      console.error("marketWatch: poll failed", String(e));
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => void poll(), POLL_MS);
  timer.unref?.();
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
