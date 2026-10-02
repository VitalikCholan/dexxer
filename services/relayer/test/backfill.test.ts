// services/relayer/test/backfill.test.ts — spec §2.10.3. Hyperliquid's public
// info API is faked through the injected `fetch`; Postgres through a fake pool
// that records the backfill INSERT params. Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DbPool } from "../src/db.js";
import {
  HYPERLIQUID_INFO_URL, HlError, TIER_CHUNK_MS, TIER_INTERVAL, backfillEnvFromProcess, backfillWindows, candleSnapshotBody,
  candleSnapshotWeight, chunkRanges, nextBackfillDelay, paceDelayMs, HL_BASE_WEIGHT, parseCandleSnapshot, parseUniverse, runBackfill, startBackfill, toScaled, type BackfillEnv,
} from "../src/indexer/backfill.js";

const D = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12); // 2026-10-02 12:00 UTC
const ENV: BackfillEnv = { enabled: true, intervalMs: D, retryMs: 120_000, m1Days: 4, h1Days: 90, d1FromMs: Date.UTC(2023, 0, 1), requestGapMs: 0 };
const UNIVERSE = { universe: [{ name: "BTC", szDecimals: 5 }, { name: "SOL", szDecimals: 2 }, { name: "HYPE", szDecimals: 2 }] };
const ENV_KEYS = ["BACKFILL_ENABLED", "BACKFILL_INTERVAL_MS", "BACKFILL_RETRY_MS", "BACKFILL_1M_DAYS", "BACKFILL_1H_DAYS", "BACKFILL_1D_FROM", "BACKFILL_REQUEST_GAP_MS"];

test("backfillEnvFromProcess: enabled by default; 24 h / 10 min / 4 d / 90 d / 2023-01-01 / 500 ms", () => {
  for (const k of ENV_KEYS) delete process.env[k];
  assert.deepEqual(backfillEnvFromProcess(), {
    enabled: true, intervalMs: 86_400_000, retryMs: 600_000, m1Days: 4, h1Days: 90, d1FromMs: Date.UTC(2023, 0, 1), requestGapMs: 500,
  });
  process.env.BACKFILL_ENABLED = "false";
  process.env.BACKFILL_1D_FROM = "2026-01-15";
  process.env.BACKFILL_INTERVAL_MS = "1000"; // below the 10 min floor → default
  process.env.BACKFILL_RETRY_MS = "1000"; // below the 1 min floor → default
  const f = backfillEnvFromProcess();
  assert.equal(f.enabled, false);
  assert.equal(f.d1FromMs, Date.UTC(2026, 0, 15));
  assert.equal(f.intervalMs, 86_400_000);
  assert.equal(f.retryMs, 600_000);
  process.env.BACKFILL_ENABLED = "true";
  process.env.BACKFILL_1D_FROM = "not a date";
  assert.equal(backfillEnvFromProcess().enabled, true);
  assert.equal(backfillEnvFromProcess().d1FromMs, Date.UTC(2023, 0, 1));
  for (const k of ENV_KEYS) delete process.env[k];
});

test("parseUniverse: names set; malformed → HlError", () => {
  assert.deepEqual([...parseUniverse(UNIVERSE)].sort(), ["BTC", "HYPE", "SOL"]);
  assert.throws(() => parseUniverse(null), HlError);
  assert.throws(() => parseUniverse({ universe: "x" }), HlError);
  assert.throws(() => parseUniverse({ universe: [{ name: 5 }] }), HlError);
  assert.throws(() => parseUniverse({}), HlError);
});

test("candleSnapshotBody: exact JSON of the candleSnapshot request", () => {
  assert.equal(
    candleSnapshotBody("SOL", "1h", 1000, 2000),
    '{"type":"candleSnapshot","req":{"coin":"SOL","interval":"1h","startTime":1000,"endTime":2000}}',
  );
  assert.deepEqual(TIER_INTERVAL, { "1m": "1m", "1h": "1h", "1d": "1d" });
  assert.equal(HYPERLIQUID_INFO_URL, "https://api.hyperliquid.xyz/info");
});

const hlRow = (t: number, T: number, o = "1.5", h = "2", l = "1", c = "1.75") => ({ t, T, s: "SOL", i: "1d", o, c, h, l, v: "10", n: 3 });

