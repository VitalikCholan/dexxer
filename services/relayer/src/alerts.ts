// services/relayer/src/alerts.ts
//
// Closed beta monitoring: the relayer watches its own `/healthz` numbers (the
// same collector, health.ts) plus the crash-report rate (feedback.ts) every
// `ALERT_INTERVAL_MS` and posts a Telegram message when a condition STARTS
// and when it CLEARS — never once per check, so a dead feed is one message,
// not one every 30 s.
//
// What is watched (all public or the relayer's own state — no trader data):
//   * the SOL crank tick is stale (only while this relayer's crank is on);
//   * any market's tick is older than `ALERT_MARKET_TICK_AGE_MS`, or its oracle
//     is stale;
//   * `commit_aggregate` is overdue (3 × `COMMIT_INTERVAL_MS`);
//   * the crank or fee-payer SOL balance is under its floor;
//   * Postgres is unreachable;
//   * the sponsor's 24 h spend passed 80 % of its budget;
//   * a burst of crash reports (`ALERT_CRASH_BURST` within 10 minutes).
//
// The rules are pure (`evaluateAlerts`, `diffAlerts`) and unit-tested;
// `startAlerts` is the thin timer around them. Without
// `ALERT_TELEGRAM_BOT_TOKEN`/`ALERT_TELEGRAM_CHAT_ID` alerts go to the log
// only, which is what local dev and tests use.
import type { HealthPayload } from "./health.js";
import type { Notifier } from "./feedback.js";

export interface AlertThresholds {
  minFeePayerSol: number;
  minCrankSol: number;
  marketTickAgeMs: number;
  /** `commit_aggregate` counts as overdue past this many commit intervals. */
  commitOverdueIntervals: number;
  crashBurst: number;
  /** Fraction of the sponsor's daily budget that triggers the warning. */
  sponsorBudgetFraction: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  minFeePayerSol: 0.5,
  minCrankSol: 0.1,
  marketTickAgeMs: 120_000,
  commitOverdueIntervals: 3,
  crashBurst: 5,
  sponsorBudgetFraction: 0.8,
};

export const CRASH_WINDOW_MS = 10 * 60 * 1000;

export interface AlertInput {
  now: number;
  /** When this relayer process started — the reference for `commit:overdue` before any commit succeeded. */
  startedAt: number;
  health: HealthPayload;
  /** Crash reports in the last `CRASH_WINDOW_MS`; `null` when feedback is off. */
  crashesRecent: number | null;
  /** `SPONSOR_DAILY_SOL`; `null` when sponsoring is off. */
  sponsorBudgetSol: number | null;
}

