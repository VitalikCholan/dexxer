// test/metrics.test.ts — `/metrics` renders the /healthz numbers in Prometheus text format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetrics } from "../src/metrics.js";
import { buildHealthPayload } from "../src/health.js";

const NOW = 2_000_000_000_000;

test("renderMetrics: gauges, labels, and no line for an unknown value", () => {
  const h = buildHealthPayload(
    { lastTickAt: NOW - 2_000, lastCommitAt: null, tick: 42, errors: [], marketTicks: {} },
    NOW,
    1.5,
    null,
    "ok",
    undefined,
    { today_sol: 0.25, count_today: 4, maxCuPriceMicroLamports: 0 },
    true,
    null,
    300_000,
    {
      SOL: { lastTickAt: NOW - 2_000, tickAgeMs: 2_000, lastPublishTimeMs: NOW - 3_000, oracleStale: false },
      'B"TC': { lastTickAt: null, tickAgeMs: null, lastPublishTimeMs: null, oracleStale: true },
    },
  );
  const text = renderMetrics(h, NOW, { uptimeSec: 12.5, rssBytes: 1024, feedback: { bug: 3, crash: 1, idea: 0 } });
  const lines = text.split("\n");
  assert.ok(lines.includes("dexxer_up 1"));
  assert.ok(lines.includes("dexxer_crank_ticks_total 42"));
  assert.ok(lines.includes("dexxer_crank_last_tick_age_seconds 2"));
  assert.ok(!text.includes("dexxer_commit_last_age_seconds "), "no commit yet: no sample");
  assert.ok(lines.includes('dexxer_balance_sol{key="crank"} 1.5'));
  assert.ok(!text.includes('key="fee_payer"'), "unknown balance: no sample");
  assert.ok(lines.includes('dexxer_market_tick_age_seconds{market="SOL"} 2'));
  assert.ok(lines.includes('dexxer_market_oracle_stale{market="B\\"TC"} 1'), "label values are escaped");
  assert.ok(lines.includes('dexxer_feedback_reports_total{kind="bug"} 3'));
  assert.ok(lines.includes("dexxer_sponsor_tx_24h 4"));
  assert.ok(lines.includes("# TYPE dexxer_up gauge"));
  assert.ok(lines.includes("# TYPE dexxer_crank_ticks_total counter"));
  assert.ok(!text.includes("dexxer_scheduler_active"), "null scheduler state is omitted");
  assert.ok(text.endsWith("\n"));
});