test("parseCandleSnapshot: string o/h/l/c → 1e6; misaligned and in-progress rows dropped and counted", () => {
  const t0 = Date.UTC(2026, 9, 1);
  const body = [
    hlRow(t0, t0 + D - 1),
    hlRow(t0 + D, t0 + 2 * D - 1, "2", "3", "1.5", "2.5"),
    hlRow(t0 + D + 60_000, t0 + D + 3_600_000), // completed, but not a day start
    hlRow(t0 + 2 * D, t0 + 3 * D - 1), // still open at `now` (10-03 12:00)
  ];
  const { rows, misaligned, incomplete } = parseCandleSnapshot(body, "1d", t0 + 2 * D + 12 * 3_600_000, "SOL");
  assert.equal(misaligned, 1);
  assert.equal(incomplete, 1);
  assert.deepEqual(rows, [
    { t: t0, o: 1_500_000n, h: 2_000_000n, l: 1_000_000n, c: 1_750_000n },
    { t: t0 + D, o: 2_000_000n, h: 3_000_000n, l: 1_500_000n, c: 2_500_000n },
  ]);
  assert.deepEqual(parseCandleSnapshot([], "1m", NOW, "SOL"), { rows: [], misaligned: 0, incomplete: 0 });
  assert.equal(toScaled(123456.789012), 123_456_789_012n);
});

