// services/relayer/test/backfill.test.ts — spec §2.10.3. Pyth Pro is faked
// through the injected `fetch`; Postgres through a fake pool that records
// the backfill INSERT params. No key value ever appears here — the fake key
// is a placeholder string and the test asserts it is sent only as a header.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DbPool } from "../src/db.js";
import {
  BACKFILL_RETRY_MS, PYTH_PRO_BASE, PYTH_PRO_CHANNEL, TIER_CHUNK_MS, TIER_RESOLUTION, backfillEnvFromProcess, backfillWindows, chunkRanges,
  nextBackfillDelay, parseUdfHistory, resolveProSymbol, runBackfill, startBackfill, toScaled, UdfError, type BackfillEnv,
} from "../src/indexer/backfill.js";

const D = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12); // 2026-10-02 12:00 UTC
const ENV: BackfillEnv = { apiKey: "test-key-placeholder", intervalMs: D, m1Days: 7, h1Days: 90, d1FromMs: Date.UTC(2025, 3, 1), requestGapMs: 0 };
const SYMBOLS = [
  { pyth_lazer_id: 6, symbol: "Crypto.SOL/USD" },
  { pyth_lazer_id: 110, symbol: "Crypto.HYPE/USD" },
  { pyth_lazer_id: 1, symbol: "Crypto.BTC/USD" },
];
const CATALOG = { SOL: { lazerFeedId: "6" }, HYPE: { lazerFeedId: "110" }, BTC: { lazerFeedId: "1" } };

test("backfillEnvFromProcess: disabled without a key; defaults 24 h / 7 d / 90 d / 2025-04-01 / 500 ms", () => {
  for (const k of ["PYTH_PRO_API_KEY", "BACKFILL_INTERVAL_MS", "BACKFILL_1M_DAYS", "BACKFILL_1H_DAYS", "BACKFILL_1D_FROM", "BACKFILL_REQUEST_GAP_MS"]) delete process.env[k];
  const e = backfillEnvFromProcess();
  assert.deepEqual(e, { apiKey: null, intervalMs: 86_400_000, m1Days: 7, h1Days: 90, d1FromMs: Date.UTC(2025, 3, 1), requestGapMs: 500 });
  process.env.PYTH_PRO_API_KEY = "  k  ";
  process.env.BACKFILL_1D_FROM = "2026-01-15";
  process.env.BACKFILL_INTERVAL_MS = "1000"; // below the 10 min floor → default
  const f = backfillEnvFromProcess();
  assert.equal(f.apiKey, "k");
  assert.equal(f.d1FromMs, Date.UTC(2026, 0, 15));
  assert.equal(f.intervalMs, 86_400_000);
  process.env.BACKFILL_1D_FROM = "not a date";
  assert.equal(backfillEnvFromProcess().d1FromMs, Date.UTC(2025, 3, 1));
  for (const k of ["PYTH_PRO_API_KEY", "BACKFILL_INTERVAL_MS", "BACKFILL_1D_FROM"]) delete process.env[k];
});

test("resolveProSymbol: by pyth_lazer_id, never by name; garbage → null", () => {
  assert.equal(resolveProSymbol(SYMBOLS, "110"), "Crypto.HYPE/USD");
  assert.equal(resolveProSymbol(SYMBOLS, "66"), null);
  assert.equal(resolveProSymbol({ not: "an array" }, "6"), null);
  assert.equal(resolveProSymbol([{ pyth_lazer_id: 6 }], "6"), null); // no symbol field
});

test("backfillWindows + chunkRanges: three tiers, chunked by TIER_CHUNK_MS, last chunk clipped to `to`", () => {
  const w = backfillWindows(NOW, ENV);
  assert.deepEqual(w.map((x) => x.tier), ["1m", "1h", "1d"]);
  assert.equal(w[0].fromMs, NOW - 7 * D);
  assert.equal(w[2].fromMs, Date.UTC(2025, 3, 1));
  const chunks = chunkRanges(0, 5 * D, 2 * D);
  assert.deepEqual(chunks, [{ fromMs: 0, toMs: 2 * D }, { fromMs: 2 * D, toMs: 4 * D }, { fromMs: 4 * D, toMs: 5 * D }]);
  assert.deepEqual(chunkRanges(5, 5, 10), []);
  assert.deepEqual(TIER_CHUNK_MS, { "1m": 2 * D, "1h": 90 * D, "1d": 400 * D });
  assert.deepEqual(TIER_RESOLUTION, { "1m": "1", "1h": "60", "1d": "D" });
  assert.deepEqual(backfillWindows(NOW, { ...ENV, m1Days: 0 }).map((x) => x.tier), ["1h", "1d"]);
});

