// services/relayer/src/metrics.ts
//
// `GET /metrics` — the `/healthz` numbers in Prometheus text format, so an
// external scraper (Grafana Cloud, Better Stack, a self-hosted Prometheus) can
// graph and alert on them during the closed beta. Same collector as /healthz
// (health.ts): public relayer state only, nothing about traders. Optional
// bearer `METRICS_TOKEN`; without it the endpoint is as public as /healthz.
import express from "express";
import type { Router } from "express";
import type { HealthPayload } from "./health.js";
import type { FeedbackKind } from "./feedback.js";

export interface MetricsExtra {
  uptimeSec: number;
  rssBytes: number;
  /** Report totals per kind; omitted when feedback is off. */
  feedback?: Record<FeedbackKind, number>;
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Pure renderer: one `# HELP`/`# TYPE` pair per metric, unknown values skipped (Prometheus has no null). */
export function renderMetrics(h: HealthPayload, now: number, extra: MetricsExtra): string {
  const out: string[] = [];
  const metric = (name: string, type: "gauge" | "counter", help: string, samples: [Record<string, string>, number | null][]) => {
    const present = samples.filter(([, v]) => v !== null && Number.isFinite(v));
    if (present.length === 0) return;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of present) {
      const l = Object.entries(labels);
      out.push(`${name}${l.length ? `{${l.map(([k, x]) => `${k}="${esc(x)}"`).join(",")}}` : ""} ${v}`);
    }
  };
  const b = (x: boolean | null) => (x === null ? null : x ? 1 : 0);
  const ageSec = (t: number | null) => (t === null ? null : (now - t) / 1000);

  metric("dexxer_up", "gauge", "1 when /healthz would answer 200", [[{}, b(h.ok)]]);
  metric("dexxer_crank_enabled", "gauge", "1 when this relayer runs its own crank loop", [[{}, b(h.crankEnabled)]]);
  metric("dexxer_crank_ticks_total", "counter", "crank loop iterations since start", [[{}, h.tick]]);
  metric("dexxer_crank_last_tick_age_seconds", "gauge", "age of the last SOL crank tick", [[{}, ageSec(h.lastTickAt)]]);
  metric("dexxer_commit_last_age_seconds", "gauge", "age of the last successful commit_aggregate", [[{}, ageSec(h.lastCommitAt)]]);
  metric("dexxer_commit_interval_seconds", "gauge", "configured commit interval", [[{}, h.commitIntervalMs / 1000]]);
  metric("dexxer_balance_sol", "gauge", "SOL balance of the relayer's keys on L1", [
    [{ key: "crank" }, h.crankSol],
    [{ key: "fee_payer" }, h.feePayerSol],
  ]);
  metric("dexxer_db_up", "gauge", "1 when Postgres answered", [[{}, h.db === "ok" ? 1 : 0]]);
  metric("dexxer_scheduler_active", "gauge", "1 when the MagicBlock scheduler moves Market (CRANK_ENABLED=false only)", [[{}, b(h.schedulerActive)]]);
  const markets = Object.entries(h.markets);
  metric("dexxer_market_tick_age_seconds", "gauge", "age of the last crank tick per market", markets.map(([s, m]) => [{ market: s }, m.tickAgeMs === null ? null : m.tickAgeMs / 1000]));
  metric("dexxer_market_oracle_stale", "gauge", "1 when the market's oracle feed is stale", markets.map(([s, m]) => [{ market: s }, b(m.oracleStale)]));
  metric("dexxer_market_oracle_age_seconds", "gauge", "age of the oracle's own publish time per market", markets.map(([s, m]) => [{ market: s }, ageSec(m.lastPublishTimeMs)]));
  metric("dexxer_indexer_ticks_total", "counter", "oracle updates indexed since start", [[{}, h.indexer.ticks]]);
  metric("dexxer_ws_clients", "gauge", "connected /ws clients", [[{}, h.indexer.wsClients]]);
  metric("dexxer_sponsor_sol_24h", "gauge", "SOL spent by /sponsor in the last 24 h", [[{}, h.sponsor.today_sol]]);
  metric("dexxer_sponsor_tx_24h", "gauge", "transactions sponsored in the last 24 h", [[{}, h.sponsor.count_today]]);
  if (extra.feedback) {
    metric("dexxer_feedback_reports_total", "counter", "in-app reports received, by kind", Object.entries(extra.feedback).map(([k, v]) => [{ kind: k }, v]));
  }
  metric("process_uptime_seconds", "gauge", "relayer process uptime", [[{}, extra.uptimeSec]]);
  metric("process_resident_memory_bytes", "gauge", "resident set size", [[{}, extra.rssBytes]]);
  return `${out.join("\n")}\n`;
}

export function metricsRouter(deps: {
  collect: () => Promise<HealthPayload>;
  feedbackCounts?: () => Promise<Record<FeedbackKind, number>>;
  token?: string;
}): Router {
  const router = express.Router();
  router.get("/metrics", async (req, res) => {
    if (deps.token && req.get("authorization") !== `Bearer ${deps.token}`) {
      res.status(401).type("text/plain").send("metrics token required\n");
      return;
    }
    const health = await deps.collect();
    const feedback = deps.feedbackCounts ? await deps.feedbackCounts().catch(() => undefined) : undefined;
    const mem = process.memoryUsage();
    res
      .type("text/plain; version=0.0.4")
      .send(renderMetrics(health, Date.now(), { uptimeSec: process.uptime(), rssBytes: mem.rss, feedback }));
  });
  return router;
}