test("parseCandleSnapshot: null / non-array / non-numeric fields → HlError", () => {
  const t0 = Date.UTC(2026, 9, 1);
  assert.throws(() => parseCandleSnapshot(null, "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot({ a: 1 }, "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot([null], "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot([hlRow(t0, t0 + D - 1, "abc")], "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot([{ ...hlRow(t0, t0 + D - 1), h: 2 }], "1d", NOW, "SOL"), HlError); // number, not string
  assert.throws(() => parseCandleSnapshot([{ ...hlRow(t0, t0 + D - 1), t: "x" }], "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot([{ ...hlRow(t0, t0 + D - 1), T: undefined }], "1d", NOW, "SOL"), HlError);
});

test("parseCandleSnapshot: bad price strings and inconsistent OHLC reject the whole chunk", () => {
  const t0 = Date.UTC(2026, 9, 1);
  const bad = (o: string, h: string, l: string, c: string) => assert.throws(() => parseCandleSnapshot([hlRow(t0, t0 + D - 1, o, h, l, c)], "1d", NOW, "SOL"), HlError, `${o}/${h}/${l}/${c}`);
  bad("0x1A", "2", "1", "1.5"); // hex
  bad("1.5", "1e3", "1", "1.5"); // exponent
  bad(" 12 ", "20", "1", "1.5"); // whitespace
  bad("-5", "2", "1", "1.5"); // negative
  bad("0", "2", "1", "1.5"); // zero
  bad("1.5", "1", "2", "1.5"); // h < l
  bad("3", "2", "1", "1.5"); // o above h
  bad("1.5", "2", "1", "0.5"); // c below l
  assert.equal(parseCandleSnapshot([hlRow(t0, t0 + D - 1, "1", "2", "1", "2")], "1d", NOW, "SOL").rows.length, 1); // edges are fine
});

test("parseCandleSnapshot: a row for another coin or interval is an HlError", () => {
  const t0 = Date.UTC(2026, 9, 1);
  assert.throws(() => parseCandleSnapshot([{ ...hlRow(t0, t0 + D - 1), s: "BTC" }], "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot([{ ...hlRow(t0, t0 + D - 1), i: "1h" }], "1d", NOW, "SOL"), HlError);
  assert.throws(() => parseCandleSnapshot([{ ...hlRow(t0, t0 + D - 1), s: undefined }], "1d", NOW, "SOL"), HlError);
});

test("backfillWindows + chunkRanges: three tiers, chunked by TIER_CHUNK_MS, last chunk clipped to `to`", () => {
  const w = backfillWindows(NOW, ENV);
  assert.deepEqual(w.map((x) => x.tier), ["1m", "1h", "1d"]);
  assert.equal(w[0].fromMs, NOW - 4 * D);
  assert.equal(w[2].fromMs, Date.UTC(2023, 0, 1));
  assert.deepEqual(chunkRanges(0, 5 * D, 2 * D), [{ fromMs: 0, toMs: 2 * D }, { fromMs: 2 * D, toMs: 4 * D }, { fromMs: 4 * D, toMs: 5 * D }]);
  assert.deepEqual(chunkRanges(5, 5, 10), []);
  assert.deepEqual(TIER_CHUNK_MS, { "1m": 2 * D, "1h": 90 * D, "1d": 400 * D });
  assert.deepEqual(backfillWindows(NOW, { ...ENV, m1Days: 0 }).map((x) => x.tier), ["1h", "1d"]);
});

interface Call { url: string; contentType: string | undefined; body: { type: string; req?: { coin: string; interval: string; startTime: number; endTime: number } } }
type Candles = (req: NonNullable<Call["body"]["req"]>) => unknown;
function fakeFetch(calls: Call[], candles: Candles, meta: () => unknown = () => UNIVERSE): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), contentType: (init?.headers as Record<string, string> | undefined)?.["Content-Type"], body });
    let out = body.type === "meta" ? meta() : candles(body.req);
    if (Array.isArray(out)) out = out.map((r: object) => ({ ...r, s: body.req.coin, i: body.req.interval })); // a well-behaved server echoes coin/interval
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
}
function fakePool(inserts: unknown[][]): DbPool {
  return { query: async (_sql: string, params: unknown[]) => { inserts.push(params); return { rows: [], rowCount: (params[2] as unknown[]).length }; } } as unknown as DbPool;
}

test("runBackfill: meta once, then each tier per market with the right coin/interval/chunks; market outside the universe skipped", async () => {
  const calls: Call[] = [];
  const inserts: unknown[][] = [];
  const t0 = Date.UTC(2026, 9, 1);
  const res = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 1, h1Days: 1 }, now: () => NOW, log: () => undefined,
    markets: () => [{ symbol: "SOL" }, { symbol: "ZEC" }],
    fetch: fakeFetch(calls, (r) =>
      // the 1d window spans several 400-day chunks; the row sits in the one containing t0 (and, being inclusive, maybe two)
      r.interval === "1d" && r.startTime <= t0 && t0 <= r.endTime ? [hlRow(t0, t0 + D - 1)] : []),
  });
  assert.deepEqual(res.skipped, ["ZEC: not in Hyperliquid universe"]);
  assert.deepEqual(res.errors, []);
  assert.equal(calls.filter((c) => c.body.type === "meta").length, 1);
  assert.equal(calls[0].body.type, "meta");
  for (const c of calls) {
    assert.equal(c.url, HYPERLIQUID_INFO_URL);
    assert.equal(c.contentType, "application/json");
  }
  const candles = calls.filter((c) => c.body.type === "candleSnapshot").map((c) => c.body.req!);
  assert.ok(candles.every((r) => r.coin === "SOL"));
  assert.deepEqual(candles.filter((r) => r.interval === "1m"), [{ coin: "SOL", interval: "1m", startTime: NOW - D, endTime: NOW }]);
  assert.deepEqual(candles.filter((r) => r.interval === "1h"), [{ coin: "SOL", interval: "1h", startTime: NOW - D, endTime: NOW }]);
  const d1 = candles.filter((r) => r.interval === "1d");
  assert.ok(d1.length >= 3);
  assert.equal(d1[0].startTime, Date.UTC(2023, 0, 1));
  assert.equal(d1[0].endTime, d1[0].startTime + 400 * D); // chunk boundary
  assert.equal(d1[1].startTime, d1[0].endTime);
  assert.equal(d1[d1.length - 1].endTime, NOW);
  const rowInserts = inserts.filter((p) => p[1] === "1d" && (p[2] as number[]).length > 0);
  assert.equal(rowInserts.length, 1);
  assert.deepEqual(rowInserts[0].slice(0, 4), ["SOL", "1d", [t0], ["1500000"]]);
  assert.equal(res.rows, 1);
  assert.deepEqual(res.perMarket, { SOL: 1 });
  assert.equal(res.markets, 2);
});

test("runBackfill: a candle repeated at a chunk boundary (inclusive endTime) is inserted once", async () => {
  const inserts: unknown[][] = [];
  const edge = Date.UTC(2023, 0, 1) + 400 * D; // chunk 1 endTime == chunk 2 startTime
  const res = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 0, h1Days: 0 }, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }],
    fetch: fakeFetch([], (r) => (r.startTime <= edge && edge <= r.endTime ? [hlRow(edge, edge + D - 1)] : [])),
  });
  assert.equal(res.rows, 1);
  assert.equal(inserts.filter((p) => (p[2] as number[]).length > 0).length, 1);
});