test("parseUdfHistory: ok → 1e6-scaled rows; no_data → []; misaligned t dropped and counted; malformed → UdfError", () => {
  const t0 = Date.UTC(2026, 9, 1) / 1000;
  const ok = parseUdfHistory({ s: "ok", t: [t0, t0 + 86_400, t0 + 86_400 + 60], o: [1.5, 2, 3], h: [2, 3, 4], l: [1, 1.5, 2], c: [1.75, 2.5, 3.5] }, "1d");
  assert.equal(ok.misaligned, 1);
  assert.deepEqual(ok.rows, [
    { t: t0 * 1000, o: 1_500_000n, h: 2_000_000n, l: 1_000_000n, c: 1_750_000n },
    { t: (t0 + 86_400) * 1000, o: 2_000_000n, h: 3_000_000n, l: 1_500_000n, c: 2_500_000n },
  ]);
  assert.deepEqual(parseUdfHistory({ s: "no_data" }, "1m"), { rows: [], misaligned: 0 });
  assert.throws(() => parseUdfHistory({ s: "error", errmsg: "boom" }, "1m"), UdfError);
  assert.throws(() => parseUdfHistory({ s: "ok", t: [1, 2], o: [1], h: [1, 2], l: [1, 2], c: [1, 2] }, "1m"), UdfError); // lengths differ
  assert.throws(() => parseUdfHistory({ s: "ok", t: [60], o: ["1"], h: [1], l: [1], c: [1] }, "1m"), UdfError); // non-numeric
  assert.throws(() => parseUdfHistory(null, "1m"), UdfError);
  assert.equal(toScaled(123456.789012), 123_456_789_012n);
});

interface Call { url: string; auth: string | undefined }
function fakeFetch(calls: Call[], history: (url: URL) => unknown, symbolsStatus = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url: url.toString(), auth });
    if (url.pathname === "/v1/symbols") return new Response(JSON.stringify(SYMBOLS), { status: symbolsStatus });
    const body = history(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
function fakePool(inserts: unknown[][]): DbPool {
  return { query: async (_sql: string, params: unknown[]) => { inserts.push(params); return { rows: [], rowCount: (params[2] as unknown[]).length }; } } as unknown as DbPool;
}

test("runBackfill: resolves symbols by lazer id, requests each tier with the bearer header, writes rows; unknown market skipped", async () => {
  const calls: Call[] = [];
  const inserts: unknown[][] = [];
  const t0 = Date.UTC(2026, 9, 1) / 1000;
  const res = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 1, h1Days: 1 }, now: () => NOW, log: () => undefined,
    markets: () => [{ symbol: "SOL" }, { symbol: "ZEC" }],
    catalog: CATALOG,
    fetch: fakeFetch(calls, (u) => {
      // the 1d window spans two 400-day chunks: only the chunk containing t0 has the row
      const from = Number(u.searchParams.get("from"));
      const to = Number(u.searchParams.get("to"));
      return u.searchParams.get("resolution") === "D" && from <= t0 && t0 < to
        ? { s: "ok", t: [t0], o: [100], h: [110], l: [90], c: [105] }
        : { s: "no_data" };
    }),
  });
  assert.equal(res.authFailed, false);
  assert.deepEqual(res.skipped, ["ZEC: not in MARKET_CATALOG"]);
  assert.deepEqual(res.errors, []);
  assert.equal(calls[0].url, `${PYTH_PRO_BASE}/symbols?asset_type=crypto`);
  assert.equal(calls[0].auth, undefined); // symbols are keyless
  const hist = calls.slice(1);
  assert.ok(hist.length >= 3);
  for (const h of hist) {
    assert.ok(h.url.startsWith(`${PYTH_PRO_BASE}/${PYTH_PRO_CHANNEL}/history?symbol=Crypto.SOL%2FUSD`), h.url);
    assert.equal(h.auth, "Bearer test-key-placeholder");
    assert.ok(!h.url.includes("test-key-placeholder")); // never in the URL
  }
  const d1 = inserts.filter((p) => p[1] === "1d");
  assert.equal(d1.length >= 1, true);
  const withRows = d1.find((p) => (p[2] as number[]).length === 1)!;
  assert.deepEqual(withRows.slice(0, 4), ["SOL", "1d", [t0 * 1000], ["100000000"]]);
  assert.equal(res.rows, 1);
  assert.deepEqual(res.perMarket, { SOL: 1 });
});

test("runBackfill: 401 marks authFailed and stops; 5xx on one tier is an isolated error", async () => {
  const inserts: unknown[][] = [];
  const unauthorized = await runBackfill({
    pool: fakePool(inserts), env: ENV, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }, { symbol: "BTC" }], catalog: CATALOG,
    fetch: fakeFetch([], () => new Response("nope", { status: 401 })),
  });
  assert.equal(unauthorized.authFailed, true);
  assert.equal(unauthorized.errors.length, 1); // stopped after the first
  assert.equal(inserts.length, 0);

  const flaky = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 1, h1Days: 1 }, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }], catalog: CATALOG,
    fetch: fakeFetch([], (u) => (u.searchParams.get("resolution") === "60" ? new Response("", { status: 503 }) : { s: "no_data" })),
  });
  assert.equal(flaky.authFailed, false);
  assert.equal(flaky.errors.length, 1);
  assert.match(flaky.errors[0], /^SOL 1h: HTTP 503/);
});