/** Active alerts: stable key -> human message. A key present now and absent next time is "resolved". */
export function evaluateAlerts(input: AlertInput, t: AlertThresholds = DEFAULT_ALERT_THRESHOLDS): Map<string, string> {
  const out = new Map<string, string>();
  const h = input.health;
  const ago = (ms: number) => `${Math.round(ms / 1000)} s ago`;

  if (h.crankEnabled && !h.ok) {
    out.set("crank:stale", h.lastTickAt === null ? "Crank: no SOL tick yet since the relayer started" : `Crank: last SOL tick ${ago(input.now - h.lastTickAt)}`);
  }
  for (const [sym, m] of Object.entries(h.markets)) {
    if (h.crankEnabled && m.tickAgeMs !== null && m.tickAgeMs > t.marketTickAgeMs) {
      out.set(`market:${sym}:tick`, `${sym}: last crank tick ${ago(m.tickAgeMs)}`);
    }
    if (m.lastPublishTimeMs !== null && m.oracleStale) {
      out.set(`market:${sym}:oracle`, `${sym}: oracle price is stale (last publish ${ago(input.now - m.lastPublishTimeMs)})`);
    }
  }
  // Without a known last success (a restart with no persisted `lastCommitAt`:
  // no Postgres or a fresh DB) count from the process start, so a commit that
  // never succeeds — an empty `FeeEscrow` pays 200 000 lamports per commit —
  // still raises the alert. Only while this relayer's crank runs: the commit
  // cycle lives in it (crank.ts).
  const commitSince = h.lastCommitAt ?? (h.crankEnabled ? input.startedAt : null);
  if (commitSince !== null && input.now - commitSince > t.commitOverdueIntervals * h.commitIntervalMs) {
    out.set(
      "commit:overdue",
      h.lastCommitAt !== null
        ? `commit_aggregate overdue: last success ${ago(input.now - h.lastCommitAt)}`
        : `commit_aggregate overdue: no success since the relayer started ${ago(input.now - input.startedAt)}`,
    );
  }
  if (h.feePayerSol !== null && h.feePayerSol < t.minFeePayerSol) {
    out.set("balance:feePayer", `fee_payer balance ${h.feePayerSol.toFixed(3)} SOL < ${t.minFeePayerSol} SOL — top up (sponsored onboarding stops at 0)`);
  }
  if (h.crankSol !== null && h.crankSol < t.minCrankSol) {
    out.set("balance:crank", `crank balance ${h.crankSol.toFixed(3)} SOL < ${t.minCrankSol} SOL — top up`);
  }
  if (h.db === "error") out.set("db", "Postgres unreachable (indexer, sponsor, feedback affected)");
  if (input.sponsorBudgetSol !== null && input.sponsorBudgetSol > 0 && h.sponsor.today_sol >= t.sponsorBudgetFraction * input.sponsorBudgetSol) {
    out.set(
      "sponsor:budget",
      `Sponsor spent ${h.sponsor.today_sol.toFixed(3)} of ${input.sponsorBudgetSol} SOL in 24 h (${h.sponsor.count_today} txs) — new testers may be refused`,
    );
  }
  if (input.crashesRecent !== null && input.crashesRecent >= t.crashBurst) {
    out.set("app:crashes", `${input.crashesRecent} crash reports in the last ${CRASH_WINDOW_MS / 60_000} min`);
  }
  return out;
}

export interface AlertDiff {
  fired: [string, string][];
  resolved: [string, string][];
}

/** What changed between two evaluations. A message text change on a still-active key is not news. */
export function diffAlerts(prev: Map<string, string>, next: Map<string, string>): AlertDiff {
  const fired = [...next].filter(([k]) => !prev.has(k));
  const resolved = [...prev].filter(([k]) => !next.has(k));
  return { fired, resolved };
}

export function formatAlertDiff(d: AlertDiff, env: string): string | null {
  if (d.fired.length === 0 && d.resolved.length === 0) return null;
  const lines = [...d.fired.map(([, m]) => `🔴 ${m}`), ...d.resolved.map(([, m]) => `✅ resolved: ${m}`)];
  return `[dexxer ${env}]\n${lines.join("\n")}`;
}

/** Telegram Bot API `sendMessage`. Errors are thrown to the caller (logged there); the loop retries the same change on its next check (`notifyChanges`). */
export function telegramNotifier(botToken: string, chatId: string, fetchImpl: typeof fetch = fetch): Notifier {
  return {
    async send(text) {
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`telegram: HTTP ${res.status}`);
    },
  };
}

export const consoleNotifier: Notifier = {
  async send(text) {
    console.log(`alert: ${text.replace(/\n/g, " | ")}`);
  },
};

export interface AlertLoopDeps {
  collect: () => Promise<AlertInput>;
  notifier: Notifier;
  intervalMs: number;
  env: string;
  thresholds?: AlertThresholds;
}

/**
 * Send what changed between `active` and `next`, and return the set to remember. `next` becomes the
 * remembered set only after the send went through: a failed send (Telegram 429, a timeout) throws and
 * leaves `active` as it was, so the same change is sent again on the next check instead of being lost.
 */
export async function notifyChanges(active: Map<string, string>, next: Map<string, string>, env: string, notifier: Notifier): Promise<Map<string, string>> {
  const text = formatAlertDiff(diffAlerts(active, next), env);
  if (text) await notifier.send(text);
  return next;
}

/** Evaluate every `intervalMs`; notify only on changes. Returns a stop function. The first evaluation runs after one interval, so a booting relayer's empty state does not page anyone. */
export function startAlerts(deps: AlertLoopDeps): () => void {
  let active = new Map<string, string>();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const next = evaluateAlerts(await deps.collect(), deps.thresholds);
        active = await notifyChanges(active, next, deps.env, deps.notifier);
      } catch (e) {
        console.error("alerts: evaluation or notification failed", String(e));
      } finally {
        running = false;
      }
    })();
  }, deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