test("runBackfill: a 500 on one tier is an isolated error; the other tiers and markets still run", async () => {
  const inserts: unknown[][] = [];
  const t0 = Date.UTC(2026, 9, 1);
  const res = await runBackfill({
    pool: fakePool(inserts), env: { ...ENV, m1Days: 1, h1Days: 1, d1FromMs: t0 }, now: () => NOW, log: () => undefined,
    markets: () => [{ symbol: "SOL" }, { symbol: "BTC" }],
    fetch: fakeFetch([], (r) => (r.interval === "1h" && r.coin === "SOL" ? new Response("null", { status: 500 }) : [hlRow(t0, t0 + D - 1)].filter(() => r.interval === "1d"))),
  });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^SOL 1h: HTTP 500/);
  assert.deepEqual(res.perMarket, { SOL: 1, BTC: 1 });
});

test("runBackfill: rows count chunks inserted before a later chunk fails", async () => {
  const t0 = Date.UTC(2023, 0, 1);
  const res = await runBackfill({
    pool: fakePool([]), env: { ...ENV, m1Days: 0, h1Days: 0 }, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }],
    fetch: fakeFetch([], (r) => (r.startTime === t0 ? [hlRow(t0, t0 + D - 1)] : new Response("", { status: 503 }))),
  });
  assert.equal(res.rows, 1);
  assert.deepEqual(res.perMarket, { SOL: 1 });
  assert.match(res.errors[0], /^SOL 1d: HTTP 503/);
});

test("runBackfill: meta failure → exactly one error and no candle requests; disabled → no fetch", async () => {
  const calls: Call[] = [];
  const down = await runBackfill({
    pool: fakePool([]), env: ENV, log: () => undefined, markets: () => [{ symbol: "SOL" }],
    fetch: fakeFetch(calls, () => [], () => new Response("", { status: 503 })),
  });
  assert.equal(calls.length, 1);
  assert.equal(down.errors.length, 1);
  assert.match(down.errors[0], /^meta: /);
  let fetched = 0;
  const off = await runBackfill({
    pool: fakePool([]), env: { ...ENV, enabled: false }, markets: () => [{ symbol: "SOL" }],
    fetch: (async () => { fetched++; return new Response(""); }) as typeof fetch,
  });
  assert.equal(fetched, 0);
  assert.deepEqual(off.skipped, ["disabled: BACKFILL_ENABLED=false"]);
});

test("candleSnapshotWeight: 20 + 1 per 60 candles returned", () => {
  for (const [n, w] of [[0, 20], [1, 21], [60, 21], [61, 22], [2880, 68], [2161, 57], [401, 27]]) assert.equal(candleSnapshotWeight(n), w, `n=${n}`);
});

test("paceDelayMs: 50 ms per weight unit, never below the configured gap", () => {
  assert.equal(paceDelayMs(68, 500), 3400);
  assert.equal(paceDelayMs(20, 500), 1000);
  assert.equal(paceDelayMs(1, 500), 500);
});

test("runBackfill: sleeps paceDelayMs(weight) after meta and after each candleSnapshot; weightSpent sums the weights", async () => {
  const delays: number[] = [];
  const t0 = Date.UTC(2026, 9, 1);
  const gap = 500;
  const res = await runBackfill({
    pool: fakePool([]), env: { ...ENV, m1Days: 0, h1Days: 0, d1FromMs: t0, requestGapMs: gap }, now: () => NOW, log: () => undefined,
    markets: () => [{ symbol: "SOL" }],
    sleep: async (ms) => { delays.push(ms); },
    fetch: fakeFetch([], () => Array.from({ length: 130 }, (_, i) => hlRow(t0 + i * D, t0 + (i + 1) * D - 1))),
  });
  assert.deepEqual(res.errors, []);
  const w = candleSnapshotWeight(130); // 23 — the RAW length counts, even for rows later dropped
  assert.deepEqual(delays, [paceDelayMs(HL_BASE_WEIGHT, gap), paceDelayMs(w, gap)]);
  assert.equal(res.weightSpent, HL_BASE_WEIGHT + w);
});