test("runBackfill: no key → skipped, no fetch; symbols endpoint down → one error, no history calls", async () => {
  let fetched = 0;
  const off = await runBackfill({ pool: fakePool([]), env: { ...ENV, apiKey: null }, markets: () => [{ symbol: "SOL" }], catalog: CATALOG, fetch: (async () => { fetched++; return new Response(""); }) as typeof fetch });
  assert.equal(fetched, 0);
  assert.deepEqual(off.skipped, ["disabled: PYTH_PRO_API_KEY not set"]);
  const calls: Call[] = [];
  const down = await runBackfill({ pool: fakePool([]), env: ENV, markets: () => [{ symbol: "SOL" }], catalog: CATALOG, log: () => undefined, fetch: fakeFetch(calls, () => ({ s: "no_data" }), 500) });
  assert.equal(calls.length, 1);
  assert.match(down.errors[0], /^symbols: /);
});

/** Fake `setTimeout`/`clearTimeout`: records each scheduled run and its delay; `fire()` runs the pending one. */
function fakeTimers() {
  const pending: { fn: () => void; delay: number }[] = [];
  let cleared = 0;
  return {
    pending,
    cleared: () => cleared,
    timers: {
      setTimeout: ((fn: () => void, delay: number) => { pending.push({ fn, delay }); return { unref: () => undefined } as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout,
      clearTimeout: (() => { cleared++; }) as unknown as typeof clearTimeout,
    },
    async fire() {
      pending.shift()!.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}
const RETRY = 120_000;

test("BACKFILL_RETRY_MS: 10 min by default, at least 1 min", () => {
  assert.equal(BACKFILL_RETRY_MS, 600_000);
});

test("nextBackfillDelay: interval after a clean run, retry after errors / no markets / a throw, never after a 401", () => {
  const ok = { rows: 0, perMarket: {}, skipped: [], errors: [], markets: 1, authFailed: false };
  assert.equal(nextBackfillDelay(ok, D, RETRY), D);
  assert.equal(nextBackfillDelay({ ...ok, errors: ["SOL 1m: HTTP 429"] }, D, RETRY), RETRY);
  assert.equal(nextBackfillDelay({ ...ok, markets: 0 }, D, RETRY), RETRY);
  assert.equal(nextBackfillDelay(null, D, RETRY), RETRY);
  assert.equal(nextBackfillDelay({ ...ok, errors: ["x"], authFailed: true }, D, RETRY), null);
});

test("startBackfill: runs once immediately, then on the interval; snapshot tracks runs; auth failure stops scheduling", async () => {
  let runs = 0;
  const t = fakeTimers();
  const status = { code: 200 };
  const deps = {
    pool: fakePool([]), env: ENV, now: () => NOW + runs, log: () => undefined, markets: () => [{ symbol: "SOL" }], catalog: CATALOG,
    fetch: fakeFetch([], () => { runs++; return status.code === 200 ? { s: "no_data" } : new Response("", { status: status.code }); }),
  };
  const b = startBackfill(deps, t.timers, RETRY);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.snapshot().enabled, true);
  assert.equal(b.snapshot().lastRunAt, NOW);
  assert.equal(b.snapshot().lastOkAt, NOW);
  assert.equal(b.snapshot().lastError, null);
  assert.deepEqual(t.pending.map((p) => p.delay), [ENV.intervalMs]); // clean run → full interval
  status.code = 401;
  await t.fire();
  assert.equal(b.snapshot().enabled, false);
  assert.match(b.snapshot().lastError ?? "", /401/);
  assert.equal(t.pending.length, 0); // nothing scheduled after a 401
  b.stop();
});

test("startBackfill: a run with an error retries after BACKFILL_RETRY_MS, then back to the interval once clean", async () => {
  const t = fakeTimers();
  const status = { code: 429 };
  const b = startBackfill({
    pool: fakePool([]), env: ENV, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }], catalog: CATALOG,
    fetch: fakeFetch([], (u) => (u.pathname.endsWith("/history") && status.code !== 200 ? new Response("", { status: status.code }) : { s: "no_data" })),
  }, t.timers, RETRY);
  await new Promise((r) => setImmediate(r));
  assert.match(b.snapshot().lastError ?? "", /429/);
  assert.deepEqual(t.pending.map((p) => p.delay), [RETRY]);
  status.code = 200;
  await t.fire();
  assert.equal(b.snapshot().lastError, null);
  assert.deepEqual(t.pending.map((p) => p.delay), [ENV.intervalMs]);
  b.stop();
  assert.equal(t.cleared(), 1);
});

test("startBackfill: a run that saw no markets (registry not read yet) retries after BACKFILL_RETRY_MS", async () => {
  const t = fakeTimers();
  let list: { symbol: string }[] = [];
  const b = startBackfill({
    pool: fakePool([]), env: ENV, now: () => NOW, log: () => undefined, markets: () => list, catalog: CATALOG,
    fetch: fakeFetch([], () => ({ s: "no_data" })),
  }, t.timers, RETRY);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.snapshot().lastError, null);
  assert.deepEqual(t.pending.map((p) => p.delay), [RETRY]);
  list = [{ symbol: "SOL" }];
  await t.fire();
  assert.deepEqual(t.pending.map((p) => p.delay), [ENV.intervalMs]);
  b.stop();
});
