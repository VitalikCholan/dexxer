// test/alerts.test.ts — closed-beta alert rules (src/alerts.ts): which
// conditions fire, that a notice goes out only on a change, and the Telegram call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALERT_THRESHOLDS, diffAlerts, evaluateAlerts, formatAlertDiff, telegramNotifier, type AlertInput } from "../src/alerts.js";
import { buildHealthPayload, type HealthPayload } from "../src/health.js";

const NOW = 2_000_000_000_000;

function healthy(patch: Partial<HealthPayload> = {}): HealthPayload {
  const h = buildHealthPayload(
    { lastTickAt: NOW - 1_000, lastCommitAt: NOW - 60_000, tick: 10, errors: [], marketTicks: {} },
    NOW,
    1,
    2,
    "ok",
    undefined,
    { today_sol: 0.1, count_today: 3, maxCuPriceMicroLamports: 0 },
    true,
    null,
    300_000,
    { SOL: { lastTickAt: NOW - 1_000, tickAgeMs: 1_000, lastPublishTimeMs: NOW - 2_000, oracleStale: false } },
  );
  return { ...h, ...patch };
}

const input = (health: HealthPayload, extra: Partial<AlertInput> = {}): AlertInput => ({ now: NOW, health, crashesRecent: 0, sponsorBudgetSol: 2, ...extra });

test("a healthy relayer raises nothing", () => {
  assert.equal(evaluateAlerts(input(healthy())).size, 0);
});

test("each condition raises its own key", () => {
  const keys = (h: HealthPayload, extra: Partial<AlertInput> = {}) => [...evaluateAlerts(input(h, extra)).keys()];
  assert.deepEqual(keys(healthy({ ok: false, lastTickAt: NOW - 90_000 })), ["crank:stale"]);
  assert.deepEqual(keys(healthy({ ok: false, crankEnabled: false })), [], "a crank that is off is not stale");
  assert.deepEqual(
    keys(healthy({ markets: { BTC: { lastTickAt: NOW - 200_000, tickAgeMs: 200_000, lastPublishTimeMs: NOW - 100_000, oracleStale: true } } })),
    ["market:BTC:tick", "market:BTC:oracle"],
  );
  assert.deepEqual(
    keys(healthy({ markets: { ZEC: { lastTickAt: null, tickAgeMs: null, lastPublishTimeMs: null, oracleStale: true } } })),
    [],
    "a market that never ticked or printed is not alerted on",
  );
  assert.deepEqual(keys(healthy({ lastCommitAt: NOW - 3 * 300_000 - 1 })), ["commit:overdue"]);
  assert.deepEqual(keys(healthy({ feePayerSol: 0.2 })), ["balance:feePayer"]);
  assert.deepEqual(keys(healthy({ crankSol: 0.05 })), ["balance:crank"]);
  assert.deepEqual(keys(healthy({ feePayerSol: null, crankSol: null })), [], "an unknown balance is not low");
  assert.deepEqual(keys(healthy({ db: "error" })), ["db"]);
  assert.deepEqual(keys(healthy({ sponsor: { today_sol: 1.7, count_today: 90, maxCuPriceMicroLamports: 0 } })), ["sponsor:budget"]);
  assert.deepEqual(keys(healthy({ sponsor: { today_sol: 1.7, count_today: 90, maxCuPriceMicroLamports: 0 } }), { sponsorBudgetSol: null }), []);
  assert.deepEqual(keys(healthy(), { crashesRecent: DEFAULT_ALERT_THRESHOLDS.crashBurst }), ["app:crashes"]);
  assert.deepEqual(keys(healthy(), { crashesRecent: null }), []);
});

test("thresholds are configurable", () => {
  const t = { ...DEFAULT_ALERT_THRESHOLDS, minFeePayerSol: 5 };
  assert.ok(evaluateAlerts(input(healthy()), t).has("balance:feePayer"));
});

test("diffAlerts: only starts and ends are news; a reworded active alert is not", () => {
  const a = new Map([["crank:stale", "Crank: last SOL tick 90 s ago"]]);
  const b = new Map([
    ["crank:stale", "Crank: last SOL tick 120 s ago"],
    ["db", "Postgres unreachable"],
  ]);
  const d1 = diffAlerts(new Map(), a);
  assert.deepEqual(d1.fired, [["crank:stale", "Crank: last SOL tick 90 s ago"]]);
  const d2 = diffAlerts(a, b);
  assert.deepEqual(d2.fired, [["db", "Postgres unreachable"]]);
  assert.deepEqual(d2.resolved, []);
  const d3 = diffAlerts(b, new Map());
  assert.equal(d3.resolved.length, 2);
  assert.equal(formatAlertDiff(diffAlerts(a, a), "devnet"), null);
  const text = formatAlertDiff(d2, "devnet") ?? "";
  assert.match(text, /^\[dexxer devnet\]\n🔴 Postgres unreachable$/);
  assert.match(formatAlertDiff(d3, "devnet") ?? "", /✅ resolved: Crank/);
});

test("telegramNotifier posts sendMessage with the chat id and truncates", async () => {
  const calls: { url: string; body: { chat_id: string; text: string } }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await telegramNotifier("123:ABC", "-100777", fake).send("x".repeat(5000));
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:ABC/sendMessage");
  assert.equal(calls[0].body.chat_id, "-100777");
  assert.equal(calls[0].body.text.length, 4000);
  const failing = (async () => new Response("no", { status: 403 })) as typeof fetch;
  await assert.rejects(() => telegramNotifier("t", "c", failing).send("hi"), /403/);
});