test("runBackfill: a 429 on one tier is an isolated error; the other tiers still run", async () => {
  const t0 = Date.UTC(2026, 9, 1);
  const res = await runBackfill({
    pool: fakePool([]), env: { ...ENV, m1Days: 1, h1Days: 1, d1FromMs: t0 }, now: () => NOW, log: () => undefined,
    markets: () => [{ symbol: "SOL" }],
    fetch: fakeFetch([], (r) => (r.interval === "1m" ? new Response("", { status: 429 }) : r.interval === "1d" ? [hlRow(t0, t0 + D - 1)] : [])),
  });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^SOL 1m: HTTP 429/);
  assert.deepEqual(res.perMarket, { SOL: 1 });
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

test("nextBackfillDelay: interval after a clean run, retry after errors / no markets / a throw", () => {
  const ok = { rows: 0, perMarket: {}, skipped: [], errors: [], markets: 1, weightSpent: 0 };
  assert.equal(nextBackfillDelay(ok, ENV), ENV.intervalMs);
  assert.equal(nextBackfillDelay({ ...ok, errors: ["SOL 1m: HTTP 429"] }, ENV), RETRY);
  assert.equal(nextBackfillDelay({ ...ok, markets: 0 }, ENV), RETRY);
  assert.equal(nextBackfillDelay(null, ENV), RETRY);
});

test("startBackfill: runs once immediately, then on the interval; snapshot tracks runs and names the source; stop() clears the timer", async () => {
  const t = fakeTimers();
  const b = startBackfill({
    pool: fakePool([]), logError: () => undefined, env: ENV, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }], fetch: fakeFetch([], () => []),
  }, t.timers);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.snapshot(), { enabled: true, lastRunAt: NOW, lastOkAt: NOW, lastError: null, rows: 0, source: "hyperliquid" });
  assert.deepEqual(t.pending.map((p) => p.delay), [ENV.intervalMs]); // clean run → full interval
  b.stop();
  assert.equal(t.cleared(), 1);
});

test("startBackfill: a run with an error retries after BACKFILL_RETRY_MS, then back to the interval once clean", async () => {
  const t = fakeTimers();
  const status = { code: 429 };
  const b = startBackfill({
    pool: fakePool([]), logError: () => undefined, env: ENV, now: () => NOW, log: () => undefined, markets: () => [{ symbol: "SOL" }],
    fetch: fakeFetch([], () => (status.code !== 200 ? new Response("", { status: status.code }) : [])),
  }, t.timers);
  await new Promise((r) => setImmediate(r));
  assert.match(b.snapshot().lastError ?? "", /429/);
  assert.deepEqual(t.pending.map((p) => p.delay), [RETRY]);
  status.code = 200;
  await t.fire();
  assert.equal(b.snapshot().lastError, null);
  assert.deepEqual(t.pending.map((p) => p.delay), [ENV.intervalMs]);
  b.stop();
});

test("startBackfill: a run that saw no markets (registry not read yet) retries after BACKFILL_RETRY_MS", async () => {
  const t = fakeTimers();
  let list: { symbol: string }[] = [];
  const b = startBackfill({
    pool: fakePool([]), logError: () => undefined, env: ENV, now: () => NOW, log: () => undefined, markets: () => list, fetch: fakeFetch([], () => []),
  }, t.timers);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.snapshot().lastError, null);
  assert.deepEqual(t.pending.map((p) => p.delay), [RETRY]);
  list = [{ symbol: "SOL" }];
  await t.fire();
  assert.deepEqual(t.pending.map((p) => p.delay), [ENV.intervalMs]);
  b.stop();
});

test("startBackfill: disabled → no fetch, no timer, snapshot enabled=false", async () => {
  const t = fakeTimers();
  let fetched = 0;
  const b = startBackfill({
    pool: fakePool([]), logError: () => undefined, log: () => undefined, env: { ...ENV, enabled: false }, markets: () => [{ symbol: "SOL" }],
    fetch: (async () => { fetched++; return new Response(""); }) as typeof fetch,
  }, t.timers);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetched, 0);
  assert.equal(t.pending.length, 0);
  assert.equal(b.snapshot().enabled, false);
  assert.equal(b.snapshot().source, "hyperliquid");
  b.stop();
});
